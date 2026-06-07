import * as vscode from "vscode";

/**
 * A sensible default `defaultUri` for a Save dialog: the given filename anchored
 * to the active editor's workspace folder, else the first workspace root. Falls
 * back to a bare filename (resolved against the process cwd) only when there is
 * no workspace open. Avoids the "saves to filesystem root" trap of passing a
 * bare `Uri.file(name)`.
 */
export function defaultSaveUri(filename: string): vscode.Uri {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder =
    (active && vscode.workspace.getWorkspaceFolder(active)?.uri) ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder
    ? vscode.Uri.joinPath(folder, filename)
    : vscode.Uri.file(filename);
}

/**
 * Show a "saved" toast with a follow-up action: `open` loads the file in an
 * editor, `reveal` shows it in the OS file manager. The action is non-blocking —
 * the caller need not await it.
 */
export async function notifySaved(
  message: string,
  filePath: string,
  action: "open" | "reveal",
): Promise<void> {
  const label =
    action === "open"
      ? vscode.l10n.t("Open")
      : vscode.l10n.t("Reveal in File Explorer");
  const choice = await vscode.window.showInformationMessage(message, label);
  if (choice !== label) {
    return;
  }
  const uri = vscode.Uri.file(filePath);
  if (action === "open") {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } else {
    await vscode.commands.executeCommand("revealFileInOS", uri);
  }
}
