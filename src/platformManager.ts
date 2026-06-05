import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { PlatformSummary } from "./proto/types";

/**
 * Platform/core management: search, install, uninstall, upgrade — plus
 * `ensurePlatformForFqbn`, which the compile/upload flow calls to offer
 * installing a missing core before the build fails (FR2.4).
 */
export class PlatformManager {
  constructor(
    private readonly client: ArduinoClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Ensure the platform a board belongs to is installed. Returns true if the
   * build may proceed (already installed, just installed, or undeterminable —
   * in which case we let compile surface the real error), false if the user
   * declined to install a known-missing core.
   */
  async ensurePlatformForFqbn(fqbn: string): Promise<boolean> {
    const [pkg, arch] = fqbn.split(":");
    if (!pkg || !arch) {
      return true;
    }
    const id = `${pkg}:${arch}`;

    let summary: PlatformSummary | undefined;
    try {
      const res = await this.client.platformSearch(id);
      summary = res.search_output?.find((s) => s.metadata.id === id);
    } catch {
      return true; // search failed — let compile run and report the real cause
    }
    if (!summary || summary.installed_version) {
      return true; // unknown platform, or already installed
    }

    const enabled = vscode.workspace
      .getConfiguration("arduinoCli")
      .get<boolean>("autoInstallPlatform", true);
    if (!enabled) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Platform “{0}” is not installed. Install it now?", id),
      vscode.l10n.t("Install"),
    );
    if (!choice) {
      return false;
    }
    await this.install(pkg, arch, summary.latest_version);
    return true;
  }

  /** Search the index and install a platform chosen from a QuickPick. */
  async installInteractive(): Promise<void> {
    const summary = await this.pickPlatform(
      (s) => !s.installed_version,
      vscode.l10n.t("Install Platform"),
      vscode.l10n.t("Search platforms to install"),
    );
    if (summary) {
      await this.install(
        summary.metadata.id.split(":")[0],
        summary.metadata.id.split(":")[1],
        summary.latest_version,
      );
    }
  }

  /** Uninstall an installed platform chosen from a QuickPick. */
  async uninstallInteractive(): Promise<void> {
    const summary = await this.pickPlatform(
      (s) => Boolean(s.installed_version),
      vscode.l10n.t("Uninstall Platform"),
      vscode.l10n.t("Pick an installed platform to remove"),
    );
    if (!summary) {
      return;
    }
    const [pkg, arch] = summary.metadata.id.split(":");
    await this.withProgress(
      vscode.l10n.t("Uninstalling {0}…", summary.metadata.id),
      (onStatus, signal) =>
        this.client.platformUninstall(
          { platform_package: pkg, architecture: arch },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Removed {0}.", summary.metadata.id),
    );
  }

  /** Upgrade an installed platform chosen from a QuickPick. */
  async upgradeInteractive(): Promise<void> {
    const summary = await this.pickPlatform(
      (s) =>
        Boolean(s.installed_version) &&
        Boolean(s.latest_version) &&
        s.installed_version !== s.latest_version,
      vscode.l10n.t("Upgrade Platform"),
      vscode.l10n.t("Pick a platform to upgrade"),
    );
    if (!summary) {
      return;
    }
    const [pkg, arch] = summary.metadata.id.split(":");
    await this.withProgress(
      vscode.l10n.t("Upgrading {0}…", summary.metadata.id),
      (onStatus, signal) =>
        this.client.platformUpgrade(
          { platform_package: pkg, architecture: arch },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Upgraded {0}.", summary.metadata.id),
    );
  }

  private async install(
    pkg: string,
    arch: string,
    version: string,
  ): Promise<void> {
    await this.withProgress(
      vscode.l10n.t("Installing {0}:{1}…", pkg, arch),
      (onStatus, signal) =>
        this.client.platformInstall(
          { platform_package: pkg, architecture: arch, version },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Installed {0}:{1}.", pkg, arch),
    );
  }

  private async pickPlatform(
    filter: (s: PlatformSummary) => boolean,
    title: string,
    placeHolder: string,
  ): Promise<PlatformSummary | undefined> {
    let summaries: PlatformSummary[];
    try {
      const res = await this.client.platformSearch("");
      summaries = (res.search_output ?? []).filter(filter);
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Arduino CLI: {0}", err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }
    if (summaries.length === 0) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("No matching platforms."),
      );
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      summaries
        .map((s) => ({
          label: latestName(s),
          description: s.metadata.id,
          detail: s.installed_version
            ? vscode.l10n.t("installed {0}", s.installed_version)
            : vscode.l10n.t("available {0}", s.latest_version),
          summary: s,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      { title, placeHolder, matchOnDescription: true },
    );
    return pick?.summary;
  }

  private async withProgress(
    title: string,
    call: (
      onStatus: (message: string) => void,
      signal: AbortSignal,
    ) => Promise<void>,
    successMessage: string,
  ): Promise<void> {
    this.output.appendLine(`\n[platform] ${title}`);
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
          await call((message) => {
            this.output.appendLine(`[platform] ${message}`);
            progress.report({ message });
          }, ac.signal);
          vscode.window.showInformationMessage(successMessage);
        } catch (err) {
          if (ac.signal.aborted) {
            return;
          }
          this.output.appendLine(
            `[platform] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Platform operation failed — see the Arduino CLI output."),
          );
        }
      },
    );
  }
}

/** Best human name for a platform summary (latest release name, else id). */
function latestName(s: PlatformSummary): string {
  const rel = s.latest_version
    ? s.releases?.[s.latest_version]
    : undefined;
  return rel?.name || s.metadata.id;
}
