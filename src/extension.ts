import * as vscode from "vscode";
import { ArduinoClient } from "./arduinoClient";
import { BoardManager } from "./boardManager";
import { Compiler } from "./compile";
import { DaemonManager } from "./daemon";
import { Indexes } from "./indexes";
import { LibraryManager } from "./libraryManager";
import { LibraryTreeProvider } from "./libraryView";
import { PlatformManager } from "./platformManager";
import { SerialMonitor } from "./serialMonitor";
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
    vscode.commands.registerCommand("arduinoCli.boardDetails", () =>
      withReady((d) => d.boards.showBoardDetails()),
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

  try {
    await ensureReady();
    output.appendLine("[extension] arduino-cli daemon ready");
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
  return {
    client,
    boards,
    compiler,
    uploader,
    monitor,
    indexes,
    platforms,
    libraries,
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
