import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";

interface SyncMapping {
  vscodeKey: string;
  daemonKey: string;
  encode: (value: unknown) => string;
}

const MAPPINGS: SyncMapping[] = [
  {
    vscodeKey: "arduinoCli.boardManagerUrls",
    daemonKey: "board_manager.additional_urls",
    encode: (v) => JSON.stringify(v),
  },
  {
    vscodeKey: "arduinoCli.alwaysExportBinaries",
    daemonKey: "sketch.always_export_binaries",
    encode: (v) => JSON.stringify(v),
  },
  {
    vscodeKey: "arduinoCli.unsafeLibraryInstall",
    daemonKey: "library.enable_unsafe_install",
    encode: (v) => JSON.stringify(v),
  },
  {
    vscodeKey: "arduinoCli.updateNotifications",
    daemonKey: "updater.enable_notification",
    encode: (v) => JSON.stringify(v),
  },
];

/** Push all mapped VS Code settings to the arduino-cli daemon. */
export async function syncToDaemon(
  client: ArduinoClient,
  output: vscode.OutputChannel,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  for (const m of MAPPINGS) {
    const value = cfg.get(m.vscodeKey);
    try {
      await client.settingsSetValue(m.daemonKey, m.encode(value));
      output.appendLine(`[settings] synced ${m.daemonKey}`);
    } catch (err) {
      output.appendLine(
        `[settings] failed to sync ${m.daemonKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Returns a disposable that watches for VS Code setting changes and pushes
 * them to the daemon in real time.
 */
export function watchSettings(
  client: ArduinoClient,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    for (const m of MAPPINGS) {
      if (e.affectsConfiguration(m.vscodeKey)) {
        const value = vscode.workspace.getConfiguration().get(m.vscodeKey);
        client
          .settingsSetValue(m.daemonKey, m.encode(value))
          .then(() =>
            output.appendLine(`[settings] updated ${m.daemonKey}`),
          )
          .catch((err) =>
            output.appendLine(
              `[settings] failed to update ${m.daemonKey}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
      }
    }
  });
}
