import * as assert from "assert";
import * as vscode from "vscode";
import { buildDiagnostics, toRange, toSeverity } from "../compile";
import type { CompileDiagnostic } from "../proto/types";

suite("compile diagnostics mapping", () => {
  test("toRange converts 1-based line/column to 0-based", () => {
    const r = toRange(5, 8);
    assert.strictEqual(r.start.line, 4);
    assert.strictEqual(r.start.character, 7);
  });

  test("toRange clamps unknown (0) line/column to 0", () => {
    const r = toRange(0, 0);
    assert.strictEqual(r.start.line, 0);
    assert.strictEqual(r.start.character, 0);
  });

  test("toSeverity maps strings, defaulting to Error", () => {
    assert.strictEqual(toSeverity("ERROR"), vscode.DiagnosticSeverity.Error);
    assert.strictEqual(toSeverity("warning"), vscode.DiagnosticSeverity.Warning);
    assert.strictEqual(toSeverity("INFO"), vscode.DiagnosticSeverity.Information);
    assert.strictEqual(toSeverity("weird"), vscode.DiagnosticSeverity.Error);
  });

  test("groups diagnostics per file and attaches related info", () => {
    const diags: CompileDiagnostic[] = [
      {
        severity: "ERROR",
        message: "expected ';'",
        file: "/sketch/Blink.ino",
        line: 10,
        column: 3,
        context: [],
        notes: [
          {
            message: "declared here",
            file: "/sketch/Blink.ino",
            line: 4,
            column: 1,
          },
        ],
      },
      {
        severity: "WARNING",
        message: "unused variable",
        file: "/sketch/other.cpp",
        line: 2,
        column: 1,
        context: [],
        notes: [],
      },
      {
        severity: "ERROR",
        message: "general error, no file",
        file: "",
        line: 0,
        column: 0,
        context: [],
        notes: [],
      },
    ];

    const byFile = buildDiagnostics(diags);
    assert.strictEqual(byFile.size, 2, "fileless diagnostic is skipped");

    const ino = byFile.get("/sketch/Blink.ino")!;
    assert.strictEqual(ino.length, 1);
    assert.strictEqual(ino[0].severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(ino[0].source, "arduino-cli");
    assert.strictEqual(ino[0].range.start.line, 9);
    assert.strictEqual(ino[0].relatedInformation?.length, 1);
    assert.strictEqual(ino[0].relatedInformation![0].location.range.start.line, 3);

    const cpp = byFile.get("/sketch/other.cpp")!;
    assert.strictEqual(cpp[0].severity, vscode.DiagnosticSeverity.Warning);
  });
});
