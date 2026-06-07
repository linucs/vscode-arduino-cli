import * as path from "node:path";
import * as vscode from "vscode";
import { ArduinoClient } from "./arduinoClient";
import { BoardManager } from "./boardManager";
import { Compiler } from "./compile";
import { DaemonManager } from "./daemon";
import { DebugManager } from "./debug";
import { IntelliSenseManager } from "./intellisense";
import { Indexes } from "./indexes";
import { LibraryManager } from "./libraryManager";
import { LibraryTreeProvider, type LibNode } from "./libraryView";
import { checkForUpdates, cleanDownloadCache } from "./maintenance";
import { PlatformManager } from "./platformManager";
import { PlatformTreeProvider, type PlatNode } from "./platformView";
import {
  addInstalledLibraryToProfile,
  addLibraryToProfile,
  createProfile,
  listProfileLibraries,
  offerAddToProfile,
  removeLibraryFromProfile,
  removeProfileLibrary,
  setDefaultProfile,
} from "./profileManager";
import { SerialMonitor } from "./serialMonitor";
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
let boards: BoardManager | undefined;
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

  ctx.subscriptions.push(
    vscode.commands.registerCommand("arduinoCli.showVersion", showVersion),
    vscode.commands.registerCommand("arduinoCli.restartDaemon", restartDaemon),
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
  );

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

  // The daemon is NOT started here: spawning it requires arduino-cli on PATH and
  // is pointless until the user runs a command. It starts lazily on first use
  // (see ensureReady / withReady), so users without arduino-cli — or who only use
  // another toolchain — pay no cost and get no spawn error at activation.
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

interface Deps {
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
async function ensureReady(): Promise<Deps> {
  if (!daemon) {
    throw new Error("daemon manager not initialized");
  }
  await daemon.start();
  if (!client) {
    client = new ArduinoClient(daemon.address, (line) => output.appendLine(line));
    client.connect();
    await client.initInstance();
  }
  if (!boards) {
    boards = new BoardManager(client, context, output);
    boards.restartWatch();
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
    vscode.window.showErrorMessage(vscode.l10n.t("Arduino CLI: {0}", asMessage(err)));
  }
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
    vscode.window.showErrorMessage(vscode.l10n.t("Arduino CLI: {0}", asMessage(err)));
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
