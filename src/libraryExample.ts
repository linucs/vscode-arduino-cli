import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Open one of a library's example sketches. Examples live inside the *installed*
 * library directory (a shared, managed copy), so we:
 *   1. let the user pick an example (paths come from `arduino-cli`'s
 *      `LibraryList`, one per example sketch folder);
 *   2. mark the example folder read-only by writing a `.vscode/settings.json`
 *      with a folder-scoped `files.readonlyInclude` glob — see note below;
 *   3. add the example folder as a workspace root (so the whole sketch, not just
 *      the `.ino`, is browsable);
 *   4. best-effort open the main `.ino`.
 *
 * Read-only rationale: `files.readonlyInclude` is `ConfigurationScope.RESOURCE`
 * and its globs are matched relative to the workspace folder. Writing
 * `{ "**": true }` into the example folder's own `.vscode/settings.json` makes it
 * a folder-scoped rule that marks read-only *only* that folder's files, leaving
 * the user's own sketch (another root) writable. Keeping the rule inside the
 * example folder means nothing accumulates in user/workspace settings and there
 * is nothing to clean up — it vanishes if the library is reinstalled.
 *
 * Returns the opened example folder so the caller can configure IntelliSense for
 * it (otherwise cpptools flags the library headers as missing), or `undefined`
 * when there is nothing to open or the user cancelled.
 */
export async function openLibraryExample(
  libName: string,
  examples: string[],
): Promise<string | undefined> {
  if (examples.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("“{0}” has no examples.", libName),
    );
    return undefined;
  }

  const folder = await pickExample(libName, examples);
  if (!folder) {
    return undefined;
  }

  // 2. Read-only first, so it is in place before the folder is added (and before
  //    any extension-host restart triggered by adding the first workspace root).
  await markFolderReadonly(folder);

  // 3. Add the example folder as a new workspace root.
  const count = vscode.workspace.workspaceFolders?.length ?? 0;
  vscode.workspace.updateWorkspaceFolders(count, 0, {
    uri: vscode.Uri.file(folder),
    name: `${libName} · ${path.basename(folder)}`,
  });

  // 4. Best-effort: open the example's main .ino. May not run if adding the
  //    first root restarted the extension host — that's fine, the folder is open.
  await openMainSketch(folder);
  return folder;
}

/** QuickPick of example names (path relative to the `examples/` segment). */
async function pickExample(
  libName: string,
  examples: string[],
): Promise<string | undefined> {
  const items = examples.map((p) => ({ label: exampleLabel(p), folder: p }));
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Open Example — {0}", libName),
    placeHolder: vscode.l10n.t("Choose an example to open"),
  });
  return picked?.folder;
}

/** Display name for an example folder: the part after the last `examples/`. */
function exampleLabel(folder: string): string {
  const parts = folder.split(/[/\\]/);
  const idx = parts.lastIndexOf("examples");
  return idx >= 0 && idx < parts.length - 1
    ? parts.slice(idx + 1).join("/")
    : path.basename(folder);
}

/**
 * Write/merge `<folder>/.vscode/settings.json` with a folder-scoped read-only
 * glob. Idempotent; failures (e.g. non-writable dir) are swallowed so opening the
 * example still proceeds.
 */
async function markFolderReadonly(folder: string): Promise<void> {
  const KEY = "files.readonlyInclude";
  const vscodeDir = vscode.Uri.file(path.join(folder, ".vscode"));
  const settingsUri = vscode.Uri.joinPath(vscodeDir, "settings.json");
  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = await vscode.workspace.fs.readFile(settingsUri);
      settings = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // No file (or unreadable/invalid JSON): start fresh rather than corrupting.
      settings = {};
    }
    const include =
      (settings[KEY] as Record<string, boolean> | undefined) ?? {};
    if (include["**"] === true) {
      return; // already read-only — nothing to write
    }
    include["**"] = true;
    settings[KEY] = include;
    await vscode.workspace.fs.createDirectory(vscodeDir);
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8"),
    );
  } catch {
    // Best-effort: if we can't write, open the example without read-only.
  }
}

/** Open `<folder>/<basename>.ino`, falling back to the first `*.ino` found. */
async function openMainSketch(folder: string): Promise<void> {
  try {
    const expected = path.join(folder, `${path.basename(folder)}.ino`);
    let target = vscode.Uri.file(expected);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(folder),
      );
      const ino = entries.find(
        ([name, type]) =>
          type === vscode.FileType.File && name.toLowerCase().endsWith(".ino"),
      );
      if (!ino) {
        return;
      }
      target = vscode.Uri.file(path.join(folder, ino[0]));
    }
    await vscode.window.showTextDocument(target);
  } catch {
    // Best-effort.
  }
}
