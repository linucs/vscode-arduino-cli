import * as vscode from "vscode";
import { ArduinoClient } from "./arduinoClient";
import { BoardManager } from "./boardManager";
import { Compiler } from "./compile";
import { DaemonManager } from "./daemon";
import { DebugManager } from "./debug";
import { Indexes } from "./indexes";
import { LibraryManager } from "./libraryManager";
import { LibraryTreeProvider } from "./libraryView";
import { checkForUpdates, cleanDownloadCache } from "./maintenance";
import { PlatformManager } from "./platformManager";
import {
  addLibraryToProfile,
  createProfile,
  listProfileLibraries,
  removeLibraryFromProfile,
  setDefaultProfile,
} from "./profileManager";
import { SerialMonitor } from "./serialMonitor";
import { syncToDaemon, watchSettings } from "./settingsSync";
import { archiveSketch, newSketch } from "./sketch";
import { Uploader } from "./upload";

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
let libraryView: LibraryTreeProvider | undefined;
let output: vscode.OutputChannel;

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
    vscode.commands.registerCommand("arduinoCli.compile", () =>
      withReady((d) => d.compiler.run()),
    ),
    vscode.commands.registerCommand("arduinoCli.upload", () =>
      withReady(async (d) => {
        // Arduino-style: compile first, upload only if it succeeds. The monitor
        // holds the port, so release it for the duration of the upload.
        if (await d.compiler.run()) {
          await d.monitor.runWithMonitorSuspended(() => d.uploader.run());
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.openMonitor", () =>
      withReady((d) => d.monitor.openOrFocus()),
    ),
    vscode.commands.registerCommand("arduinoCli.updateIndex", () =>
      withReady((d) => d.indexes.updatePackageIndex()),
    ),
    vscode.commands.registerCommand("arduinoCli.updateLibrariesIndex", () =>
      withReady((d) => d.indexes.updateLibrariesIndex()),
    ),
    vscode.commands.registerCommand("arduinoCli.installPlatform", () =>
      withReady((d) => d.platforms.installInteractive()),
    ),
    vscode.commands.registerCommand("arduinoCli.uninstallPlatform", () =>
      withReady((d) => d.platforms.uninstallInteractive()),
    ),
    vscode.commands.registerCommand("arduinoCli.upgradePlatform", () =>
      withReady((d) => d.platforms.upgradeInteractive()),
    ),
    vscode.commands.registerCommand("arduinoCli.downloadPlatform", () =>
      withReady((d) => d.platforms.downloadInteractive()),
    ),
    vscode.commands.registerCommand("arduinoCli.boardDetails", () =>
      withReady((d) => d.boards.showBoardDetails()),
    ),
    vscode.commands.registerCommand("arduinoCli.uploadUsingProgrammer", () =>
      withReady(async (d) => {
        if (await d.compiler.run()) {
          await d.monitor.runWithMonitorSuspended(() =>
            d.uploader.runWithProgrammer(),
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
      withReady((d) => createProfile(d.client, d.boards)),
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
    vscode.commands.registerCommand("arduinoCli.debug", () =>
      withReady(async (d) => {
        // Debug needs a fresh, debug-optimized .elf.
        if (await d.compiler.run({ optimizeForDebug: true })) {
          await d.debug.startDebug();
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.debugShowConfig", () =>
      withReady((d) => d.debug.showDebugConfig()),
    ),
    vscode.commands.registerCommand("arduinoCli.addLibrary", () =>
      withReady(async (d) => {
        if (await d.libraries.addLibrary()) {
          await libraryView?.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.upgradeLibraries", () =>
      withReady(async (d) => {
        if (await d.libraries.upgradeAll()) {
          await libraryView?.refresh();
        }
      }),
    ),
  );

  // Libraries tree view — registered once; resolves the live LibraryManager
  // lazily so it survives daemon restarts without re-registering the view.
  libraryView = new LibraryTreeProvider(() =>
    ensureReady().then((d) => d.libraries),
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
          await libraryView?.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.installLibraryGit", () =>
      withReady(async (d) => {
        if (await d.libraries.installFromGit()) {
          await libraryView?.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.downloadLibrary", () =>
      withReady((d) => d.libraries.downloadArchive()),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.uninstall", (node) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.uninstallByName(node.name)) {
            await libraryView?.refresh();
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.changeVersion", (node) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.changeVersion(node.name, node.version)) {
            await libraryView?.refresh();
          }
        }
      }),
    ),
    vscode.commands.registerCommand("arduinoCli.lib.upgrade", (node) =>
      withReady(async (d) => {
        if (node?.kind === "lib") {
          if (await d.libraries.upgradeByName(node.name)) {
            await libraryView?.refresh();
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
  );

  try {
    await ensureReady();
    output.appendLine("[extension] arduino-cli daemon ready");
    // Sync VS Code settings → daemon, then watch for changes.
    void syncToDaemon(client!, output).catch(() => {});
    ctx.subscriptions.push(watchSettings(client!, output));
    // Fire-and-forget: notify if a newer arduino-cli is available.
    void checkForUpdates(client!, output, { quiet: true }).catch(() => {});
  } catch (err) {
    output.appendLine(`[extension] startup failed: ${asMessage(err)}`);
    vscode.window.showErrorMessage(
      vscode.l10n.t("Arduino CLI: could not start daemon — {0}", asMessage(err)),
    );
  }
}

export async function deactivate() {
  monitor?.dispose();
  boards?.dispose();
  compiler?.dispose();
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
}

/** Lazily starts the daemon, initializes the client, and wires the managers. */
async function ensureReady(): Promise<Deps> {
  if (!daemon) {
    throw new Error("daemon manager not initialized");
  }
  await daemon.start();
  if (!client) {
    client = new ArduinoClient(daemon.address);
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
    uploader = new Uploader(client, boards, output);
  }
  if (!monitor) {
    monitor = new SerialMonitor(client, boards, output);
  }
  if (!indexes) {
    indexes = new Indexes(client, output);
  }
  if (!debugManager) {
    debugManager = new DebugManager(client, boards, monitor, output);
    // Gate debug affordances on the selected board (fires immediately too).
    boards.onSelectionChanged((fqbn, port) => {
      void debugManager!.updateDebugSupported(
        fqbn,
        port?.address ? port : undefined,
      );
    });
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
  };
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
