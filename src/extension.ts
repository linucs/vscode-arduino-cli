import * as vscode from "vscode";
import { ArduinoClient } from "./arduinoClient";
import { DaemonManager } from "./daemon";

let daemon: DaemonManager | undefined;
let client: ArduinoClient | undefined;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Arduino CLI");
  context.subscriptions.push(output);

  daemon = new DaemonManager(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("arduinoCli.showVersion", showVersion),
    vscode.commands.registerCommand("arduinoCli.restartDaemon", restartDaemon),
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
  await client?.destroy();
  client?.close();
  daemon?.stop();
}

/** Lazily starts the daemon and initializes a client instance. */
async function ensureReady(): Promise<ArduinoClient> {
  if (!daemon) {
    throw new Error("daemon manager not initialized");
  }
  await daemon.start();
  if (!client) {
    client = new ArduinoClient(daemon.address);
    client.connect();
    await client.initInstance();
  }
  return client;
}

async function showVersion() {
  try {
    const c = await ensureReady();
    const version = await c.version();
    vscode.window.showInformationMessage(
      vscode.l10n.t("arduino-cli daemon v{0}", version),
    );
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t("Arduino CLI: {0}", asMessage(err)));
  }
}

async function restartDaemon() {
  try {
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
