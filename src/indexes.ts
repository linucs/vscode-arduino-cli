import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { DownloadProgress } from "./proto/types";

/**
 * Commands to refresh the platform and library indexes. Both are server-streaming
 * downloads; progress is rendered in a cancellable notification. Not run on
 * activation — the user triggers them on demand.
 */
export class Indexes {
  constructor(
    private readonly client: ArduinoClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  updatePackageIndex(): Promise<void> {
    return this.run(
      vscode.l10n.t("Updating package index…"),
      (onProgress, signal) => this.client.updateIndex(onProgress, signal),
    );
  }

  updateLibrariesIndex(): Promise<void> {
    return this.run(
      vscode.l10n.t("Updating libraries index…"),
      (onProgress, signal) =>
        this.client.updateLibrariesIndex(onProgress, signal),
    );
  }

  private async run(
    title: string,
    call: (
      onProgress: (p: DownloadProgress) => void,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          await call((p) => reportDownload(progress, p), ac.signal);
        } catch (err) {
          if (ac.signal.aborted) {
            return;
          }
          this.output.appendLine(
            `[index] update failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Index update failed — see the Arduino CLI output."),
          );
        }
      },
    );
  }
}

/** Render a DownloadProgress oneof message into the notification. */
function reportDownload(
  progress: vscode.Progress<{ message?: string }>,
  dp: DownloadProgress,
): void {
  if (dp.start) {
    progress.report({ message: dp.start.label || dp.start.url });
  } else if (dp.update) {
    const { downloaded, total_size } = dp.update;
    const pct =
      total_size > 0 ? ` ${Math.round((downloaded / total_size) * 100)}%` : "";
    progress.report({ message: vscode.l10n.t("Downloading…{0}", pct) });
  }
  // `end` carries only a success/message; nothing to render incrementally.
}
