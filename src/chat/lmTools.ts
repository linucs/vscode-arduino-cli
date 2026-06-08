import * as vscode from "vscode";
import { resolveSketch } from "../sketch";
import type { Deps } from "../extension";

/**
 * GitHub Copilot integration: a small set of `vscode.lm` Language Model Tools
 * that let the Copilot agent drive arduino-cli through the live, in-process
 * client the rest of the extension already uses (via `ensureReady()`).
 *
 * Scope is deliberately lean — the diagnose → fix → flash → verify loop plus the
 * board/library/core state the agent can't otherwise see. Everything the agent
 * can already do by shelling out to `arduino-cli` is left to the CLI.
 *
 * Strings here are English by design: tool/model-facing text isn't localized
 * (the manifest declares the same tools with English `displayName`/
 * `modelDescription`; see `contributes.languageModelTools` in package.json).
 *
 * NOTE: each tool below must also be declared statically in package.json under
 * `contributes.languageModelTools` (name + input schema) — VS Code requires it
 * and it cannot be generated at runtime, so keep the two in sync.
 */

/** Hooks back into the extension so a mutating tool refreshes the same UI a command would. */
export interface ToolHooks {
  afterLibraryChange(d: Deps): Promise<void>;
  afterPlatformChange(d: Deps): Promise<void>;
}

interface ToolDef {
  /** Suffix after the `arduino-cli-` id prefix. */
  name: string;
  /** Confirmation prompt for mutating tools (Copilot `prepareInvocation`). */
  confirm?: (input: Record<string, unknown>) => { title: string; message: string };
  run(input: Record<string, unknown>, deps: Deps, hooks: ToolHooks): Promise<string>;
}

const PREFIX = "arduino-cli-";

const str = (v: unknown): string =>
  v === undefined || v === null ? "" : String(v);

const TOOLS: ToolDef[] = [
  {
    name: "build-status",
    run: async (_input, deps) => {
      const sel = deps.boards.selectionInfo;
      const lines: string[] = [];

      let profileNote = "";
      try {
        const sketch = await resolveSketch(deps.client, { silent: true });
        if (sketch?.default_profile?.name) {
          profileNote = ` (profile mode: ${sketch.default_profile.name}, fqbn ${
            sketch.default_profile.fqbn || "—"
          })`;
        }
      } catch {
        /* no resolvable sketch — fine */
      }

      lines.push(
        sel
          ? `Selected board: ${sel.boardName} [${sel.fqbn}]${
              sel.portAddress ? ` on ${sel.portAddress}` : " (no port)"
            }${profileNote}`
          : `No board selected${profileNote || " (run the Select Board command, or it comes from sketch.yaml)"}`,
      );

      try {
        const ps = await deps.client.platformSearch("");
        const installed = (ps.search_output ?? []).filter((p) => p.installed_version);
        lines.push(
          "",
          `Installed cores (${installed.length}):`,
          ...installed.map((p) => `  ${p.metadata.id} ${p.installed_version}`),
        );
      } catch {
        lines.push("", "Installed cores: (unavailable)");
      }

      try {
        const ll = await deps.client.libraryList({});
        const libs = ll.installed_libraries ?? [];
        lines.push(
          "",
          `Installed libraries (${libs.length}):`,
          ...libs.slice(0, 100).map((l) => `  ${l.library.name} ${l.library.version}`),
        );
      } catch {
        lines.push("", "Installed libraries: (unavailable)");
      }

      const cpp = await vscode.workspace.findFiles(
        "**/c_cpp_properties.json",
        "**/node_modules/**",
        1,
      );
      lines.push(
        "",
        `IntelliSense configured: ${cpp.length ? "yes" : "no (run the Configure IntelliSense command)"}`,
      );

      return lines.join("\n");
    },
  },
  {
    name: "compile",
    run: async (input, deps) => {
      const ok = await deps.compiler.run({ target: optTarget(input) });
      const r = deps.compiler.getLastReport();
      if (!r) {
        return "Compile did not run. Open or pass a sketch and select a board (see the build-status tool).";
      }
      const lines: string[] = [
        ok ? `Compile SUCCEEDED (${r.label}).` : `Compile FAILED (${r.label}).`,
      ];
      if (r.fqbn) {
        lines.push(`FQBN: ${r.fqbn}`);
      }
      if (r.diagnostics.length) {
        lines.push("", "Diagnostics:");
        for (const d of r.diagnostics.slice(0, 50)) {
          lines.push(`  [${d.severity}] ${d.file}:${d.line}:${d.column}: ${d.message}`);
        }
      }
      if (!ok && r.output) {
        lines.push("", "Compiler output (tail):", r.output);
      }
      return lines.join("\n");
    },
  },
  {
    name: "board-search",
    run: async (input, deps) => {
      const query = str(input.query);
      const res = await deps.client.boardSearch(query);
      const boards = res.boards ?? [];
      if (!boards.length) {
        return `No boards found for "${query}".`;
      }
      return boards
        .slice(0, 30)
        .map((b) => `${b.name} — ${b.fqbn}`)
        .join("\n");
    },
  },
  {
    name: "board-details",
    run: async (input, deps) => {
      const fqbn = str(input.fqbn);
      const res = await deps.client.boardDetails(fqbn);
      const lines: string[] = [
        `${res.name} (${res.fqbn})`,
        `Platform: ${res.platform?.name ?? "—"} ${res.version}`.trim(),
      ];
      const opts = (res.config_options ?? []).filter((o) => o.values.length > 1);
      if (opts.length) {
        lines.push("", "Config options:");
        for (const o of opts) {
          lines.push(`  ${o.option} (${o.option_label}): ${o.values.map((v) => v.value).join(", ")}`);
        }
      }
      if (res.programmers?.length) {
        lines.push("", "Programmers: " + res.programmers.map((p) => p.id).join(", "));
      }
      return lines.join("\n");
    },
  },
  {
    name: "library-search",
    run: async (input, deps) => {
      const query = str(input.query);
      const res = await deps.client.librarySearch(query);
      const libs = res.libraries ?? [];
      if (!libs.length) {
        return `No libraries found for "${query}".`;
      }
      return libs
        .slice(0, 30)
        .map((l) => {
          const latest =
            l.latest ?? l.releases[l.available_versions[l.available_versions.length - 1]];
          return `${l.name} (latest ${latest?.version ?? "?"}) — ${latest?.sentence ?? ""}`.trim();
        })
        .join("\n");
    },
  },
  {
    name: "library-install",
    confirm: (input) => ({
      title: "Install Arduino library",
      message: `Install library \`${str(input.name)}\`${
        input.version ? " " + str(input.version) : ""
      }?`,
    }),
    run: async (input, deps, hooks) => {
      const name = str(input.name);
      await deps.client.libraryInstall(
        {
          name,
          version: input.version ? str(input.version) : undefined,
          no_deps: Boolean(input.no_deps),
        },
        () => {},
      );
      await hooks.afterLibraryChange(deps);
      return `Installed library ${name}${input.version ? " " + str(input.version) : ""}.`;
    },
  },
  {
    name: "platform-install",
    confirm: (input) => ({
      title: "Install Arduino core",
      message: `Install core \`${str(input.platform_package)}:${str(input.architecture)}\`${
        input.version ? " " + str(input.version) : ""
      }?`,
    }),
    run: async (input, deps, hooks) => {
      const pkg = str(input.platform_package);
      const arch = str(input.architecture);
      await deps.client.platformInstall(
        {
          platform_package: pkg,
          architecture: arch,
          version: input.version ? str(input.version) : undefined,
        },
        () => {},
      );
      await hooks.afterPlatformChange(deps);
      return `Installed core ${pkg}:${arch}.`;
    },
  },
  {
    name: "upload",
    confirm: () => ({
      title: "Upload to board",
      message: "Compile and upload the sketch to the connected board?",
    }),
    run: async (input, deps) => {
      const target = optTarget(input);
      const compiled = await deps.compiler.run({ target });
      if (!compiled) {
        const r = deps.compiler.getLastReport();
        return "Upload aborted — compile failed.\n" + (r?.output ?? "");
      }
      const ok = await deps.monitor.runWithMonitorSuspended(() =>
        deps.uploader.run(target),
      );
      return ok ? "Upload complete." : "Upload failed:\n" + deps.uploader.getLastOutput();
    },
  },
];

/** Optional sketch path/URI from a tool input (else the active editor is used). */
function optTarget(input: Record<string, unknown>): string | undefined {
  return input.sketch_path ? str(input.sketch_path) : undefined;
}

/** Generic adapter turning a {@link ToolDef} into a `vscode.LanguageModelTool`. */
class ArduinoLmTool implements vscode.LanguageModelTool<Record<string, unknown>> {
  constructor(
    private readonly def: ToolDef,
    private readonly getDeps: () => Promise<Deps>,
    private readonly hooks: ToolHooks,
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation | undefined> {
    if (!this.def.confirm) {
      return undefined;
    }
    const c = this.def.confirm(options.input ?? {});
    return {
      invocationMessage: c.title,
      confirmationMessages: {
        title: c.title,
        message: new vscode.MarkdownString(c.message),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const deps = await this.getDeps();
      const text = await this.def.run(options.input ?? {}, deps, this.hooks);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    } catch (err) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "Error: " + (err instanceof Error ? err.message : String(err)),
        ),
      ]);
    }
  }
}

/**
 * Register every tool with `vscode.lm`. `getDeps` resolves the live, ready
 * managers (i.e. `ensureReady()`), so tools always use the current client even
 * across daemon restarts. The static manifest declaration in package.json must
 * stay in sync with {@link TOOLS}.
 */
export function registerArduinoLmTools(
  getDeps: () => Promise<Deps>,
  hooks: ToolHooks,
): vscode.Disposable[] {
  return TOOLS.map((def) =>
    vscode.lm.registerTool(PREFIX + def.name, new ArduinoLmTool(def, getDeps, hooks)),
  );
}
