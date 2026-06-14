import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { PlatformSummary } from "./proto/types";
import { promptVersion } from "./versionPick";
import { confirmRemoval } from "./confirm";

/**
 * Platform/core management: search, install, uninstall, upgrade — plus
 * `ensurePlatformInstalled`, which the compile/upload flow calls to offer
 * installing a missing core before the build fails (FR2.4).
 */
export class PlatformManager {
  constructor(
    private readonly client: ArduinoClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Ensure the platform a board belongs to is installed. Returns true only when
   * the core is confirmed installed (already present or just installed), false
   * otherwise (search failed, user declined, auto-install disabled, unknown
   * core). Callers decide how to react to false — compile/upload can let the
   * daemon surface a better error, ProfileCreate must abort.
   *
   * @param version When set (profile mode), checks and installs that specific
   *   version. When absent (global mode / ProfileCreate), checks any installed
   *   version and installs `latest_version` from the index.
   */
  async ensurePlatformInstalled(
    fqbn: string,
    version?: string,
  ): Promise<boolean> {
    const [pkg, arch] = fqbn.split(":");
    if (!pkg || !arch) {
      return false;
    }
    const id = `${pkg}:${arch}`;

    let summary: PlatformSummary | undefined;
    try {
      const res = await this.client.platformSearch(id);
      summary = res.search_output?.find((s) => s.metadata.id === id);
    } catch {
      return false;
    }
    if (!summary) {
      return false;
    }
    if (version
      ? summary.installed_version === version
      : Boolean(summary.installed_version)) {
      return true;
    }

    const enabled = vscode.workspace
      .getConfiguration("arduinoCli")
      .get<boolean>("autoInstallPlatform", true);
    if (!enabled) {
      return false;
    }

    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Platform “{0}” is not installed. Install it now?", id),
      vscode.l10n.t("Install"),
    );
    if (!choice) {
      return false;
    }
    await this.install(pkg, arch, version ?? summary.latest_version);
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
    await this.uninstallById(pkg, arch);
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
    await this.upgradeById(pkg, arch);
  }

  // --- reads (used by the Platforms tree view) -----------------------------

  /**
   * Installed cores, each flagged `updatable` when a newer release exists.
   * There is no `PlatformList` RPC (unlike libraries), so installed-state is
   * derived from `PlatformSearch` — the same source `pickPlatform` filters.
   */
  async listInstalled(): Promise<
    { id: string; name: string; version: string; updatable: boolean }[]
  > {
    const res = await this.client.platformSearch("");
    return (res.search_output ?? [])
      .filter((s) => Boolean(s.installed_version))
      .map((s) => ({
        id: s.metadata.id,
        name: installedName(s),
        version: s.installed_version,
        updatable:
          Boolean(s.latest_version) &&
          s.latest_version !== s.installed_version,
      }));
  }

  // --- by-id mutations (used by the tree view's inline actions) ------------

  async uninstallById(pkg: string, arch: string): Promise<boolean> {
    const id = `${pkg}:${arch}`;
    if (!(await confirmRemoval(vscode.l10n.t('Remove platform "{0}"?', id)))) {
      return false;
    }
    return this.withProgress(
      vscode.l10n.t("Uninstalling {0}…", id),
      (onStatus, signal) =>
        this.client.platformUninstall(
          { platform_package: pkg, architecture: arch },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Removed {0}.", id),
    );
  }

  upgradeById(pkg: string, arch: string): Promise<boolean> {
    const id = `${pkg}:${arch}`;
    return this.withProgress(
      vscode.l10n.t("Upgrading {0}…", id),
      (onStatus, signal) =>
        this.client.platformUpgrade(
          { platform_package: pkg, architecture: arch },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Upgraded {0}.", id),
    );
  }

  /**
   * Switch an installed core to any available release — including an older one
   * (a downgrade): search for the platform, pick a version, reinstall.
   */
  async changeVersion(id: string, installedVersion: string): Promise<boolean> {
    let summary: PlatformSummary | undefined;
    try {
      const res = await this.client.platformSearch(id);
      summary = res.search_output?.find((s) => s.metadata.id === id);
    } catch (err) {
      this.showError(err);
      return false;
    }
    if (!summary) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("“{0}” is not in the platform index.", id),
      );
      return false;
    }
    const version = await this.pickVersion(summary, installedVersion);
    if (version === undefined || version === installedVersion) {
      return false;
    }
    const [pkg, arch] = id.split(":");
    return this.withProgress(
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

  /**
   * Upgrade every updatable core. There is no `PlatformUpgradeAll` RPC, so this
   * loops `PlatformUpgrade` under a single progress notification.
   */
  async upgradeAll(): Promise<boolean> {
    const updatable = (await this.listInstalled()).filter((p) => p.updatable);
    if (updatable.length === 0) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("All platforms are up to date."),
      );
      return false;
    }
    return this.withProgress(
      vscode.l10n.t("Upgrading all platforms…"),
      async (onStatus, signal) => {
        for (const p of updatable) {
          const [pkg, arch] = p.id.split(":");
          onStatus(p.id);
          await this.client.platformUpgrade(
            { platform_package: pkg, architecture: arch },
            onStatus,
            signal,
          );
        }
      },
      vscode.l10n.t("Platforms upgraded."),
    );
  }

  /**
   * Pick a release of `summary` (newest first; latest/installed annotated).
   * Returns the sole version when there's only one, or undefined if cancelled.
   */
  private pickVersion(
    summary: PlatformSummary,
    installedVersion?: string,
  ): Promise<string | undefined> {
    return promptVersion({
      versions: Object.keys(summary.releases ?? {}).sort(compareVersionDesc),
      latest: summary.latest_version,
      installed: installedVersion,
      title: summary.metadata.id,
    });
  }

  private showError(err: unknown): void {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Arduino CLI: {0}",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  /** Download a platform archive to the cache without installing it. */
  async downloadInteractive(): Promise<void> {
    const summary = await this.pickPlatform(
      (s) => !s.installed_version && Boolean(s.latest_version),
      vscode.l10n.t("Download Platform"),
      vscode.l10n.t("Pick a platform to download (cache only)"),
    );
    if (!summary) {
      return;
    }
    const [pkg, arch] = summary.metadata.id.split(":");
    await this.withProgress(
      vscode.l10n.t("Downloading {0}…", summary.metadata.id),
      (onStatus, signal) =>
        this.client.platformDownload(
          { platform_package: pkg, architecture: arch, version: summary.latest_version },
          onStatus,
          signal,
        ),
      vscode.l10n.t("Downloaded {0} to the cache.", summary.metadata.id),
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

  private verbose(): boolean {
    return vscode.workspace.getConfiguration("arduinoCli").get<boolean>("verbose", false);
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

  /** Returns true on success, false on cancel/error. */
  private async withProgress(
    title: string,
    call: (
      onStatus: (message: string) => void,
      signal: AbortSignal,
    ) => Promise<void>,
    successMessage: string,
  ): Promise<boolean> {
    this.output.appendLine(`\n[platform] ${title}`);
    return vscode.window.withProgress(
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
            if (this.verbose()) {
              this.output.appendLine(`[platform] ${message}`);
            }
            progress.report({ message });
          }, ac.signal);
          vscode.window.showInformationMessage(successMessage);
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            return false;
          }
          this.output.appendLine(
            `[platform] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Platform operation failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }
}

/** Display name for an installed core (its installed release name, else id). */
function installedName(s: PlatformSummary): string {
  return s.releases?.[s.installed_version]?.name || s.metadata.id;
}

/** Compare dotted version strings descending (newest first); numeric-aware. */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = b.localeCompare(a);
      if (c !== 0) {
        return c;
      }
      continue;
    }
    if (na !== nb) {
      return nb - na;
    }
  }
  return 0;
}

/** Best human name for a platform summary (latest release name, else id). */
function latestName(s: PlatformSummary): string {
  const rel = s.latest_version
    ? s.releases?.[s.latest_version]
    : undefined;
  return rel?.name || s.metadata.id;
}
