import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { PlatformManager } from "./platformManager";
import { resolveSketch } from "./sketch";
import { prepareExecution } from "./profileMode";
import type { CompileDiagnostic, CompileDiagnosticRef } from "./proto/types";

/**
 * Runs `Compile` and surfaces compiler diagnostics in the Problems panel.
 *
 * Output (stdout/stderr) is mirrored to the shared output channel; the structured
 * `BuilderResult.diagnostics` are mapped into a DiagnosticCollection.
 */
/**
 * Structured summary of the most recent compile, for non-UI consumers (the LLM
 * `compile` tool). `output` is a tail of the captured stdout/stderr — present
 * even on failure, where `diagnostics` is empty (the daemon ends the stream with
 * an error and the structured result is lost, but the compiler text is not).
 */
export interface CompileReport {
  ok: boolean;
  label: string;
  fqbn?: string;
  diagnostics: CompileDiagnostic[];
  output: string;
}

export class Compiler {
  private readonly diagnostics: vscode.DiagnosticCollection;
  /** Fired after a successful compile (e.g. to refresh IntelliSense). */
  private afterSuccess?: () => void;
  /** Summary of the last `run()` that reached the compile step; for the LLM tool. */
  private lastReport: CompileReport | undefined;

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly platforms: PlatformManager,
    private readonly output: vscode.OutputChannel,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection("arduino");
  }

  /**
   * Register a hook run after each successful compile. Used to (re)configure
   * IntelliSense once the platform is installed and the instance is built —
   * notably the first compile of a profile sketch, which is what flips the
   * profile from "not ready" (IntelliSense deferred) to ready.
   */
  onCompiled(cb: () => void): void {
    this.afterSuccess = cb;
  }

  /** Structured summary of the last compile that reached the compile step. */
  getLastReport(): CompileReport | undefined {
    return this.lastReport;
  }

  /** Compile the resolved sketch for the selected board. Returns true on success. */
  async run(
    opts: { optimizeForDebug?: boolean; target?: vscode.Uri | string } = {},
  ): Promise<boolean> {
    // Cleared up front so a caller that reads getLastReport() after an early
    // exit (no sketch / no board) sees "did not compile", not a stale report.
    this.lastReport = undefined;
    const sketch = await resolveSketch(this.client, { target: opts.target });
    if (!sketch) {
      return false;
    }

    const exec = await prepareExecution(
      this.client, this.boards, sketch, this.platforms, this.output, "compile",
    );
    if (!exec) {
      return false;
    }
    if (!exec.fqbn) {
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("No board selected for this sketch."),
        vscode.l10n.t("Select Board"),
      );
      if (choice) {
        await this.boards.selectBoard();
      }
      return false;
    }

    const label = exec.profileMode
      ? `profile:${exec.profileName}`
      : (exec.fqbn as string);

    this.diagnostics.clear();
    this.output.show(true);
    this.output.appendLine(`\n[compile] ${label} — ${sketch.location_path}`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Compiling {0}…", label),
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        // Mirror stdout/stderr into a capture buffer too, so the LLM tool can
        // report the compiler errors — including on failure, where the daemon
        // ends the stream with an error and no structured result reaches us.
        const captured: string[] = [];
        const append = (s: string) => {
          this.output.append(s);
          captured.push(s);
        };
        try {
          const result = await this.client.compile(
            {
              // Profile mode: omit fqbn (the bound instance supplies it).
              ...(exec.profileMode ? {} : { fqbn: exec.fqbn }),
              sketch_path: sketch.location_path,
              ...(exec.instance ? { instance: exec.instance } : {}),
              ...(opts.optimizeForDebug ? { optimize_for_debug: true } : {}),
              ...(this.verbose() ? { verbose: true } : {}),
            },
            {
              out: append,
              err: append,
              progress: (t) =>
                progress.report({ message: t.message || t.name }),
            },
            ac.signal,
          );
          if (result?.diagnostics?.length) {
            this.applyDiagnostics(result.diagnostics);
          }
          this.lastReport = {
            ok: true,
            label,
            fqbn: exec.fqbn,
            diagnostics: result?.diagnostics ?? [],
            output: tail(captured.join("")),
          };
          vscode.window.showInformationMessage(
            vscode.l10n.t("Compilation finished."),
          );
          this.afterSuccess?.();
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[compile] cancelled");
            return false;
          }
          this.lastReport = {
            ok: false,
            label,
            fqbn: exec.fqbn,
            diagnostics: [],
            output: tail(captured.join("")),
          };
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

  private verbose(): boolean {
    return vscode.workspace.getConfiguration("arduinoCli").get<boolean>("verbose", false);
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
 * Map `CompileDiagnostic[]` -> vscode diagnostics grouped per file. Pure (no
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

/** Keep the last `max` characters — compiler output is most useful at the end. */
export function tail(text: string, max = 4000): string {
  return text.length > max ? "…" + text.slice(text.length - max) : text;
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
