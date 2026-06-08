import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

const SKILL_REL = path.join(".claude", "skills", "arduino-cli");
const SKILL_FILES = ["SKILL.md", "reference.md"];

/**
 * Copy the bundled Claude Code skill (SKILL.md + reference.md) into the active
 * workspace at `.claude/skills/arduino-cli/`, so a Claude Code session for this
 * project discovers it and learns how to drive `arduino-cli`. The skill ships in
 * the .vsix via a `.vscodeignore` exception; re-running after an extension
 * upgrade refreshes the copied files.
 */
export async function installArduinoSkill(
  context: vscode.ExtensionContext,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Open a workspace folder first to install the Arduino skill."),
    );
    return;
  }

  const srcDir = path.join(context.extensionPath, SKILL_REL);
  const destDir = path.join(root, SKILL_REL);
  try {
    await fs.mkdir(destDir, { recursive: true });
    for (const file of SKILL_FILES) {
      await fs.copyFile(path.join(srcDir, file), path.join(destDir, file));
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not install the Arduino skill: {0}",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return;
  }

  vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Arduino skill installed in {0}. Start a Claude Code session in this folder and it will be available.",
      SKILL_REL,
    ),
  );
}
