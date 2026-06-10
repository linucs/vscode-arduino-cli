import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { resolveActiveWorkspaceRoot } from "../workspaceRoot";

const SKILL_REL = path.join(".claude", "skills", "arduino-cli");
const COPILOT_INSTRUCTIONS_REL = path.join(
  ".github",
  "instructions",
  "arduino-cli.instructions.md",
);

/**
 * Set up the shared AI-assistant config for this workspace.
 *
 * The single source of truth is the skill at `.claude/skills/arduino-cli/`
 * (`SKILL.md` + `reference.md`, shipped in the .vsix). The two hosts discover
 * guidance differently, so we materialise it for each:
 *
 * - **Claude Code** natively discovers Agent Skills under `.claude/skills/`,
 *   reads `SKILL.md`, and lazily loads `reference.md` only when the Arduino skill
 *   triggers. We just copy the skill dir.
 * - **GitHub Copilot** does NOT read `.claude/skills/`. In VS Code it reads
 *   instruction files from `.github/instructions/*.instructions.md`, gated by an
 *   `applyTo` glob. We *generate* that file with `applyTo: "**"` (injected on
 *   every request) and have it instruct the agent to read the same
 *   `.claude/skills/arduino-cli/reference.md` Claude loads lazily — so both hosts
 *   share one source of truth instead of a duplicated copy.
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

  const srcDir = path.join(context.extensionPath, SKILL_REL);

  try {
    // Claude Code: copy the whole bundled skill dir so any file it ships (manifest,
    // reference, future scripts/resources) lands in the workspace — no per-file
    // list to keep.
    const destDir = path.join(root, SKILL_REL);
    await fs.cp(srcDir, destDir, { recursive: true });

    // GitHub Copilot: generate an instructions file that points Copilot at the
    // skill's reference, so it has the same guidance Claude loads lazily.
    await writeCopilotInstructions(root);
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

/**
 * Generate the Copilot instructions file: an `applyTo: "**"` header (injected on
 * every request) plus a directive to read the skill's `reference.md`. This is a
 * dedicated, fully-generated file, so it is overwritten wholesale on re-install.
 */
async function writeCopilotInstructions(root: string): Promise<void> {
  const content = [
    "---",
    'applyTo: "**"',
    "---",
    "",
    "# Arduino CLI assistant",
    "",
    "ALWAYS read .claude/skills/arduino-cli/reference.md before answering Arduino-CLI questions.",
    "The assistant SHOULD open and read that file automatically (without asking for permission)",
    "whenever handling Arduino-CLI related requests. The assistant may show a one-line preamble",
    "before opening the file per tool-preamble rules but must not prompt the user for consent.",
    "",
  ].join("\n");

  const destPath = path.join(root, COPILOT_INSTRUCTIONS_REL);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, content, "utf8");
}

