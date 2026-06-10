import * as vscode from "vscode";

/**
 * URI of the document in the active editor tab. Unlike `window.activeTextEditor`,
 * this also resolves custom editors (e.g. a Blockly block-editor webview) and
 * notebook tabs, not just text editors.
 */
export function activeDocumentUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
  if (
    input instanceof vscode.TabInputText ||
    input instanceof vscode.TabInputCustom ||
    input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

/**
 * Resolve which workspace-folder root a command should act on, correctly in
 * multi-root workspaces. Prefers the folder containing the document you're
 * actually editing (active tab → its workspace folder); falls back to the only
 * folder when there's just one.
 *
 * When the active document belongs to no folder and several are open, behaviour
 * depends on `pickPlaceHolder`:
 * - provided → prompt with a workspace-folder picker (for explicit user-invoked
 *   commands, where blocking UI is acceptable);
 * - omitted → silently fall back to the first folder (for passive/background
 *   contexts, where a prompt would be intrusive).
 *
 * Returns `undefined` only when no folder is open, or the user dismisses the pick.
 */
export async function resolveActiveWorkspaceRoot(
  pickPlaceHolder?: string,
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const activeUri = activeDocumentUri();
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }

  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  if (pickPlaceHolder) {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: pickPlaceHolder,
    });
    return picked?.uri.fsPath;
  }

  return folders[0].uri.fsPath;
}
