import * as path from "node:path";
import * as vscode from "vscode";
import { ArduinoClient } from "./arduinoClient";
import { BoardManager } from "./boardManager";
import { StatusBarActions } from "./statusBarActions";
import { Compiler } from "./compile";
import { ArduinoCliNotFoundError, DaemonManager } from "./daemon";
import { DebugManager } from "./debug";
import { IntelliSenseManager } from "./intellisense";
import { Indexes } from "./indexes";
import { openLibraryExample } from "./libraryExample";
import { LibraryManager } from "./libraryManager";
import { LibraryTreeProvider, type LibNode } from "./libraryView";
import { checkForUpdates, cleanDownloadCache } from "./maintenance";
import { PlatformManager } from "./platformManager";
import { PlatformTreeProvider, type PlatNode } from "./platformView";
import {
  addBrowsedLibraryToProfile,
  addInstalledLibraryToProfile,
  addLibraryToProfile,
  createProfile,
  listProfileLibraries,
  offerAddToProfile,
  removeLibraryFromProfile,
  removeProfileLibrary,
  setDefaultProfile,
} from "./profileManager";
import { installAiAssistants } from "./skill/installSkill";
import { SerialMonitor, pickSerialLineEnding } from "./serialMonitor";
import { syncToDaemon, watchSettings } from "./settingsSync";
import { archiveSketch, newSketch, resolveSketch } from "./sketch";
import { Uploader } from "./upload";
import {
  ProfileLibraryTreeProvider,
  type ProfileContext,
  type ProfileLibNode,
} from "./profileLibraryView";

let context: vscode.ExtensionContext;
let daemon: DaemonManager | undefined;
let client: ArduinoClient | undefined;
/**
 * In-flight daemon-start + client connect + instance Init, shared by all
 * concurrent `ensureReady` callers. Without it, several views resolving at once
 * (the daemon takes seconds to become reachable) each build their own client and
 * race to overwrite the `client` global — leaving managers wired to a client
 * whose instance was never initialized ("instance not initialized"). Cleared on
 * settle so a failed start can be retried and a daemon restart re-initializes.
 */
let clientInitInFlight: Promise<ArduinoClient> | undefined;
let boards: BoardManager | undefined;
let statusBarActions: StatusBarActions | undefined;
let compiler: Compiler | undefined;
let uploader: Uploader | undefined;
let monitor: SerialMonitor | undefined;
let indexes: Indexes | undefined;
let platforms: PlatformManager | undefined;
let libraries: LibraryManager | undefined;
let debugManager: DebugManager | undefined;
let intellisense: IntelliSenseManager | undefined;
let libraryView: LibraryTreeProvider | undefined;
let platformView: PlatformTreeProvider | undefined;
let profileLibraryView: ProfileLibraryTreeProvider | undefined;
let profileLibTreeView: vscode.TreeView<ProfileLibNode> | undefined;
/** Active sketch's default-profile context (cached); undefined outside profile mode. */
let activeProfile: ProfileContext | undefined;
/**
 * Folder of the active editor at the last profile-context resolve. Used to skip
 * the (glob + LoadSketch) re-resolve when an editor switch stays within the same
 * sketch folder or moves to a non-file surface. `null` = never resolved yet.
 */
let lastProfileSketchDir: string | undefined | null = null;
let output: vscode.OutputChannel;
/** One-time daemon-dependent startup (settings sync + update check), run on first ready. */
let firstReadyHooksRun = false;

export async function activate(ctx: vscode.ExtensionContext) {
  context = ctx;
  output = vscode.window.createOutputChannel("Arduino CLI");
  ctx.subscriptions.push(output);

  daemon = new DaemonManager(output);

  maybeAnnounceVersion(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("arduinoCli.showVersion", showVersion),
    vscode.commands.registerCommand("arduinoCli.restartDaemon", restartDaemon),
    vscode.commands.registerCommand("arduinoCli.selectPath", selectCliPath),
    vscode.commands.registerCommand("arduinoCli.selectBoard", () =>
      withReady((d) => d.boards.selectBoard()),
    ),
    vscode.commands.registerCommand("arduinoCli.compile", (arg) =>
      withReady((d) => d.compiler.run({ target: targetUri(arg) })),
    ),
    vscode.commands.registerCommand("arduinoCli.upload", (arg) =>
      withReady(async (d) => {
        // Arduino-style: compile first, upload only if it succeeds. The monitor
        // holds the port, so release it for the duration of the upload.
        const target = targetUri(arg);
        if (await d.compiler.run({ target })) {
          await d.monitor.runWithMonitorSuspended(() => d.uploader.run(target));
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.openMonitor", (arg) =>
      withReady((d) => d.monitor.openOrFocus(targetUri(arg))),
    ),
    vscode.commands.registerCommand("arduinoCli.updateIndex", () =>
      withReady((d) => d.indexes.updatePackageIndex()),
    ),
    vscode.commands.registerCommand("arduinoCli.updateLibrariesIndex", () =>
      withReady((d) => d.indexes.updateLibrariesIndex()),
    ),
    vscode.commands.registerCommand("arduinoCli.installPlatform", () =>
      withReady(async (d) => {
        await d.platforms.installInteractive();
        await afterPlatformChange(d);
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.uninstallPlatform", () =>
      withReady(async (d) => {
        await d.platforms.uninstallInteractive();
        await afterPlatformChange(d);
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.upgradePlatform", () =>
      withReady(async (d) => {
        await d.platforms.upgradeInteractive();
        await afterPlatformChange(d);
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.downloadPlatform", () =>
      withReady((d) => d.platforms.downloadInteractive()),
    ),
    vscode.commands.registerCommand("arduinoCli.boardDetails", () =>
      withReady((d) => d.boards.showBoardDetails()),
    ),
    vscode.commands.registerCommand("arduinoCli.uploadUsingProgrammer", (arg) =>
      withReady(async (d) => {
        const target = targetUri(arg);
        if (await d.compiler.run({ target })) {
          await d.monitor.runWithMonitorSuspended(() =>
            d.uploader.runWithProgrammer(target),
          );
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.burnBootloader", () =>
      withReady((d) =>
        d.monitor.runWithMonitorSuspended(() => d.uploader.burnBootloader()),
      ),
    ),
    vscode.commands.registerCommand("arduinoCli.newSketch", () =>
      withReady((d) => newSketch(d.client)),
    ),
    vscode.commands.registerCommand("arduinoCli.archiveSketch", () =>
      withReady((d) => archiveSketch(d.client)),
    ),
    vscode.commands.registerCommand("arduinoCli.checkForUpdates", () =>
      withReady((d) => checkForUpdates(d.client, output)),
    ),
    vscode.commands.registerCommand("arduinoCli.cleanDownloadCache", () =>
      withReady((d) => cleanDownloadCache(d.client, output)),
    ),
    vscode.commands.registerCommand("arduinoCli.createProfile", () =>
      withReady((d) => createProfile(d.client, d.boards, d.platforms)),
    ),
    vscode.commands.registerCommand("arduinoCli.setDefaultProfile", () =>
      withReady((d) => setDefaultProfile(d.client)),
    ),
    vscode.commands.registerCommand("arduinoCli.addLibraryToProfile", () =>
      withReady((d) => addLibraryToProfile(d.client)),
    ),
    vscode.commands.registerCommand("arduinoCli.removeLibraryFromProfile", () =>
      withReady((d) => removeLibraryFromProfile(d.client)),
    ),
    vscode.commands.registerCommand("arduinoCli.listProfileLibraries", () =>
      withReady((d) => listProfileLibraries(d.client, output)),
    ),
    vscode.commands.registerCommand("arduinoCli.debug", (arg) =>
      withReady(async (d) => {
        // Debug needs a fresh, debug-optimized .elf.
        const target = targetUri(arg);
        if (await d.compiler.run({ optimizeForDebug: true, target })) {
          await d.debug.startDebug(target);
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.debugShowConfig", () =>
      withReady((d) => d.debug.showDebugConfig()),
    ),
    vscode.commands.registerCommand("arduinoCli.configureIntelliSense", () =>
      withReady((d) => d.intellisense.configure()),
    ),
    vscode.commands.registerCommand("arduinoCli.openPlotter", () =>
      withReady((d) => {
        d.monitor.openPlotter(context.extensionUri);
        return Promise.resolve();
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.saveSerialLog", () =>
      withReady((d) => d.monitor.saveLog()),
    ),
    // Daemon-independent: changes a setting an open monitor reads live. No
    // withReady, so it never spawns the daemon just to pick a line ending.
    vscode.commands.registerCommand("arduinoCli.setMonitorLineEnding", () =>
      pickSerialLineEnding(),
    ),
    vscode.commands.registerCommand("arduinoCli.addLibrary", () =>
      withReady(async (d) => {
        const installed = await d.libraries.addLibrary();
        if (installed) {
          await afterLibraryChange(d);
          await offerAddToProfile(d.client, activeProfile, installed);
          profileLibraryView?.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.upgradeLibraries", () =>
      withReady(async (d) => {
        if (await d.libraries.upgradeAll()) {
          await afterLibraryChange(d);
        }
      }),
    ),
  );

  // Libraries tree view — registered once; resolves the live LibraryManager
  // lazily so it survives daemon restarts without re-registering the view.
  libraryView = new LibraryTreeProvider(() =>
    ensureReady().then((d) => d.libraries),
  );
  // Second tree: the active sketch's default-profile libraries. Hidden outside
  // profile mode (gated by the `arduinoCli.profileMode` context key). The client
  // and active-profile context are resolved lazily; the view only renders when
  // profile mode is on, by which point the daemon is ready.
  profileLibraryView = new ProfileLibraryTreeProvider(
    () => ensureReady().then((d) => d.client),
    () => activeProfile,
  );
  profileLibTreeView = vscode.window.createTreeView("arduinoCli.profileLibraries", {
    treeDataProvider: profileLibraryView,
  });
  ctx.subscriptions.push(
    profileLibTreeView,
    // Follow the active editor: re-resolve which sketch/profile is in scope.
    vscode.window.onDidChangeActiveTextEditor(() => void refreshProfileContext()),
    vscode.commands.registerCommand("arduinoCli.refreshProfileLibraries", () =>
      profileLibraryView?.refresh(),
    ),
    // View-title "+": browse the library index and add the pick to the active
    // profile — no profile-name / library-name prompts (cf. addLibraryToProfile).
    vscode.commands.registerCommand("arduinoCli.profileLib.add", () =>
      withReady(async (d) => {
        await addBrowsedLibraryToProfile(d.client, d.libraries, activeProfile);
        profileLibraryView?.refresh();
      }),
    ),
    vscode.commands.registerCommand(
      "arduinoCli.lib.addToProfile",
      (node: LibNode | undefined) =>
        withReady(async (d) => {
          await addInstalledLibraryToProfile(d.client, activeProfile, node);
          profileLibraryView?.refresh();
        }),
    ),
    vscode.commands.registerCommand(
      "arduinoCli.profileLib.remove",
      (node: ProfileLibNode | undefined) =>
        withReady(async (d) => {
          await removeProfileLibrary(d.client, activeProfile, node);
          profileLibraryView?.refresh();
        }),
    ),
  );

  ctx.subscriptions.push(
    vscode.window.createTreeView("arduinoCli.libraries", {
      treeDataProvider: libraryView,
    }),
    vscode.commands.registerCommand("arduinoCli.refreshLibraries", () =>
      libraryView?.refresh(),
    ),
    vscode.commands.registerCommand("arduinoCli.installLibraryZip", () =>
      withReady(async (d) => {
        if (await d.libraries.installFromZip()) {
          await afterLibraryChange(d);
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.installLibraryGit", () =>
      withReady(async (d) => {
        if (await d.libraries.installFromGit()) {
          await afterLibraryChange(d);
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.downloadLibrary", () =>
      withReady((d) => d.libraries.downloadArchive()),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.uninstall", (node: LibNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.uninstallByName(node.name)) {
            await afterLibraryChange(d);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.changeVersion", (node: LibNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.changeVersion(node.name, node.version)) {
            await afterLibraryChange(d);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.upgrade", (node: LibNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.upgradeByName(node.name)) {
            await afterLibraryChange(d);
          }
        }
      }),
    ),
    // Read-only actions (no daemon work, no afterLibraryChange).
    vscode.commands.registerCommand(
      "arduinoCli.lib.openWebsite",
      (node: LibNode | undefined) => {
        if (node?.kind === "lib" && node.website) {
          void vscode.env.openExternal(vscode.Uri.parse(node.website));
        }
      },
    ),
    vscode.commands.registerCommand(
      "arduinoCli.lib.openExample",
      async (node: LibNode | undefined) => {
        if (node?.kind !== "lib") {
          return;
        }
        const folder = await openLibraryExample(node.name, node.examples);
        if (!folder) {
          return;
        }
        // Generate c_cpp_properties.json for the freshly-opened example, else
        // cpptools reports the library's headers as missing — opening a sketch
        // is not itself an IntelliSense trigger. Use scheduleConfigure (not
        // configure) to match every other auto-trigger: silent, and gated by the
        // `intellisense.autoConfigure` setting. It resolves the now-active example
        // .ino and writes the config into its own root.
        await withReady(async (d) => d.intellisense.scheduleConfigure());
      },
    ),
    // Group-by-category toggle: the two commands just write the setting; the
    // config listener below repaints the tree and flips the button. Single
    // source of truth = the setting.
    vscode.commands.registerCommand("arduinoCli.lib.groupByCategory", () =>
      setLibrariesGrouped(true),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.ungroup", () =>
      setLibrariesGrouped(false),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("arduinoCli.libraries.groupByCategory")) {
        syncLibrariesGroupedContext();
        void libraryView?.refresh();
      }
    }),
  );
  syncLibrariesGroupedContext(); // establish the button state at startup

  // Platforms (cores) tree view — mirror of the Libraries view, on the global
  // instance. Resolves the live PlatformManager lazily so it survives daemon
  // restarts without re-registering the view.
  platformView = new PlatformTreeProvider(() =>
    ensureReady().then((d) => d.platforms),
  );
  ctx.subscriptions.push(
    vscode.window.createTreeView("arduinoCli.platforms", {
      treeDataProvider: platformView,
    }),
    vscode.commands.registerCommand("arduinoCli.refreshPlatforms", () =>
      platformView?.refresh(),
    ),
    vscode.commands.registerCommand("arduinoCli.upgradePlatforms", () =>
      withReady(async (d) => {
        if (await d.platforms.upgradeAll()) {
          await afterPlatformChange(d);
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.platform.uninstall", (node: PlatNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "platform") {
          const [pkg, arch] = node.id.split(":");
          if (await d.platforms.uninstallById(pkg, arch)) {
            await afterPlatformChange(d);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.platform.upgrade", (node: PlatNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "platform") {
          const [pkg, arch] = node.id.split(":");
          if (await d.platforms.upgradeById(pkg, arch)) {
            await afterPlatformChange(d);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.platform.changeVersion", (node: PlatNode | undefined) =>
      withReady(async (d) => {
        if (node?.kind === "platform") {
          if (await d.platforms.changeVersion(node.id, node.version)) {
            await afterPlatformChange(d);
          }
        }
      }),
    ),
  );

  // Debug: a stable config provider that lazily resolves the live DebugManager,
  // plus a terminate handler that reopens the monitor only for OUR sessions.
  ctx.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("arduino", {
      provideDebugConfigurations: () => [
        { type: "arduino", request: "launch", name: "Arduino Debug" },
      ],
      resolveDebugConfiguration: async (folder, config) => {
        const d = await ensureReady();
        return d.debug.resolveDebugConfiguration(folder, config);
      },
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.configuration?.__arduino) {
        void monitor?.resumeAfterDebug();
      }
    }),
    // Reconfigure IntelliSense when a sketch file's #include set changes.
    vscode.workspace.onDidSaveTextDocument((doc) => intellisense?.onDidSave(doc)),
  );

  // Profile mode is bound to sketch.yaml's `default_profile` and the profile's
  // resources. Any external rewrite — the blocks editor appending libraries, an
  // Arduino IDE / daemon profile edit, or a `default_profile` change — must drop
  // the cached profile-bound instance so the next compile/IntelliSense re-Inits
  // and re-resolves the profile, then refresh IntelliSense.
  const sketchYamlWatcher =
    vscode.workspace.createFileSystemWatcher("**/sketch.yaml");
  const onSketchYaml = (uri: vscode.Uri): void => {
    client?.invalidateProfileInstance(path.dirname(uri.fsPath));
    intellisense?.scheduleConfigure();
    // A default_profile change flips profile mode; a content change alters the
    // profile-library list. Re-resolve context and repaint the profile tree —
    // forced, since the active folder may be unchanged but its sketch.yaml is not.
    void refreshProfileContext({ force: true });
  };
  context.subscriptions.push(
    sketchYamlWatcher,
    sketchYamlWatcher.onDidChange(onSketchYaml),
    sketchYamlWatcher.onDidCreate(onSketchYaml),
    sketchYamlWatcher.onDidDelete(onSketchYaml),
  );

  // One-click setup of the shared AI-assistant config: one skill under
  // `.claude/skills/` that both Claude Code and Copilot auto-discover; both drive
  // arduino-cli via the shell. No wrapper tools, no per-host duplication to maintain.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("arduinoCli.installArduinoSkill", () =>
      installAiAssistants(ctx),
    ),
  );

  // The daemon is otherwise NOT started here: spawning it requires arduino-cli on
  // PATH and is pointless until the user runs a command. It starts lazily on first
  // use (see ensureReady / withReady), so users without arduino-cli — or who only
  // use another toolchain — pay no cost and get no spawn error at activation.
  //
  // Exception (opt-out via `arduinoCli.eagerDaemonStart`): when the workspace is a
  // real arduino-cli project — it contains a `sketch.yaml` — start the daemon now
  // so the daemon-authoritative `refreshProfileContext` can resolve profile mode
  // at launch. Without this, the Explorer's Profile Libraries view is gated on
  // `arduinoCli.profileMode`, which only resolves once the daemon is up — but the
  // gated-off view can't itself trigger the lazy start, so it would stay hidden
  // until the user visited the Arduino activity-bar container. A `sketch.yaml` is
  // arduino-cli-specific (other toolchains use their own manifest), so this does
  // not start the daemon for non-Arduino or other-toolchain workspaces.
  void maybeEagerStart();
}

/**
 * Opt-out eager daemon start for arduino-cli projects. Gated on the
 * `arduinoCli.eagerDaemonStart` setting and the presence of a `sketch.yaml` in
 * the workspace. Best-effort: a spawn failure (no arduino-cli on PATH) is
 * swallowed so there is still no activation-time error toast — profile mode just
 * stays off, exactly as in the strictly-lazy path.
 */
async function maybeEagerStart(): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("arduinoCli")
    .get<boolean>("eagerDaemonStart", true);
  if (!enabled || vscode.workspace.workspaceFolders === undefined) {
    return;
  }
  const found = await vscode.workspace.findFiles("**/sketch.yaml", undefined, 1);
  if (found.length === 0) {
    return;
  }
  try {
    await ensureReady();
    // The daemon-authoritative pass (firstReadyHooks) already ran inside
    // ensureReady; profile mode is now resolved for the active sketch.
  } catch {
    // No arduino-cli on PATH (ENOENT) or a transient start failure: leave profile
    // mode off and let a later explicit command surface the error via withReady.
  }
}

export async function deactivate() {
  monitor?.dispose();
  boards?.dispose();
  compiler?.dispose();
  intellisense?.dispose();
  await client?.destroy();
  client?.close();
  daemon?.stop();
}

export interface Deps {
  client: ArduinoClient;
  boards: BoardManager;
  compiler: Compiler;
  uploader: Uploader;
  monitor: SerialMonitor;
  indexes: Indexes;
  platforms: PlatformManager;
  libraries: LibraryManager;
  debug: DebugManager;
  intellisense: IntelliSenseManager;
}

/** Lazily starts the daemon, initializes the client, and wires the managers. */
/**
 * Bring up the daemon, connect the gRPC client, and Init its instance — exactly
 * once even under concurrent callers. Returns the ready client (instance set).
 *
 * Serialized via {@link clientInitInFlight}: the first caller runs the bring-up,
 * everyone else awaits the same promise, so the `client` global is only ever
 * assigned the single fully-initialized client. The promise is cleared on settle
 * — on failure so the next command retries cleanly, on success so a later daemon
 * restart (which nulls `client`) re-runs the bring-up.
 */
function ensureClientReady(): Promise<ArduinoClient> {
  if (client?.ready) {
    return Promise.resolve(client);
  }
  if (!clientInitInFlight) {
    clientInitInFlight = (async () => {
      if (!daemon) {
        throw new Error("daemon manager not initialized");
      }
      await daemon.start();
      let c = client;
      if (!c) {
        c = new ArduinoClient(daemon.address, (line) => output.appendLine(line));
        c.connect();
        // Block until the channel can actually reach the daemon. The daemon-ready
        // signal from start() can be a timed guess (its ready line is localized),
        // so without this gate the first call may fire fail-fast against an
        // unbound port and reject with "UNAVAILABLE: No connection established".
        await c.waitForReady();
        // Assign only after connect()/waitForReady so a throw here doesn't strand
        // a half-built client (the next attempt rebuilds from scratch).
        client = c;
      }
      if (!c.ready) {
        // Create+Init the daemon instance. Gated on readiness — NOT on client
        // existence — so a first init that failed (daemon slow to listen,
        // transient gRPC error) is retried on the next command instead of
        // leaving a client whose every call throws "instance not initialized".
        // Drop the client on failure so a later attempt starts clean.
        try {
          await c.initInstance();
        } catch (err) {
          client = undefined;
          throw err;
        }
      }
      return c;
    })().finally(() => {
      clientInitInFlight = undefined;
    });
  }
  return clientInitInFlight;
}

async function ensureReady(): Promise<Deps> {
  // Daemon + client + instance: serialized so concurrent callers never build
  // racing clients (see clientInitInFlight). Below this line `client` is the
  // single ready client, so the manager wiring (no awaits) is race-free.
  const client = await ensureClientReady();
  if (!boards) {
    boards = new BoardManager(client, context, output);
    boards.restartWatch();
  }
  if (!statusBarActions) {
    statusBarActions = new StatusBarActions();
    context.subscriptions.push(statusBarActions);
  }
  if (!platforms) {
    platforms = new PlatformManager(client, output);
  }
  if (!libraries) {
    libraries = new LibraryManager(client, output);
  }
  if (!compiler) {
    compiler = new Compiler(client, boards, platforms, output);
  }
  if (!uploader) {
    uploader = new Uploader(client, boards, platforms, output);
  }
  if (!monitor) {
    monitor = new SerialMonitor(client, boards, output);
  }
  if (!indexes) {
    indexes = new Indexes(client, output);
  }
  if (!intellisense) {
    intellisense = new IntelliSenseManager(client, boards, context, output);
    // A successful compile installs the platform and builds the profile
    // instance — the point at which a deferred profile-mode IntelliSense can
    // finally configure. Refresh it then.
    const isense = intellisense;
    compiler.onCompiled(() => isense.scheduleConfigure());
  }
  if (!debugManager) {
    debugManager = new DebugManager(client, boards, monitor, output);
    const dbg = debugManager;
    const isense = intellisense;
    boards.onSelectionChanged((fqbn, port) => {
      void dbg.updateDebugSupported(fqbn, port?.address ? port : undefined);
      isense.scheduleConfigure();
    });
  }
  // First successful start only: sync settings → daemon, watch for changes, and
  // check for a newer arduino-cli. Deferred from activation so it runs once the
  // daemon is actually up (on first command), not eagerly.
  if (!firstReadyHooksRun) {
    firstReadyHooksRun = true;
    output.appendLine("[extension] arduino-cli daemon ready");
    void syncToDaemon(client, output).catch(() => {});
    context.subscriptions.push(watchSettings(client, output));
    void checkForUpdates(client, output, { quiet: true }).catch(() => {});
    // Now that the daemon is up, resolve profile mode for the active sketch so
    // the profile-libraries view can appear — forced, to establish the initial
    // context regardless of the change-detection short-circuit.
    void refreshProfileContext({ force: true });
  }
  return {
    client,
    boards,
    compiler,
    uploader,
    monitor,
    indexes,
    platforms,
    libraries,
    debug: debugManager,
    intellisense,
  };
}

/** Persist the group-by-category preference (the tree reads it back). */
function setLibrariesGrouped(value: boolean): Thenable<void> {
  return vscode.workspace
    .getConfiguration("arduinoCli")
    .update("libraries.groupByCategory", value, vscode.ConfigurationTarget.Global);
}

/** Mirror the setting into a context key so the right view/title button shows. */
function syncLibrariesGroupedContext(): void {
  const grouped = vscode.workspace
    .getConfiguration("arduinoCli")
    .get<boolean>("libraries.groupByCategory", false);
  void vscode.commands.executeCommand(
    "setContext",
    "arduinoCli.librariesGrouped",
    grouped,
  );
}

/** Refresh the library view and reconfigure IntelliSense (installed set changed). */
async function afterLibraryChange(d: Deps): Promise<void> {
  await libraryView?.refresh();
  d.intellisense.scheduleConfigure();
}

async function afterPlatformChange(d: Deps): Promise<void> {
  await platformView?.refresh();
  d.intellisense.scheduleConfigure();
}

/**
 * Re-resolve the active sketch's default profile, publish the `profileMode`
 * context key (gates the profile-libraries view + the inline actions), and
 * repaint the profile tree. Respects lazy daemon start: if the daemon isn't
 * ready yet we report "no profile" rather than spawning it on an editor change.
 */
async function refreshProfileContext(
  opts: { force?: boolean } = {},
): Promise<void> {
  // Cheap change-detection before the expensive resolve: the active editor's
  // folder. The profile context only changes when the active *sketch* changes
  // (a different folder) or sketch.yaml changes (force). Switching between files
  // in the same sketch, or focusing a non-file surface (Output, terminal,
  // settings → no active text editor), leaves it unchanged — skip the glob +
  // LoadSketch entirely in that case.
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeDir =
    activeUri?.scheme === "file" ? path.dirname(activeUri.fsPath) : undefined;
  if (!opts.force && (activeDir === undefined || activeDir === lastProfileSketchDir)) {
    return;
  }
  lastProfileSketchDir = activeDir;

  let ctx: ProfileContext | undefined;
  if (client?.ready) {
    try {
      const sketch = await resolveSketch(client, { silent: true, output });
      const profileName = sketch?.default_profile?.name;
      if (sketch && profileName) {
        ctx = { sketchPath: sketch.location_path, profileName };
      }
    } catch {
      ctx = undefined;
    }
  }
  activeProfile = ctx;
  await vscode.commands.executeCommand(
    "setContext",
    "arduinoCli.profileMode",
    Boolean(ctx),
  );
  if (profileLibTreeView) {
    profileLibTreeView.description = ctx?.profileName;
  }
  profileLibraryView?.refresh();
}

/** Run an action after ensuring the daemon/managers are ready, with error reporting. */
async function withReady(action: (deps: Deps) => Promise<unknown>): Promise<void> {
  try {
    const deps = await ensureReady();
    await action(deps);
  } catch (err) {
    await reportReadyError(err);
  }
}

/** Where to obtain arduino-cli when it is not installed. */
const ARDUINO_CLI_DOWNLOAD_URL =
  "https://docs.arduino.cc/arduino-cli/installation/#download";

/**
 * Surface a daemon/startup failure. When the cause is a missing arduino-cli
 * executable, offer concrete recovery — pick the binary (file picker) or open
 * the download page — instead of a dead-end error toast.
 */
async function reportReadyError(err: unknown): Promise<void> {
  if (err instanceof ArduinoCliNotFoundError) {
    const select = vscode.l10n.t("Select path…");
    const download = vscode.l10n.t("Download arduino-cli");
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t("Arduino CLI: {0}", err.message),
      select,
      download,
    );
    if (choice === select) {
      await selectCliPath();
    } else if (choice === download) {
      await vscode.env.openExternal(vscode.Uri.parse(ARDUINO_CLI_DOWNLOAD_URL));
    }
    return;
  }
  vscode.window.showErrorMessage(vscode.l10n.t("Arduino CLI: {0}", asMessage(err)));
}

/**
 * Open a file picker for the arduino-cli executable and persist the chosen path
 * to the `arduinoCli.path` user setting, then restart the daemon so the new
 * path takes effect (the settings watcher does not cover `path`).
 */
async function selectCliPath(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: vscode.l10n.t("Select"),
    title: vscode.l10n.t("Select the arduino-cli executable"),
  });
  const file = picked?.[0];
  if (!file) {
    return;
  }
  await vscode.workspace
    .getConfiguration("arduinoCli")
    .update("path", file.fsPath, vscode.ConfigurationTarget.Global);
  await restartDaemon();
}

async function showVersion() {
  await withReady(async (d) => {
    const version = await d.client.version();
    vscode.window.showInformationMessage(
      vscode.l10n.t("arduino-cli daemon v{0}", version),
    );
  });
}

async function restartDaemon() {
  try {
    // The instance (and anything bound to it — the board watch) is invalidated
    // by a restart, so tear the managers down and let ensureReady recreate them.
    boards?.dispose();
    boards = undefined;
    compiler?.dispose();
    compiler = undefined;
    uploader = undefined;
    monitor?.dispose();
    monitor = undefined;
    indexes = undefined;
    platforms = undefined;
    libraries = undefined;
    debugManager = undefined;
    intellisense?.dispose();
    intellisense = undefined;
    await client?.destroy();
    client?.close();
    client = undefined;
    await daemon?.restart();
    await ensureReady();
    vscode.window.showInformationMessage(
      vscode.l10n.t("Arduino CLI: daemon restarted"),
    );
  } catch (err) {
    await reportReadyError(err);
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Announce the packaged version once per version by comparing it against the one
 * stored in globalState: on first install open the Get Started walkthrough, and
 * after an update surface a "What's New" notification linking to the changelog.
 * Cheap and daemon-independent, so it runs at activation without waiting on (or
 * spawning) the daemon.
 */
function maybeAnnounceVersion(ctx: vscode.ExtensionContext): void {
  const currentVersion = ctx.extension.packageJSON.version as string;
  const lastVersion = ctx.globalState.get<string>("walkthroughVersion");
  if (lastVersion === currentVersion) {
    return;
  }
  void ctx.globalState.update("walkthroughVersion", currentVersion);

  if (lastVersion === undefined) {
    // Fresh install → Get Started walkthrough.
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${ctx.extension.id}#arduinoCli.welcome`,
      false,
    );
    return;
  }

  // Update → changelog notification.
  void showUpdateNotification(ctx, currentVersion);
}

async function showUpdateNotification(
  ctx: vscode.ExtensionContext,
  version: string,
): Promise<void> {
  const whatsNew = vscode.l10n.t("What's New");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t("Arduino CLI IDE updated to v{0}", version),
    whatsNew,
  );
  if (choice === whatsNew) {
    const uri = vscode.Uri.joinPath(ctx.extensionUri, "CHANGELOG.md");
    void vscode.commands.executeCommand("markdown.showPreview", uri);
  }
}

/**
 * The first argument VS Code passes to a command invoked from an `editor/title`
 * button is the active document's URI — including over a custom editor (the
 * resource is the underlying file). Narrow it so handlers can target that exact
 * sketch; Command Palette / keybinding invocations pass `undefined`.
 */
function targetUri(arg: unknown): vscode.Uri | undefined {
  return arg instanceof vscode.Uri ? arg : undefined;
}
