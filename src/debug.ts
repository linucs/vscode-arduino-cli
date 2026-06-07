import * as path from "node:path";
import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { SerialMonitor } from "./serialMonitor";
import { resolveSketch } from "./sketch";
import { resolveExecution } from "./profileMode";
import type {
  GetDebugConfigResponse,
  OpenOCDServerConfig,
  ProtoAny,
} from "./proto/types";

const EXT_CORTEX_DEBUG = "marus25.cortex-debug";
const EXT_CPPTOOLS = "ms-vscode.cpptools";
/** Name tagged on sessions we launch, so the monitor only resumes for ours. */
export const DEBUG_SESSION_NAME = "Arduino Debug";
/** Default GDB port openocd listens on. Overridable via adapterConfig. */
const GDB_PORT = 3333;

// --- Adapter translators -----------------------------------------------------

interface TranslatorContext {
  debugConfig: GetDebugConfigResponse;
  /** Decoded server config (openocd). Undefined for unknown server types. */
  serverConfig?: OpenOCDServerConfig;
  server: string;
  gdbPath: string;
  sketchPath: string;
  fqbn: string;
}

type AdapterTranslator = (ctx: TranslatorContext) => vscode.DebugConfiguration;

/**
 * cortex-debug (marus25.cortex-debug). It launches the GDB server itself from
 * `servertype` + `configFiles`, so we just hand it the toolchain + openocd info.
 */
function translateCortexDebug(ctx: TranslatorContext): vscode.DebugConfiguration {
  const { debugConfig: d, serverConfig } = ctx;
  return {
    type: "cortex-debug",
    request: "launch",
    name: DEBUG_SESSION_NAME,
    cwd: "${workspaceFolder}",
    executable: d.executable,
    servertype: d.server,
    serverpath: d.server_path || undefined,
    armToolchainPath: d.toolchain_path || undefined,
    toolchainPrefix: d.toolchain_prefix || undefined,
    gdbPath: ctx.gdbPath || undefined,
    svdFile: d.svd_file || undefined,
    ...(serverConfig
      ? {
          configFiles: serverConfig.scripts,
          searchDir: serverConfig.scripts_dir
            ? [serverConfig.scripts_dir]
            : undefined,
        }
      : {}),
  };
}

/**
 * cppdbg (ms-vscode.cpptools). The generic fallback. Critically, GetDebugConfig
 * does NOT start the GDB server and cppdbg does not start one on its own, so for
 * openocd we make cppdbg launch it via debugServerPath/debugServerArgs. For
 * non-openocd servers we fall back to attach-mode and tell the user.
 */
function translateCppdbg(ctx: TranslatorContext): vscode.DebugConfiguration {
  const { debugConfig: d, serverConfig, server, gdbPath } = ctx;
  const base: vscode.DebugConfiguration = {
    type: "cppdbg",
    request: "launch",
    name: DEBUG_SESSION_NAME,
    cwd: "${workspaceFolder}",
    program: d.executable,
    MIMode: "gdb",
    miDebuggerPath: gdbPath || undefined,
    setupCommands: [
      { text: "-enable-pretty-printing", ignoreFailures: true },
      { text: `target remote localhost:${GDB_PORT}`, ignoreFailures: false },
      { text: "monitor reset halt", ignoreFailures: true },
      { text: "load", ignoreFailures: false },
      { text: "monitor reset halt", ignoreFailures: true },
    ],
  };

  if (server === "openocd" && serverConfig) {
    // Have cppdbg start openocd and wait until it's listening for GDB.
    const args: string[] = [];
    if (serverConfig.scripts_dir) {
      args.push("-s", serverConfig.scripts_dir);
    }
    for (const script of serverConfig.scripts) {
      args.push("-f", script);
    }
    args.push("-c", `gdb_port ${GDB_PORT}`);
    return {
      ...base,
      debugServerPath: serverConfig.path || d.server_path,
      debugServerArgs: args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
      serverStarted: "Listening on port \\d+ for gdb connections",
      filterStderr: true,
    };
  }

  // Unknown server: attach to an already-running gdbserver (user must start it).
  return {
    ...base,
    miDebuggerServerAddress: `localhost:${GDB_PORT}`,
  };
}

const TRANSLATORS = new Map<string, AdapterTranslator>([
  ["cortex-debug", translateCortexDebug],
  ["cppdbg", translateCppdbg],
]);

// --- Utilities ---------------------------------------------------------------

/** Build the path to the toolchain's gdb, honoring Windows' .exe suffix. */
function resolveGdbPath(toolchainPath: string, toolchainPrefix: string): string {
  if (!toolchainPath || !toolchainPrefix) {
    return "";
  }
  const exe = process.platform === "win32" ? ".exe" : "";
  return path.join(toolchainPath, `${toolchainPrefix}-gdb${exe}`);
}

/** Normalize a proto bytes value (Buffer | {type:"Buffer",data} | base64) to a Buffer. */
function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) {
    return v;
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v);
  }
  if (typeof v === "string") {
    return Buffer.from(v, "base64");
  }
  if (
    v &&
    typeof v === "object" &&
    (v as { type?: string }).type === "Buffer" &&
    Array.isArray((v as { data?: number[] }).data)
  ) {
    return Buffer.from((v as { data: number[] }).data);
  }
  return Buffer.alloc(0);
}

/**
 * Minimal protobuf wire decoder for DebugOpenOCDServerConfiguration
 * (field 1: string path, field 2: string scripts_dir, field 3: repeated string).
 * proto-loader does not unpack google.protobuf.Any, so we decode the bytes here.
 * Unknown fields/wire-types are skipped so the parse stays robust across versions.
 */
function decodeOpenOCD(buf: Buffer): OpenOCDServerConfig {
  const res: OpenOCDServerConfig = { path: "", scripts_dir: "", scripts: [] };
  let i = 0;
  const readVarint = (): number => {
    let shift = 0;
    let result = 0;
    while (i < buf.length) {
      const b = buf[i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    return result;
  };
  while (i < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 2) {
      const len = readVarint();
      const str = buf.subarray(i, i + len).toString("utf-8");
      i += len;
      if (field === 1) {
        res.path = str;
      } else if (field === 2) {
        res.scripts_dir = str;
      } else if (field === 3) {
        res.scripts.push(str);
      }
    } else if (wire === 0) {
      readVarint();
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return res;
}

/** Decode the server_configuration Any, if it's the known openocd type. */
function decodeServerConfiguration(
  any: ProtoAny | undefined,
  output: vscode.OutputChannel,
): OpenOCDServerConfig | undefined {
  if (!any?.type_url) {
    return undefined;
  }
  const typeName = any.type_url.split("/").pop() ?? "";
  if (typeName.endsWith("DebugOpenOCDServerConfiguration")) {
    // Some loader configs may already surface the decoded fields.
    const maybe = any as unknown as Partial<OpenOCDServerConfig>;
    if (Array.isArray(maybe.scripts) || typeof maybe.path === "string") {
      return {
        path: maybe.path ?? "",
        scripts_dir: maybe.scripts_dir ?? "",
        scripts: maybe.scripts ?? [],
      };
    }
    return decodeOpenOCD(toBuffer(any.value));
  }
  output.appendLine(`[debug] unknown server_configuration type: ${typeName}`);
  return undefined;
}

/** Deep-merge `override` onto `base` (override wins; arrays replaced wholesale). */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      out[k] = deepMerge(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Substitute ${var} placeholders in a custom template from the debug config. */
function substituteVariables(
  template: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof template === "string") {
    return template.replace(/\$\{(\w+)\}/g, (m, name) =>
      name in vars ? vars[name] : m,
    );
  }
  if (Array.isArray(template)) {
    return template.map((t) => substituteVariables(t, vars));
  }
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = substituteVariables(v, vars);
    }
    return out;
  }
  return template;
}

// --- DebugManager ------------------------------------------------------------

export class DebugManager implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly monitor: SerialMonitor,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Command entry point: resolve config, suspend monitor, launch the session. */
  async startDebug(target?: vscode.Uri | string): Promise<void> {
    const result = await this.buildConfiguration({ target });
    if (!result) {
      return;
    }
    const { built, sketchPath } = result;
    // Resolve ${workspaceFolder} against the root that actually contains the
    // sketch — in a multi-root workspace the sketch may live outside the first
    // root. Fall back to the first root, then the sketch's own folder.
    const folder =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sketchPath)) ??
      vscode.workspace.workspaceFolders?.[0];
    this.output.appendLine(
      `[debug] launching ${built.type}:\n${JSON.stringify(built, null, 2)}`,
    );
    this.monitor.suspendForDebug();
    const started = await vscode.debug.startDebugging(folder, built);
    if (!started) {
      // Launch failed outright — restore the monitor immediately.
      await this.monitor.resumeAfterDebug();
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not start the debug session."),
      );
    }
  }

  /** Command: show the raw GetDebugConfig and the translated launch config. */
  async showDebugConfig(): Promise<void> {
    const ctx = await this.resolveContext();
    if (!ctx) {
      return;
    }
    const translated = this.translate(ctx);
    const content = JSON.stringify(
      { raw: ctx.debugConfig, serverConfig: ctx.serverConfig, launch: translated },
      null,
      2,
    );
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: "json",
    });
    await vscode.window.showTextDocument(doc);
  }

  /** Update the `arduinoCli.debugSupported` context key for the given board. */
  async updateDebugSupported(fqbn: string | undefined, port?: object): Promise<void> {
    let supported = false;
    if (fqbn) {
      try {
        const res = await this.client.isDebugSupported({ fqbn, port });
        supported = res.debugging_supported;
      } catch {
        supported = false;
      }
    }
    await vscode.commands.executeCommand(
      "setContext",
      "arduinoCli.debugSupported",
      supported,
    );
  }

  // --- DebugConfigurationProvider hooks --------------------------------------

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      { type: "arduino", request: "launch", name: DEBUG_SESSION_NAME },
    ];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    // Only handle our own type; let other providers pass through.
    if (config.type !== "arduino") {
      return config;
    }
    const result = await this.buildConfiguration({
      fqbn: config.fqbn,
      programmer: config.programmer,
    });
    if (!result) {
      return undefined; // abort the launch
    }
    this.monitor.suspendForDebug();
    return result.built;
  }

  // --- internals -------------------------------------------------------------

  /** Resolve the debug context (sketch, board, GetDebugConfig, decoded server). */
  private async resolveContext(overrides?: {
    fqbn?: string;
    programmer?: string;
    target?: vscode.Uri | string;
  }): Promise<TranslatorContext | undefined> {
    const sketch = await resolveSketch(this.client, { target: overrides?.target });
    if (!sketch) {
      return undefined;
    }
    // Profile mode: board + instance come from the profile (overrides still win
    // when explicitly passed). Global mode: status-bar selection or default_fqbn.
    // Don't let debugging silently start the profile's platform download — that
    // belongs to Compile (with progress). Require the profile to be built first.
    const exec = await resolveExecution(this.client, this.boards, sketch, {
      create: false,
    });
    const fqbn = overrides?.fqbn || exec.fqbn;
    if (!fqbn) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("No board selected for this sketch."),
      );
      return undefined;
    }
    if (exec.profileMode && !exec.profileReady) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Compile the sketch once to set up its profile before debugging.",
        ),
      );
      return undefined;
    }

    const port = this.boards.port?.address ? this.boards.port : undefined;
    const instance = exec.instance;

    const support = await this.client.isDebugSupported({
      fqbn,
      port,
      ...(instance ? { instance } : {}),
    });
    if (!support.debugging_supported) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Debugging is not supported for {0}.", fqbn),
      );
      return undefined;
    }

    const debugConfig = await this.client.getDebugConfig({
      fqbn,
      sketch_path: sketch.location_path,
      port,
      programmer: overrides?.programmer,
      ...(instance ? { instance } : {}),
    });

    return {
      debugConfig,
      serverConfig: decodeServerConfiguration(
        debugConfig.server_configuration,
        this.output,
      ),
      server: debugConfig.server,
      gdbPath: resolveGdbPath(
        debugConfig.toolchain_path,
        debugConfig.toolchain_prefix,
      ),
      sketchPath: sketch.location_path,
      fqbn,
    };
  }

  /** Resolve context and translate into a final, override-merged launch config. */
  private async buildConfiguration(overrides?: {
    fqbn?: string;
    programmer?: string;
    target?: vscode.Uri | string;
  }): Promise<
    { built: vscode.DebugConfiguration; sketchPath: string } | undefined
  > {
    const ctx = await this.resolveContext(overrides);
    if (!ctx) {
      return undefined;
    }
    return { built: this.translate(ctx), sketchPath: ctx.sketchPath };
  }

  /** Pick the adapter, run its translator (or the custom template), merge overrides. */
  private translate(ctx: TranslatorContext): vscode.DebugConfiguration {
    const cfg = vscode.workspace.getConfiguration("arduinoCli");
    const adapterSetting = cfg.get<string>("debug.adapter", "auto");
    const adapterOverride = cfg.get<Record<string, unknown>>(
      "debug.adapterConfig",
      {},
    );

    const adapter = this.selectAdapter(adapterSetting, ctx.debugConfig.toolchain_prefix);

    let built: vscode.DebugConfiguration;
    if (adapter === "custom") {
      built = this.buildCustom(ctx, adapterOverride);
    } else {
      const translator = TRANSLATORS.get(adapter);
      if (!translator) {
        // Unknown adapter name from the setting: pass it straight through as the
        // type and let adapterConfig supply the fields.
        built = {
          type: adapter,
          request: "launch",
          name: DEBUG_SESSION_NAME,
        };
      } else {
        built = translator(ctx);
      }
    }

    // Tag so the monitor only resumes when OUR session ends.
    built.__arduino = true;

    if (adapter !== "custom" && Object.keys(adapterOverride).length) {
      built = deepMerge(
        built as Record<string, unknown>,
        adapterOverride,
      ) as vscode.DebugConfiguration;
    }
    return built;
  }

  /** Build a config from the user's custom template via ${var} substitution. */
  private buildCustom(
    ctx: TranslatorContext,
    template: Record<string, unknown>,
  ): vscode.DebugConfiguration {
    const d = ctx.debugConfig;
    const vars: Record<string, string> = {
      executable: d.executable,
      toolchainPath: d.toolchain_path,
      toolchainPrefix: d.toolchain_prefix,
      gdbPath: ctx.gdbPath,
      server: d.server,
      serverPath: d.server_path,
      svdFile: d.svd_file,
      programmer: d.programmer,
    };
    const resolved = substituteVariables(template, vars) as Record<string, unknown>;
    return {
      type: "cppdbg",
      request: "launch",
      name: DEBUG_SESSION_NAME,
      ...resolved,
    } as vscode.DebugConfiguration;
  }

  /** Resolve the adapter to use, honoring the setting and installed extensions. */
  private selectAdapter(setting: string, toolchainPrefix: string): string {
    if (setting && setting !== "auto") {
      return setting;
    }
    const isArm = toolchainPrefix.includes("arm-none-eabi");
    const hasCortex = Boolean(vscode.extensions.getExtension(EXT_CORTEX_DEBUG));
    const hasCpp = Boolean(vscode.extensions.getExtension(EXT_CPPTOOLS));

    if (isArm && hasCortex) {
      return "cortex-debug";
    }
    if (hasCpp) {
      return "cppdbg";
    }
    if (hasCortex) {
      return "cortex-debug";
    }
    // Nothing installed — default to cppdbg and let the launch surface the
    // missing-extension error with VS Code's own install prompt.
    this.output.appendLine(
      "[debug] no debug adapter extension detected (cortex-debug / cpptools)",
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "No debug adapter found. Install the C/C++ or Cortex-Debug extension.",
      ),
    );
    return "cppdbg";
  }
}
