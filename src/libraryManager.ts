import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { LibraryRelease, SearchedLibrary } from "./proto/types";
import { promptVersion } from "./versionPick";

/**
 * Library operations: search/list (reads) and install/uninstall/upgrade
 * (mutations that stream progress). The interactive `addLibrary` and the
 * by-name methods used by the Libraries tree view both funnel through the same
 * streaming op runner. Reads are exposed for the tree provider.
 */
export class LibraryManager {
  constructor(
    private readonly client: ArduinoClient,
    private readonly output: vscode.OutputChannel,
  ) {}

  // --- reads (used by the tree view) ---------------------------------------

  /** Installed libraries plus the set of names that have an upgrade available. */
  async listInstalled(): Promise<{
    installed: {
      name: string;
      version: string;
      sentence: string;
      paragraph: string;
      maintainer: string;
      license: string;
      category: string;
      containerPlatform: string;
      website: string;
      examples: string[];
      providesIncludes: string[];
    }[];
    updatable: Set<string>;
  }> {
    const [all, upd] = await Promise.all([
      this.client.libraryList(),
      this.client.libraryList({ updatable: true }),
    ]);
    const installed = (all.installed_libraries ?? []).map((il) => ({
      name: il.library.name,
      version: il.library.version,
      sentence: il.library.sentence,
      paragraph: il.library.paragraph ?? "",
      maintainer: il.library.maintainer ?? "",
      license: il.library.license ?? "",
      category: il.library.category ?? "",
      containerPlatform: il.library.container_platform ?? "",
      website: il.library.website ?? "",
      examples: il.library.examples ?? [],
      providesIncludes: il.library.provides_includes ?? [],
    }));
    const updatable = new Set(
      (upd.installed_libraries ?? []).map((il) => il.library.name),
    );
    return { installed, updatable };
  }

  // --- interactive entry point ---------------------------------------------

  /**
   * Add a library via a managed QuickPick that searches the daemon as the user
   * types (server-side `LibrarySearch`) — only matching results are fetched, not
   * the whole index. Picking a library previews dependencies and installs the
   * latest version.
   */
  /**
   * Returns the installed `{name, version}` on success (so callers can offer to
   * pin it to a profile), or `undefined` if cancelled or the install failed.
   * `version` may be empty when the user chose "latest".
   */
  async addLibrary(): Promise<{ name: string; version: string } | undefined> {
    const lib = await this.pickLibraryViaSearch();
    if (!lib) {
      return undefined;
    }
    const version = await this.pickVersion(lib);
    if (version === undefined) {
      return undefined; // version step cancelled
    }
    return (await this.installByName(lib.name, version))
      ? { name: lib.name, version }
      : undefined;
  }

  /**
   * Switch an installed library to any available version — including an older
   * one (a downgrade). Fetches the version list, then reinstalls the choice.
   */
  async changeVersion(name: string, installedVersion: string): Promise<boolean> {
    let lib: SearchedLibrary | undefined;
    try {
      const res = await this.client.librarySearch(name, true);
      lib = (res.libraries ?? []).find((l) => l.name === name);
    } catch (err) {
      this.showError(err);
      return false;
    }
    if (!lib) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("“{0}” is not in the library index.", name),
      );
      return false;
    }
    const version = await this.pickVersion(lib, installedVersion);
    if (version === undefined || version === installedVersion) {
      return false;
    }
    return this.installByName(lib.name, version);
  }

  private pickVersion(
    lib: SearchedLibrary,
    installedVersion?: string,
  ): Promise<string | undefined> {
    // available_versions is oldest-first from the daemon; reverse to newest-first.
    return promptVersion({
      versions: [...(lib.available_versions ?? [])].reverse(),
      latest: lib.latest?.version,
      installed: installedVersion,
      title: lib.name,
    });
  }

  private pickLibraryViaSearch(): Promise<SearchedLibrary | undefined> {
    type Item = vscode.QuickPickItem & { lib: SearchedLibrary };
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = vscode.l10n.t("Add Library");
      qp.placeholder = vscode.l10n.t("Type to search the Arduino library index");
      // The daemon does the matching; don't let the QuickPick re-filter results.
      qp.matchOnDetail = true;

      let seq = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const search = (raw: string): void => {
        const query = raw.trim();
        if (query.length < 2) {
          qp.items = [];
          qp.busy = false;
          return;
        }
        const mySeq = ++seq;
        qp.busy = true;
        this.client
          .librarySearch(query, true)
          .then((res) => {
            if (mySeq !== seq) {
              return; // a newer query superseded this one
            }
            qp.items = (res.libraries ?? []).map((l) => ({
              label: l.name,
              description: l.latest?.version,
              detail: describeRelease(l.latest),
              alwaysShow: true, // server already matched — show every result
              lib: l,
            }));
            qp.busy = false;
          })
          .catch(() => {
            if (mySeq === seq) {
              qp.busy = false;
            }
          });
      };

      qp.onDidChangeValue((value) => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => search(value), 250);
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        resolve(sel?.lib);
        qp.hide();
      });
      qp.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        qp.dispose();
        resolve(undefined); // no-op if already resolved by accept
      });
      qp.show();
    });
  }

  /** Install a library from a local .zip archive (file picker). */
  async installFromZip(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      title: vscode.l10n.t("Install Library from ZIP"),
      canSelectMany: false,
      filters: { "Zip archive": ["zip"] },
      openLabel: vscode.l10n.t("Install"),
    });
    const path = picked?.[0]?.fsPath;
    if (!path) {
      return false;
    }
    return this.runOp(
      vscode.l10n.t("Installing library from {0}…", path),
      (onStatus, signal) =>
        this.client.zipLibraryInstall({ path }, onStatus, signal),
      vscode.l10n.t("Library installed from archive."),
    );
  }

  /** Install a library from a git repository URL (input box). */
  async installFromGit(): Promise<boolean> {
    const url = await vscode.window.showInputBox({
      title: vscode.l10n.t("Install Library from Git URL"),
      prompt: vscode.l10n.t("Repository URL (e.g. https://github.com/user/lib.git)"),
      ignoreFocusOut: true,
    });
    if (!url) {
      return false;
    }
    return this.runOp(
      vscode.l10n.t("Installing library from {0}…", url),
      (onStatus, signal) =>
        this.client.gitLibraryInstall({ url }, onStatus, signal),
      vscode.l10n.t("Library installed from Git."),
    );
  }

  /**
   * Download a library archive into the cache without installing it (search →
   * pick → version → download). The library is NOT made usable — see the command
   * description.
   */
  async downloadArchive(): Promise<boolean> {
    const lib = await this.pickLibraryViaSearch();
    if (!lib) {
      return false;
    }
    const version = await this.pickVersion(lib);
    if (version === undefined) {
      return false;
    }
    return this.runOp(
      vscode.l10n.t("Downloading {0}…", lib.name),
      (onStatus, signal) =>
        this.client.libraryDownload({ name: lib.name, version }, onStatus, signal),
      vscode.l10n.t("Downloaded {0} to the cache.", lib.name),
    );
  }

  // --- by-name ops (used by the tree view and addLibrary) ------------------

  async installByName(name: string, version = ""): Promise<boolean> {
    if (!(await this.confirmDependencies(name, version))) {
      return false;
    }
    return this.runOp(
      vscode.l10n.t("Installing {0}…", labelOf(name, version)),
      (onStatus, signal) =>
        this.client.libraryInstall({ name, version }, onStatus, signal),
      vscode.l10n.t("Installed {0}.", labelOf(name, version)),
    );
  }

  uninstallByName(name: string): Promise<boolean> {
    return this.runOp(
      vscode.l10n.t("Uninstalling {0}…", name),
      (onStatus, signal) =>
        this.client.libraryUninstall({ name }, onStatus, signal),
      vscode.l10n.t("Removed {0}.", name),
    );
  }

  upgradeByName(name: string): Promise<boolean> {
    return this.runOp(
      vscode.l10n.t("Upgrading {0}…", name),
      (onStatus, signal) =>
        this.client.libraryUpgrade({ name }, onStatus, signal),
      vscode.l10n.t("Upgraded {0}.", name),
    );
  }

  upgradeAll(): Promise<boolean> {
    return this.runOp(
      vscode.l10n.t("Upgrading all libraries…"),
      (onStatus, signal) => this.client.libraryUpgradeAll(onStatus, signal),
      vscode.l10n.t("Libraries upgraded."),
    );
  }

  // --- helpers --------------------------------------------------------------

  private async confirmDependencies(
    name: string,
    version: string,
  ): Promise<boolean> {
    let deps;
    try {
      const res = await this.client.libraryResolveDependencies(name, version);
      deps = res.dependencies ?? [];
    } catch {
      return true; // can't resolve — let install proceed and surface any error
    }
    const toInstall = deps.filter(
      (d) => d.name !== name && d.version_installed !== d.version_required,
    );
    if (toInstall.length === 0) {
      return true;
    }
    const list = toInstall
      .map((d) => `• ${d.name} ${d.version_required}`)
      .join("\n");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("{0} also needs:", name),
      { modal: true, detail: list },
      vscode.l10n.t("Install all"),
    );
    return choice !== undefined;
  }

  /** Returns true on success, false on cancel/error. */
  private async runOp(
    title: string,
    call: (
      onStatus: (message: string) => void,
      signal: AbortSignal,
    ) => Promise<void>,
    successMessage: string,
  ): Promise<boolean> {
    this.output.appendLine(`\n[library] ${title}`);
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
              this.output.appendLine(`[library] ${message}`);
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
            `[library] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Library operation failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }

  private verbose(): boolean {
    return vscode.workspace.getConfiguration("arduinoCli").get<boolean>("verbose", false);
  }

  private showError(err: unknown): void {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Arduino CLI: {0}", err instanceof Error ? err.message : String(err)),
    );
  }
}

function labelOf(name: string, version: string): string {
  return version ? `${name}@${version}` : name;
}

/**
 * One-line description for a search result: the library's `sentence`, extended
 * with `paragraph` when it adds detail (paragraph often repeats the sentence).
 */
function describeRelease(release: LibraryRelease | undefined): string {
  const sentence = release?.sentence ?? "";
  // const paragraph = release?.paragraph ?? "";
  // if (paragraph && paragraph !== sentence) {
  //   return sentence ? `${sentence} ${paragraph}` : paragraph;
  // }
  return sentence;
}
