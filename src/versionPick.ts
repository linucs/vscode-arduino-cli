import * as vscode from "vscode";

/**
 * Shared version picker for platforms and libraries. Given a newest-first list
 * of versions plus the latest/installed markers, shows a QuickPick annotating
 * each entry (`latest · installed`). Returns the sole version when there is only
 * one (falling back to `latest`), or undefined if the user cancelled.
 *
 * The per-domain extraction (how to read versions/latest off a PlatformSummary
 * vs a SearchedLibrary) stays with each manager; only this UI is shared.
 */
export async function promptVersion(opts: {
  /** Versions in display order (newest first). */
  versions: string[];
  /** The latest version, annotated in the list. */
  latest?: string;
  /** The currently-installed version, annotated in the list. */
  installed?: string;
  /** Package/library id shown in the "Version of {0}" title. */
  title: string;
}): Promise<string | undefined> {
  const { versions, latest, installed, title } = opts;
  if (versions.length <= 1) {
    return versions[0] ?? latest ?? "";
  }
  const items = versions.map((v) => {
    const tags: string[] = [];
    if (v === latest) {
      tags.push(vscode.l10n.t("latest"));
    }
    if (v === installed) {
      tags.push(vscode.l10n.t("installed"));
    }
    return { label: v, description: tags.join(" · ") || undefined };
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Version of {0}", title),
    placeHolder: vscode.l10n.t("Select a version (newest first)"),
  });
  return pick?.label;
}
