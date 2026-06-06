import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { PlatformManager } from "./platformManager";
import { resolveSketch } from "./sketch";
import type { CompileDiagnostic, CompileDiagnosticRef } from "./proto/types";

/**
 * Runs `Compile` and surfaces compiler diagnostics in the Problems panel.
 *
 * Output (stdout/stderr) is mirrored to the shared output channel; the structured
 * `BuilderResult.diagnostics` are mapped into a DiagnosticCollection.
 */
export class Compiler {
  private readonly diagnostics: vscode.DiagnosticCollection;

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly platforms: PlatformManager,
    private readonly output: vscode.OutputChannel,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection("arduino");
  }

  /** Compile the resolved sketch for the selected board. Returns true on success. */
  async run(
    opts: { optimizeForDebug?: boolean; target?: vscode.Uri | string } = {},
  ): Promise<boolean> {
    const sketch = await resolveSketch(this.client, { target: opts.target });
    if (!sketch) {
      return false;
    }
    const fqbn = this.boards.fqbn || sketch.default_fqbn;
    if (!fqbn) {
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("No board selected for this sketch."),
        vscode.l10n.t("Select Board"),
      );
      if (choice) {
        await this.boards.selectBoard();
      }
      return false;
    }

    // Offer to install the board's platform if it's missing (FR2.4).
    if (!(await this.platforms.ensurePlatformForFqbn(fqbn))) {
      return false;
    }

    this.diagnostics.clear();
    this.output.show(true);
    this.output.appendLine(`\n[compile] ${fqbn} — ${sketch.location_path}`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Compiling {0}…", fqbn),
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          const result = await this.client.compile(
            {
              fqbn,
              sketch_path: sketch.location_path,
              ...(opts.optimizeForDebug ? { optimize_for_debug: true } : {}),
            },
            {
              out: (s) => this.output.append(s),
              err: (s) => this.output.append(s),
              progress: (t) =>
                progress.report({ message: t.message || t.name }),
            },
            ac.signal,
          );
          if (result?.diagnostics?.length) {
            this.applyDiagnostics(result.diagnostics);
          }
          vscode.window.showInformationMessage(
            vscode.l10n.t("Compilation finished."),
          );
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[compile] cancelled");
            return false;
          }
          this.output.appendLine(
            `[compile] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Compilation failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }

  private applyDiagnostics(diags: CompileDiagnostic[]): void {
    for (const [file, list] of buildDiagnostics(diags)) {
      this.diagnostics.set(vscode.Uri.file(file), list);
    }
  }

  dispose(): void {
    this.diagnostics.dispose();
  }
}

/**
 * Map `CompileDiagnostic[]` → vscode diagnostics grouped per file. Pure (no
 * collection side effects) so it can be unit-tested. Diagnostics with no file
 * are skipped; `context` + `notes` become related information.
 */
export function buildDiagnostics(
  diags: CompileDiagnostic[],
): Map<string, vscode.Diagnostic[]> {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of diags) {
    if (!d.file) {
      continue;
    }
    const diag = new vscode.Diagnostic(
      toRange(d.line, d.column),
      d.message,
      toSeverity(d.severity),
    );
    diag.source = "arduino-cli";
    const related = [...(d.context ?? []), ...(d.notes ?? [])]
      .filter((r) => r.file)
      .map(
        (r: CompileDiagnosticRef) =>
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(r.file), toRange(r.line, r.column)),
            r.message,
          ),
      );
    if (related.length) {
      diag.relatedInformation = related;
    }
    const list = byFile.get(d.file) ?? [];
    list.push(diag);
    byFile.set(d.file, list);
  }
  return byFile;
}

/** arduino-cli reports 1-based line/column (0 when unknown); VS Code is 0-based. */
export function toRange(line: number, column: number): vscode.Range {
  const l = Math.max(0, (line || 1) - 1);
  const c = Math.max(0, (column || 1) - 1);
  return new vscode.Range(l, c, l, c);
}

export function toSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (severity.toUpperCase()) {
    case "ERROR":
      return vscode.DiagnosticSeverity.Error;
    case "WARNING":
      return vscode.DiagnosticSeverity.Warning;
    case "INFO":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}
