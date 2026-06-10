import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { resolveActiveWorkspaceRoot } from "../workspaceRoot";

const SKILL_REL = path.join(".claude", "skills", "arduino-cli");

/**
 * Set up the shared AI-assistant config for this workspace from ONE source of
 * truth: the skill at `.claude/skills/arduino-cli/` (`SKILL.md` + `reference.md`,
 * shipped in the .vsix). Both Claude Code and GitHub Copilot (agent mode) natively
 * discover Agent Skills under `.claude/skills/`, read `SKILL.md`, and lazily load
 * `reference.md` only when the Arduino skill triggers — so one copy serves both
 * hosts and the detail costs nothing until it is needed.
 *
 * Both hosts then drive `arduino-cli` via the shell — no wrapper tools.
 */
export async function installAiAssistants(
  context: vscode.ExtensionContext,
): Promise<void> {
  const root = await resolveActiveWorkspaceRoot(
    vscode.l10n.t("Select the folder to set up the Arduino AI assistant in"),
  );
  if (!root) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Open a workspace folder first to install the Arduino skill."),
    );
    return;
  }

  try {
    // The skill: discovered by both Claude Code and Copilot under `.claude/skills/`.
    // Copy the whole bundled skill dir so any file it ships (manifest, reference,
    // future scripts/resources) lands in the workspace — no per-file list to keep.
    const srcDir = path.join(context.extensionPath, SKILL_REL);
    const destDir = path.join(root, SKILL_REL);
    await fs.cp(srcDir, destDir, { recursive: true });
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
      "Arduino AI assistant configured: skill installed for Claude Code and GitHub Copilot in this folder.",
    ),
  );
}
