import * as path from "node:path";
import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { Sketch } from "./proto/types";

/**
 * Resolves which sketch to act on and validates it via `LoadSketch`.
 *
 * Resolution order:
 *  1. the active editor, if it is a `.ino` (or any file inside a sketch folder);
 *  2. a single `.ino` found in the workspace;
 *  3. a QuickPick when several sketches exist.
 *
 * Returns the loaded `Sketch` — callers use `location_path` as the `sketch_path`
 * argument and may seed board defaults from `default_fqbn`/`default_port`.
 */
export async function resolveSketch(
  client: ArduinoClient,
  opts: { silent?: boolean } = {},
): Promise<Sketch | undefined> {
  const candidate = await pickCandidatePath(opts.silent ?? false);
  if (!candidate) {
    return undefined;
  }
  try {
    const res = await client.loadSketch(candidate);
    return res.sketch;
  } catch (err) {
    if (!opts.silent) {
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Not a valid Arduino sketch: {0}",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    return undefined;
  }
}

/** Determine the filesystem path to hand to `LoadSketch` (a file or folder). */
async function pickCandidatePath(silent: boolean): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file" && active.fsPath.endsWith(".ino")) {
    return active.fsPath;
  }

  const inos = await vscode.workspace.findFiles("**/*.ino", "**/node_modules/**", 50);
  if (inos.length === 0) {
    if (!silent) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("No Arduino sketch (.ino) found in the workspace."),
      );
    }
    return undefined;
  }
  if (inos.length === 1) {
    return inos[0].fsPath;
  }

  // If the active file lives next to one of the sketches, prefer that one.
  if (active?.scheme === "file") {
    const dir = path.dirname(active.fsPath);
    const sameDir = inos.find((u) => path.dirname(u.fsPath) === dir);
    if (sameDir) {
      return sameDir.fsPath;
    }
  }

  // Ambiguous: only prompt interactively. In silent mode (e.g. pinning a board
  // selection) we skip rather than surprise the user with a second QuickPick.
  if (silent) {
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    inos.map((u) => ({
      label: path.basename(u.fsPath),
      description: vscode.workspace.asRelativePath(u),
      fsPath: u.fsPath,
    })),
    {
      title: vscode.l10n.t("Select Sketch"),
      placeHolder: vscode.l10n.t("Multiple sketches found — pick one"),
    },
  );
  return pick?.fsPath;
}
