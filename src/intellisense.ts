import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import { resolveSketch } from "./sketch";
import { resolveExecution } from "./profileMode";

const CPPTOOLS_EXT = "ms-vscode.cpptools";
const CONFIG_NAME = "Arduino";

/** Flags extracted from a single compile_commands.json entry. */
export interface ParsedCommand {
  includes: string[];
  defines: string[];
  compilerPath: string;
  /** e.g. "gnu++17" / "c++17", or "" if none. */
  std: string;
  /** Target/arch flags (-mcpu, -mthumb, -march, …) for the compiler query. */
  compilerArgs: string[];
}

interface CompileCommandEntry {
  directory: string;
  command?: string;
  arguments?: string[];
  file: string;
}

/**
 * Generates a cpptools `c_cpp_properties.json` for the current sketch from
 * arduino-cli's compilation database, so IntelliSense resolves the Arduino core,
 * the board's defines, and every library the sketch includes — none of which are
 * visible from the `.ino` alone. arduino-cli is the source of truth: we run a
 * compilation-database-only build and translate its flags.
 */
export class IntelliSenseManager {
  private seq = 0;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cpptoolsHintShown = false;
  /** Per-file cache of `#include` sets, to gate the on-save regen trigger. */
  private readonly includeCache = new Map<string, string>();

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Debounced silent reconfigure, for board/library/include-change triggers. */
  scheduleConfigure(): void {
    if (!this.autoEnabled()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.configure({ silent: true }), 750);
  }

  /**
   * Regenerate when a saved sketch file's `#include` set changed — catches
   * adding an include for an already-installed library (no other trigger fires).
   */
  onDidSave(doc: vscode.TextDocument): void {
    if (!/\.(ino|h|hpp|cpp|c)$/i.test(doc.fileName)) {
      return;
    }
    const set = [...parseIncludeSet(doc.getText())].sort().join("\n");
    if (this.includeCache.get(doc.fileName) === set) {
      return;
    }
    this.includeCache.set(doc.fileName, set);
    this.scheduleConfigure();
  }

  /**
   * Generate the compilation database and write `c_cpp_properties.json`.
   * `silent` suppresses user-facing warnings (used by auto-triggers).
   */
  async configure(opts: { silent?: boolean } = {}): Promise<void> {
    const sketch = await resolveSketch(this.client, { silent: opts.silent });
    if (!sketch) {
      return;
    }
    // Mirror the compiler's mode so the compilation database resolves the same
    // resources: profile mode runs through the profile-bound instance (no fqbn),
    // global mode keeps an explicit fqbn on the global instance.
    // Never trigger the profile's platform download from IntelliSense (it runs
    // automatically): only reuse an already-built profile instance. The first
    // Compile installs the platform; a later configure picks it up.
    const exec = await resolveExecution(this.client, this.boards, sketch, {
      create: false,
    });
    const fqbn = exec.fqbn;
    if (!exec.profileMode && !fqbn) {
      if (!opts.silent) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Select a board before configuring IntelliSense."),
        );
      }
      return;
    }
    if (exec.profileMode && !exec.profileReady) {
      this.output.appendLine(
        "[intellisense] profile platform not installed yet — will configure after the first compile",
      );
      return;
    }

    if (!opts.silent) {
      this.maybeHintCpptools();
    }

    // Key the build dir by profile (not fqbn) in profile mode so the profile and
    // global compilation databases don't collide.
    const buildKey = exec.profileMode ? `profile:${exec.profileName}` : fqbn!;
    const buildPath = this.buildPathFor(sketch.location_path, buildKey);
    const mySeq = ++this.seq;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;

    try {
      await vscode.window.withProgress(
        {
          location: opts.silent
            ? vscode.ProgressLocation.Window
            : vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Configuring IntelliSense…"),
        },
        () =>
          this.client.compile(
            {
              // Profile mode: omit fqbn (the bound instance supplies it).
              ...(exec.profileMode ? {} : { fqbn }),
              sketch_path: sketch.location_path,
              build_path: buildPath,
              create_compilation_database_only: true,
              ...(exec.instance ? { instance: exec.instance } : {}),
            },
            {
              out: (s) => this.output.append(s),
              err: (s) => this.output.append(s),
            },
            ac.signal,
          ),
      );
    } catch (err) {
      if (ac.signal.aborted || mySeq !== this.seq) {
        return;
      }
      this.output.appendLine(
        `[intellisense] compile-db failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!opts.silent) {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Could not configure IntelliSense — see the Arduino CLI output."),
        );
      }
      return;
    }

    if (mySeq !== this.seq) {
      return; // superseded by a newer run
    }

    const dbPath = path.join(buildPath, "compile_commands.json");
    let entries: CompileCommandEntry[];
    try {
      entries = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    } catch (err) {
      this.output.appendLine(
        `[intellisense] could not read ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const entry = pickSketchEntry(entries);
    if (!entry) {
      this.output.appendLine("[intellisense] no sketch entry in compile_commands.json");
      return;
    }

    const parsed = parseCompileCommand(entry);
    const forced = resolveForcedInclude(entry, parsed.includes);
    const config = buildCppProperties(parsed, forced);

    this.writeConfig(sketch.location_path, config);
    this.output.appendLine(
      `[intellisense] wrote c_cpp_properties.json (${parsed.includes.length} include paths, ${parsed.defines.length} defines)`,
    );
    if (!opts.silent) {
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          "IntelliSense configured for {0}.",
          exec.profileMode ? exec.profileName! : fqbn!,
        ),
      );
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.abort?.abort();
  }

  // --- internals -------------------------------------------------------------

  private autoEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("arduinoCli")
      .get<boolean>("intellisense.autoConfigure", true);
  }

  private buildPathFor(sketchPath: string, key: string): string {
    const hash = crypto
      .createHash("sha1")
      .update(`${sketchPath}::${key}`)
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(
      this.context.globalStorageUri.fsPath,
      "intellisense",
      hash,
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private writeConfig(
    sketchPath: string,
    arduinoConfig: Record<string, unknown>,
  ): void {
    const folder =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sketchPath)) ??
      vscode.workspace.workspaceFolders?.[0];
    const root = folder?.uri.fsPath ?? path.dirname(sketchPath);
    const vscodeDir = path.join(root, ".vscode");
    fs.mkdirSync(vscodeDir, { recursive: true });
    const file = path.join(vscodeDir, "c_cpp_properties.json");

    let existing: { version?: number; configurations?: Record<string, unknown>[] } = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // no existing file (or unparseable) — start fresh
    }
    const merged = mergeConfiguration(existing, arduinoConfig);
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  }

  private maybeHintCpptools(): void {
    if (this.cpptoolsHintShown) {
      return;
    }
    if (vscode.extensions.getExtension(CPPTOOLS_EXT)) {
      return;
    }
    this.cpptoolsHintShown = true;
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t(
          "IntelliSense uses the C/C++ extension, which isn't installed.",
        ),
        vscode.l10n.t("Install"),
      )
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            CPPTOOLS_EXT,
          );
        }
      });
  }
}

// --- pure helpers (unit-testable) -------------------------------------------

/**
 * Split a compiler command string into argv, honoring quotes that appear
 * anywhere in a token (e.g. `-I"/Program Files/x"` → `-I/Program Files/x`).
 */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const c of command) {
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) {
    out.push(cur);
  }
  return out;
}

/**
 * Tokenize the contents of a GCC `@response-file`: whitespace separates tokens,
 * single/double quotes group, and a backslash escapes the next character — so
 * `-DVER=\"1.2\"` becomes the single token `-DVER="1.2"`. The backslash handling
 * is why this can't reuse {@link tokenize} (which is for shell-style commands).
 */
export function tokenizeResponseFile(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      started = true;
    } else if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) {
    out.push(cur);
  }
  return out;
}

/**
 * Expand GCC `@file` response-file arguments in place. `@file` tells the compiler
 * to read that file and substitute its whitespace-separated contents as if they
 * appeared on the command line — a standard GCC feature (not specific to any
 * core) used to pass more flags than the OS command-length limit allows. The
 * esp32 core relies on it for its whole SDK: hundreds of include dirs live in
 * `flags/includes` and its defines (including `ESP_PLATFORM`) in `flags/defines`.
 * Without expansion those are invisible to us, so IntelliSense misses the
 * platform's includes/defines and takes wrong `#ifdef` branches.
 *
 * Nested `@file`s expand recursively (depth-guarded); an unreadable file is left
 * as its literal token, matching GCC (which treats a missing `@file` literally).
 * `readFile` is injectable for tests.
 */
export function expandResponseFiles(
  argv: string[],
  baseDir: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  depth = 0,
): string[] {
  if (depth > 16) {
    return argv; // cycle / abuse guard
  }
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.length > 1 && arg.startsWith("@")) {
      const ref = arg.slice(1);
      const file = path.isAbsolute(ref) ? ref : path.join(baseDir, ref);
      let content: string;
      try {
        content = readFile(file);
      } catch {
        out.push(arg); // unreadable — leave literal (GCC semantics)
        continue;
      }
      out.push(
        ...expandResponseFiles(
          tokenizeResponseFile(content),
          path.dirname(file),
          readFile,
          depth + 1,
        ),
      );
    } else {
      out.push(arg);
    }
  }
  return out;
}

/**
 * Extract include dirs, defines, compiler path and -std from a DB entry.
 *
 * `@response-file` args are expanded first (see {@link expandResponseFiles}), and
 * the GCC `-iprefix` + `-iwithprefixbefore`/`-iwithprefix` include mechanism is
 * resolved — both standard compiler features the esp32 core uses to inject its
 * SDK includes/defines. Plain `-I`/`-isystem`/`-D` still work unchanged.
 * `readFile` is injectable for tests.
 */
export function parseCompileCommand(
  entry: CompileCommandEntry,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): ParsedCommand {
  const raw = entry.arguments ?? tokenize(entry.command ?? "");
  const argv = expandResponseFiles(raw, entry.directory ?? "", readFile);
  const includes: string[] = [];
  const defines: string[] = [];
  const compilerArgs: string[] = [];
  const compilerPath = argv[0] ?? "";
  let std = "";
  // Set by `-iprefix`; each following `-iwithprefix[before] dir` resolves against
  // it (GCC concatenates literally), e.g. `.../include/` + `freertos/...`.
  let prefix = "";
  const withPrefix = (dir: string): string => path.normalize(prefix + dir);

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-I" || a === "-isystem" || a === "-iquote") {
      if (argv[i + 1]) {
        includes.push(argv[++i]);
      }
    } else if (a === "-iprefix") {
      prefix = argv[++i] ?? prefix;
    } else if (a === "-iwithprefixbefore" || a === "-iwithprefix") {
      if (argv[i + 1]) {
        includes.push(withPrefix(argv[++i]));
      }
    } else if (a.startsWith("-iwithprefixbefore")) {
      includes.push(withPrefix(a.slice("-iwithprefixbefore".length)));
    } else if (a.startsWith("-iwithprefix")) {
      includes.push(withPrefix(a.slice("-iwithprefix".length)));
    } else if (a.startsWith("-iprefix")) {
      prefix = a.slice("-iprefix".length);
    } else if (a.startsWith("-isystem")) {
      includes.push(a.slice(8));
    } else if (a.startsWith("-iquote")) {
      includes.push(a.slice("-iquote".length));
    } else if (a.startsWith("-I")) {
      includes.push(a.slice(2));
    } else if (a === "-D") {
      if (argv[i + 1]) {
        defines.push(argv[++i]);
      }
    } else if (a.startsWith("-D")) {
      defines.push(a.slice(2));
    } else if (a.startsWith("-std=")) {
      std = a.slice(5);
    } else if (/^-m/.test(a) || a.startsWith("-march")) {
      // Target/arch flags so cpptools queries the right multilib + ARM defines.
      compilerArgs.push(a);
    }
  }

  // De-dupe include dirs while preserving order.
  const seen = new Set<string>();
  const uniqueIncludes = includes.filter((i) =>
    seen.has(i) ? false : (seen.add(i), true),
  );

  return { includes: uniqueIncludes, defines, compilerPath, std, compilerArgs };
}

/** Choose the entry for the sketch's generated translation unit. */
export function pickSketchEntry(
  entries: CompileCommandEntry[],
): CompileCommandEntry | undefined {
  return (
    entries.find((e) => e.file?.endsWith(".ino.cpp")) ??
    entries.find((e) => /\.(cpp|cc|cxx)$/.test(e.file ?? "")) ??
    entries[0]
  );
}

/** Header names `#include`d by the given source text (angle + quote forms). */
export function parseIncludeSet(text: string): Set<string> {
  const set = new Set<string>();
  const re = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    set.add(m[1]);
  }
  return set;
}

/**
 * Discover the header the Arduino preprocessor injected into the generated TU
 * (the first `#include`), resolved to an absolute path against the include dirs.
 * Falls back to scanning the include dirs for `Arduino.h`.
 */
export function resolveForcedInclude(
  entry: CompileCommandEntry,
  includes: string[],
): string | undefined {
  let header: string | undefined;
  try {
    const file = path.isAbsolute(entry.file)
      ? entry.file
      : path.join(entry.directory ?? "", entry.file);
    const text = fs.readFileSync(file, "utf8");
    const first = [...parseIncludeSet(text)][0];
    header = first;
  } catch {
    // unreadable TU — fall through to the Arduino.h fallback
  }
  const candidate = header ?? "Arduino.h";
  for (const dir of includes) {
    const abs = path.join(dir, candidate);
    if (fs.existsSync(abs)) {
      return abs;
    }
  }
  // Last resort: look specifically for Arduino.h anywhere in the include dirs.
  if (candidate !== "Arduino.h") {
    for (const dir of includes) {
      const abs = path.join(dir, "Arduino.h");
      if (fs.existsSync(abs)) {
        return abs;
      }
    }
  }
  return undefined;
}

/** Build the cpptools "Arduino" configuration object from parsed flags. */
export function buildCppProperties(
  parsed: ParsedCommand,
  forcedInclude: string | undefined,
): Record<string, unknown> {
  const isCpp = parsed.std.includes("++");
  const config: Record<string, unknown> = {
    name: CONFIG_NAME,
    includePath: [...parsed.includes, "${workspaceFolder}/**"],
    defines: parsed.defines,
    compilerPath: parsed.compilerPath,
    cStandard: "gnu11",
    cppStandard: isCpp ? parsed.std : "gnu++17",
  };
  // Omit intelliSenseMode so cpptools infers it (e.g. gcc-arm) from compilerPath
  // rather than defaulting to the host's (clang-x64 on macOS).
  if (parsed.compilerArgs.length) {
    config.compilerArgs = parsed.compilerArgs;
  }
  if (forcedInclude) {
    config.forcedInclude = [forcedInclude];
  }
  return config;
}

/** Insert/replace the "Arduino" configuration, preserving any others. */
export function mergeConfiguration(
  existing: { version?: number; configurations?: Record<string, unknown>[] },
  arduinoConfig: Record<string, unknown>,
): { version: number; configurations: Record<string, unknown>[] } {
  const configurations = Array.isArray(existing.configurations)
    ? existing.configurations.filter((c) => c?.name !== CONFIG_NAME)
    : [];
  configurations.unshift(arduinoConfig);
  return { version: existing.version ?? 4, configurations };
}
