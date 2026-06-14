import * as vscode from "vscode";

/**
 * Modal confirmation for a destructive action (uninstall / remove). Returns true
 * only when the user explicitly clicks the confirm button; the modal's Cancel —
 * and dismissing it — return false. Shared by the library/platform uninstall and
 * the profile-library remove paths so every entry point (tree inline action,
 * command palette, interactive picker) confirms the same way.
 */
export async function confirmRemoval(
  message: string,
  detail?: string,
): Promise<boolean> {
  const remove = vscode.l10n.t("Remove");
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, ...(detail ? { detail } : {}) },
    remove,
  );
  return choice === remove;
}
