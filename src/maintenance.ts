import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";

/**
 * Check whether a newer version of arduino-cli is available.
 * In quiet mode (the default at startup) only shows a notification when an
 * update is found; when invoked explicitly from the command palette, always
 * reports the result.
 */
export async function checkForUpdates(
  client: ArduinoClient,
  output: vscode.OutputChannel,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const [current, res] = await Promise.all([
    client.version(),
    client.checkForUpdates(),
  ]);
  output.appendLine(
    `[maintenance] current=${current} newest=${res.newest_version || "(none)"}`,
  );
  if (res.newest_version && res.newest_version !== current) {
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "arduino-cli {0} is available (current: {1})",
        res.newest_version,
        current,
      ),
    );
  } else if (!opts.quiet) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("arduino-cli is up to date ({0})", current),
    );
  }
}

/** Delete cached downloads (platforms, libraries, tools). */
export async function cleanDownloadCache(
  client: ArduinoClient,
  output: vscode.OutputChannel,
): Promise<void> {
  await client.cleanDownloadCache();
  output.appendLine("[maintenance] download cache cleaned");
  vscode.window.showInformationMessage(
    vscode.l10n.t("Download cache cleared."),
  );
}
