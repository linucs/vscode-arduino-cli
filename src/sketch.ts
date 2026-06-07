import * as path from "node:path";
import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { Sketch } from "./proto/types";

/** Scaffold a new sketch: prompt for name and directory, then open the main file. */
export async function newSketch(client: ArduinoClient): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("New Arduino Sketch"),
    prompt: vscode.l10n.t("Sketch name"),
    placeHolder: "MySketch",
    validateInput: (v) =>
      v.trim().length === 0
        ? vscode.l10n.t("Name cannot be empty")
        : undefined,
  });
  if (!name) {
    return;
  }

  const defaultDir =
    vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("");
  const dirs = await vscode.window.showOpenDialog({
    title: vscode.l10n.t("Parent folder for the new sketch"),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: defaultDir,
    openLabel: vscode.l10n.t("Select"),
  });
  const dir = dirs?.[0]?.fsPath;
  if (!dir) {
    return;
  }

  const res = await client.newSketch(name.trim(), dir);
  const doc = await vscode.workspace.openTextDocument(res.main_file);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    vscode.l10n.t("Created sketch {0}", name.trim()),
  );
}

/** Archive the current sketch as a .zip file. */
export async function archiveSketch(client: ArduinoClient): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const defaultName = path.basename(sketch.location_path) + ".zip";
  const dest = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Archive Sketch"),
    defaultUri: vscode.Uri.file(
      path.join(sketch.location_path, "..", defaultName),
    ),
    filters: { "Zip archive": ["zip"] },
  });
  if (!dest) {
    return;
  }

  await client.archiveSketch(sketch.location_path, dest.fsPath);
  vscode.window.showInformationMessage(
    vscode.l10n.t("Sketch archived to {0}", path.basename(dest.fsPath)),
  );
}

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
  opts: {
    silent?: boolean;
    target?: vscode.Uri | string;
    output?: vscode.OutputChannel;
  } = {},
): Promise<Sketch | undefined> {
  const candidate = await pickCandidatePath(opts.silent ?? false, opts.target);
  if (!candidate) {
    return undefined;
  }
  try {
    const res = await client.loadSketch(candidate);
    return res.sketch;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log even in silent mode: a sketch (likely with a sketch.yaml) is present
    // but won't parse — otherwise the failure is invisible (e.g. the profile
    // tree just never appears). Non-intrusive: written to the channel, not shown.
    opts.output?.appendLine(`[sketch] could not load ${candidate}: ${msg}`);
    if (!opts.silent) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Not a valid Arduino sketch: {0}", msg),
      );
    }
    return undefined;
  }
}

/** Determine the filesystem path to hand to `LoadSketch` (a file or folder). */
async function pickCandidatePath(
  silent: boolean,
  target?: vscode.Uri | string,
): Promise<string | undefined> {
  // Explicit target wins (e.g. the document URI VS Code passes to an editor/title
  // command, or a path from any programmatic caller). LoadSketch validates it and
  // resolves the enclosing sketch folder.
  if (target) {
    return target instanceof vscode.Uri ? target.fsPath : target;
  }

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
