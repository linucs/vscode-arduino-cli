import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { applyBuildMessage, type BuildStreamSinks } from "./buildStream";
import type {
  BoardDetailsResponse,
  BoardIdentifyResponse,
  BoardListResponse,
  BoardListAllResponse,
  BoardListWatchResponse,
  BoardSearchResponse,
  BuilderResult,
  CheckForArduinoCLIUpdatesResponse,
  ConfigurationGetResponse,
  ConfigurationOpenResponse,
  ConfigurationSaveResponse,
  DownloadProgress,
  EnumerateMonitorPortSettingsResponse,
  Instance,
  LibraryListResponse,
  LibraryResolveDependenciesResponse,
  LibrarySearchResponse,
  ListProgrammersResponse,
  LoadSketchResponse,
  NewSketchResponse,
  PlatformSearchResponse,
  ProfileLibAddResponse,
  ProfileLibListResponse,
  ProfileLibRemoveResponse,
  ProfileLibraryReference,
  GetDebugConfigResponse,
  IsDebugSupportedResponse,
  SetSketchDefaultsRequest,
  SetSketchDefaultsResponse,
  SettingsEnumerateResponse,
  SettingsGetValueResponse,
  SupportedUserFieldsResponse,
  UploadResult,
} from "./proto/types";

export type { BuildStreamSinks } from "./buildStream";

/**
 * Thin wrapper around the arduino-cli ArduinoCoreService gRPC API — the single
 * transport layer. It is the only module that touches grpc/proto-loader and the
 * only holder of the `instance` handle; higher-level managers depend on it and
 * never speak grpc directly.
 *
 * Three call shapes are exposed beyond the lifecycle:
 *  - `unary` typed wrappers (boardList, loadSketch, ...)
 *  - `serverStream` — callback-based server-streaming (BoardListWatch, indexes)
 *  - `runBuildStream` — shared oneof demux for Compile and Upload
 *  - `duplex` — bidirectional, event-shaped (Monitor; added in 1c)
 */

// Path to the vendored proto tree. The root commands.proto pulls in the other
// message files via relative imports, so we point the loader at the package
// root and let it resolve them.
const PROTO_ROOT = path.join(__dirname, "..", "proto");
const COMMANDS_PROTO = path.join(
  PROTO_ROOT,
  "cc",
  "arduino",
  "cli",
  "commands",
  "v1",
  "commands.proto",
);

export type ArduinoInstance = Instance;

/** Event-shaped handle over the bidirectional Monitor stream. */
export interface MonitorStream {
  /** Send bytes to the port. */
  sendData(data: Buffer): void;
  /** Apply a new MonitorPortConfiguration (e.g. baud rate). */
  sendConfiguration(configuration: object): void;
  /** Gracefully close the port (daemon closes the stream after the port is closed). */
  close(): void;
  /** Hard-cancel the underlying gRPC call. */
  cancel(): void;
  /** `"data"` → MonitorResponse, `"error"` → Error, `"end"` → void. */
  on(event: "data" | "error" | "end", cb: (...args: any[]) => void): void;
}

/**
 * Event-shaped handle over the bidirectional Debug stream (raw GDB I/O).
 * Wrapped for API completeness; the debug flow delegates to external debug
 * adapters via GetDebugConfig, so this is not consumed today.
 */
export interface DebugStream {
  /** Send bytes (a GDB command) to the debugger. */
  sendData(data: Buffer): void;
  /** Send an interrupt (Ctrl-C) to the debugger process. */
  sendInterrupt(): void;
  /** Hard-cancel the underlying gRPC call. */
  cancel(): void;
  /** `"data"` → DebugResponse, `"error"` → Error, `"end"` → void. */
  on(event: "data" | "error" | "end", cb: (...args: any[]) => void): void;
}

export class ArduinoClient {
  private client: grpc.Client | undefined;
  private service: any;
  private instance: ArduinoInstance | undefined;

  constructor(private readonly address: string) {}

  /** Loads the proto and opens an insecure local channel to the daemon. */
  connect(): void {
    const packageDef = protoLoader.loadSync(COMMANDS_PROTO, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [PROTO_ROOT],
    });
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const ServiceCtor =
      proto.cc.arduino.cli.commands.v1.ArduinoCoreService;
    this.service = new ServiceCtor(
      this.address,
      grpc.credentials.createInsecure(),
      {
        // Some replies (large board/library/platform listings) can exceed
        // gRPC's 4 MB default; raise the receive limit defensively.
        "grpc.max_receive_message_length": 64 * 1024 * 1024,
      },
    );
    this.client = this.service;
  }

  /** Create + Init an instance. Init is server-streaming progress; we await its end. */
  async initInstance(): Promise<ArduinoInstance> {
    const create = await this.unary<{ instance: ArduinoInstance }>(
      "Create",
      {},
    );
    const instance = create.instance;

    await new Promise<void>((resolve, reject) => {
      const stream = this.service.Init({ instance });
      stream.on("data", () => {
        /* progress messages — ignored in Phase 1 */
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });

    this.instance = instance;
    return instance;
  }

  async version(): Promise<string> {
    const res = await this.unary<{ version: string }>("Version", {});
    return res.version;
  }

  // ---------------------------------------------------------------------------
  // Typed unary wrappers (instance injected automatically)
  // ---------------------------------------------------------------------------

  boardList(timeoutMs = 1000): Promise<BoardListResponse> {
    return this.unary<BoardListResponse>("BoardList", {
      instance: this.requireInstance(),
      timeout: timeoutMs,
    });
  }

  boardListAll(searchArgs: string[] = []): Promise<BoardListAllResponse> {
    return this.unary<BoardListAllResponse>("BoardListAll", {
      instance: this.requireInstance(),
      search_args: searchArgs,
    });
  }

  boardSearch(
    query: string,
    includeHidden = false,
  ): Promise<BoardSearchResponse> {
    return this.unary<BoardSearchResponse>("BoardSearch", {
      instance: this.requireInstance(),
      search_args: query,
      include_hidden_boards: includeHidden,
    });
  }

  boardIdentify(
    properties: Record<string, string>,
    useCloud = false,
  ): Promise<BoardIdentifyResponse> {
    return this.unary<BoardIdentifyResponse>("BoardIdentify", {
      instance: this.requireInstance(),
      properties,
      use_cloud_api_for_unknown_board_detection: useCloud,
    });
  }

  boardDetails(fqbn: string): Promise<BoardDetailsResponse> {
    return this.unary<BoardDetailsResponse>("BoardDetails", {
      instance: this.requireInstance(),
      fqbn,
    });
  }

  loadSketch(sketchPath: string): Promise<LoadSketchResponse> {
    return this.unary<LoadSketchResponse>("LoadSketch", {
      sketch_path: sketchPath,
    });
  }

  /** Persist board/port defaults into the sketch's `sketch.yaml`. No instance needed. */
  setSketchDefaults(
    req: SetSketchDefaultsRequest,
  ): Promise<SetSketchDefaultsResponse> {
    return this.unary<SetSketchDefaultsResponse>("SetSketchDefaults", req);
  }

  newSketch(
    name: string,
    dir?: string,
    overwrite = false,
  ): Promise<NewSketchResponse> {
    return this.unary<NewSketchResponse>("NewSketch", {
      sketch_name: name,
      ...(dir ? { sketch_dir: dir } : {}),
      overwrite,
    });
  }

  archiveSketch(
    sketchPath: string,
    archivePath?: string,
    includeBuildDir = false,
    overwrite = true,
  ): Promise<void> {
    return this.unary("ArchiveSketch", {
      sketch_path: sketchPath,
      ...(archivePath ? { archive_path: archivePath } : {}),
      include_build_dir: includeBuildDir,
      overwrite,
    });
  }

  checkForUpdates(forceCheck = true): Promise<CheckForArduinoCLIUpdatesResponse> {
    return this.unary<CheckForArduinoCLIUpdatesResponse>(
      "CheckForArduinoCLIUpdates",
      { force_check: forceCheck },
    );
  }

  cleanDownloadCache(): Promise<void> {
    return this.unary("CleanDownloadCacheDirectory", {
      instance: this.requireInstance(),
    });
  }

  // --- settings / configuration ----------------------------------------------

  configurationGet(): Promise<ConfigurationGetResponse> {
    return this.unary<ConfigurationGetResponse>("ConfigurationGet", {});
  }

  configurationSave(format = "json"): Promise<ConfigurationSaveResponse> {
    return this.unary<ConfigurationSaveResponse>("ConfigurationSave", {
      settings_format: format,
    });
  }

  configurationOpen(
    encoded: string,
    format = "json",
  ): Promise<ConfigurationOpenResponse> {
    return this.unary<ConfigurationOpenResponse>("ConfigurationOpen", {
      encoded_settings: encoded,
      settings_format: format,
    });
  }

  settingsEnumerate(): Promise<SettingsEnumerateResponse> {
    return this.unary<SettingsEnumerateResponse>("SettingsEnumerate", {});
  }

  settingsGetValue(key: string, format = "json"): Promise<SettingsGetValueResponse> {
    return this.unary<SettingsGetValueResponse>("SettingsGetValue", {
      key,
      value_format: format,
    });
  }

  settingsSetValue(key: string, encodedValue: string, format = "json"): Promise<void> {
    return this.unary("SettingsSetValue", {
      key,
      encoded_value: encodedValue,
      value_format: format,
    });
  }

  // --- profiles --------------------------------------------------------------

  profileCreate(
    sketchPath: string,
    profileName: string,
    fqbn: string,
    setDefault = false,
  ): Promise<void> {
    return this.unary("ProfileCreate", {
      instance: this.requireInstance(),
      sketch_path: sketchPath,
      profile_name: profileName,
      fqbn,
      default_profile: setDefault,
    });
  }

  profileLibAdd(
    sketchPath: string,
    profileName: string,
    library: ProfileLibraryReference,
    addDeps = true,
  ): Promise<ProfileLibAddResponse> {
    return this.unary<ProfileLibAddResponse>("ProfileLibAdd", {
      instance: this.requireInstance(),
      sketch_path: sketchPath,
      profile_name: profileName,
      library,
      add_dependencies: addDeps,
    });
  }

  profileLibRemove(
    sketchPath: string,
    profileName: string,
    library: ProfileLibraryReference,
    removeDeps = true,
  ): Promise<ProfileLibRemoveResponse> {
    return this.unary<ProfileLibRemoveResponse>("ProfileLibRemove", {
      instance: this.requireInstance(),
      sketch_path: sketchPath,
      profile_name: profileName,
      library,
      remove_dependencies: removeDeps,
    });
  }

  profileLibList(
    sketchPath: string,
    profileName: string,
  ): Promise<ProfileLibListResponse> {
    return this.unary<ProfileLibListResponse>("ProfileLibList", {
      sketch_path: sketchPath,
      profile_name: profileName,
    });
  }

  profileSetDefault(sketchPath: string, profileName: string): Promise<void> {
    return this.unary("ProfileSetDefault", {
      sketch_path: sketchPath,
      profile_name: profileName,
    });
  }

  supportedUserFields(
    fqbn: string,
    protocol: string,
  ): Promise<SupportedUserFieldsResponse> {
    return this.unary<SupportedUserFieldsResponse>("SupportedUserFields", {
      instance: this.requireInstance(),
      fqbn,
      protocol,
    });
  }

  listProgrammers(fqbn: string): Promise<ListProgrammersResponse> {
    return this.unary<ListProgrammersResponse>(
      "ListProgrammersAvailableForUpload",
      { instance: this.requireInstance(), fqbn },
    );
  }

  enumerateMonitorPortSettings(
    portProtocol: string,
    fqbn: string,
  ): Promise<EnumerateMonitorPortSettingsResponse> {
    return this.unary<EnumerateMonitorPortSettingsResponse>(
      "EnumerateMonitorPortSettings",
      { instance: this.requireInstance(), port_protocol: portProtocol, fqbn },
    );
  }

  platformSearch(searchArgs = ""): Promise<PlatformSearchResponse> {
    return this.unary<PlatformSearchResponse>("PlatformSearch", {
      instance: this.requireInstance(),
      search_args: searchArgs,
    });
  }

  /** Install a platform/core, reporting download + task status. */
  platformInstall(
    req: { platform_package: string; architecture: string; version?: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("PlatformInstall", req, onStatus, signal);
  }

  platformUninstall(
    req: { platform_package: string; architecture: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("PlatformUninstall", req, onStatus, signal);
  }

  platformUpgrade(
    req: { platform_package: string; architecture: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("PlatformUpgrade", req, onStatus, signal);
  }

  platformDownload(
    req: { platform_package: string; architecture: string; version?: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("PlatformDownload", req, onStatus, signal);
  }

  // --- libraries ------------------------------------------------------------

  librarySearch(searchArgs = "", omitReleases = false): Promise<LibrarySearchResponse> {
    return this.unary<LibrarySearchResponse>("LibrarySearch", {
      instance: this.requireInstance(),
      search_args: searchArgs,
      omit_releases_details: omitReleases,
    });
  }

  libraryList(
    opts: { all?: boolean; updatable?: boolean; fqbn?: string } = {},
  ): Promise<LibraryListResponse> {
    return this.unary<LibraryListResponse>("LibraryList", {
      instance: this.requireInstance(),
      all: opts.all ?? false,
      updatable: opts.updatable ?? false,
      fqbn: opts.fqbn ?? "",
    });
  }

  libraryResolveDependencies(
    name: string,
    version = "",
  ): Promise<LibraryResolveDependenciesResponse> {
    return this.unary<LibraryResolveDependenciesResponse>(
      "LibraryResolveDependencies",
      { instance: this.requireInstance(), name, version },
    );
  }

  libraryInstall(
    req: { name: string; version?: string; no_deps?: boolean },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("LibraryInstall", req, onStatus, signal);
  }

  libraryUninstall(
    req: { name: string; version?: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("LibraryUninstall", req, onStatus, signal);
  }

  libraryUpgrade(
    req: { name: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("LibraryUpgrade", req, onStatus, signal);
  }

  libraryUpgradeAll(
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("LibraryUpgradeAll", {}, onStatus, signal);
  }

  /** Install a library from a local .zip archive. */
  zipLibraryInstall(
    req: { path: string; overwrite?: boolean },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("ZipLibraryInstall", req, onStatus, signal);
  }

  /** Install a library from a git repository URL. */
  gitLibraryInstall(
    req: { url: string; overwrite?: boolean },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("GitLibraryInstall", req, onStatus, signal);
  }

  /** Download a library archive into the cache without installing it. */
  libraryDownload(
    req: { name: string; version?: string },
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.progressStream("LibraryDownload", req, onStatus, signal);
  }

  /** Shared demux for platform/library op streams (progress | task_progress | result). */
  private progressStream(
    method: string,
    req: object,
    onStatus: (message: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serverStream(
      method,
      { instance: this.requireInstance(), ...req },
      {
        signal,
        onData: (msg) => {
          if (msg.message === "progress") {
            const dp = msg.progress;
            if (dp.start) {
              onStatus(dp.start.label || dp.start.url);
            } else if (dp.update && dp.update.total_size > 0) {
              const pct = Math.round(
                (dp.update.downloaded / dp.update.total_size) * 100,
              );
              onStatus(`${pct}%`);
            }
          } else if (msg.message === "task_progress") {
            const t = msg.task_progress;
            if (t.message || t.name) {
              onStatus(t.message || t.name);
            }
          }
        },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Server-streaming
  // ---------------------------------------------------------------------------

  /**
   * Generic server-streaming call. `onData` is invoked synchronously per message
   * (mirrors 1:1 onto OutputChannel/progress). Resolves on `end`, rejects on
   * `error`. An aborted `signal` cancels the underlying call.
   */
  serverStream(
    method: string,
    request: object,
    opts: { onData: (msg: any) => void; signal?: AbortSignal },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const call = this.service[method](request);
      const onAbort = () => call.cancel();
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      call.on("data", (msg: any) => {
        try {
          opts.onData(msg);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      call.on("error", (err: grpc.ServiceError) => {
        opts.signal?.removeEventListener("abort", onAbort);
        // A user-cancelled call surfaces as CANCELLED — treat it as a clean end.
        if (err.code === grpc.status.CANCELLED) {
          resolve();
        } else {
          reject(err);
        }
      });
      call.on("end", () => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /** Update the platform (package) index, reporting download progress. */
  updateIndex(
    onProgress: (p: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serverStream(
      "UpdateIndex",
      { instance: this.requireInstance() },
      {
        signal,
        onData: (msg) => {
          if (msg.message === "download_progress") {
            onProgress(msg.download_progress);
          }
        },
      },
    );
  }

  /** Update the libraries index, reporting download progress. */
  updateLibrariesIndex(
    onProgress: (p: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serverStream(
      "UpdateLibrariesIndex",
      { instance: this.requireInstance() },
      {
        signal,
        onData: (msg) => {
          if (msg.message === "download_progress") {
            onProgress(msg.download_progress);
          }
        },
      },
    );
  }

  /**
   * Watch for board connect/disconnect events. Long-lived; bound to the current
   * instance, so it must be torn down and recreated across daemon restarts.
   */
  watchBoardList(opts: {
    onEvent: (ev: BoardListWatchResponse) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.serverStream(
      "BoardListWatch",
      { instance: this.requireInstance() },
      { onData: opts.onEvent, signal: opts.signal },
    );
  }

  /**
   * Shared oneof demux for Compile and Upload. Pipes `out_stream`/`err_stream`
   * (Buffers) to the sinks as UTF-8, reports `progress`, and returns the final
   * `result` payload. Branches on the `message` discriminator (oneofs:true), not
   * truthiness — empty Buffers are falsy-but-present.
   */
  async runBuildStream<R = BuilderResult | UploadResult>(
    method: string,
    request: object,
    sinks: BuildStreamSinks,
    signal?: AbortSignal,
  ): Promise<R | undefined> {
    let result: R | undefined;
    await this.serverStream(method, request, {
      signal,
      onData: (msg) => {
        const r = applyBuildMessage<R>(msg, sinks);
        if (r !== undefined) {
          result = r;
        }
      },
    });
    return result;
  }

  /** Compile a sketch. Streams output via `sinks`; resolves with the BuilderResult. */
  compile(
    req: {
      fqbn: string;
      sketch_path: string;
      verbose?: boolean;
      optimize_for_debug?: boolean;
    },
    sinks: BuildStreamSinks,
    signal?: AbortSignal,
  ): Promise<BuilderResult | undefined> {
    return this.runBuildStream<BuilderResult>(
      "Compile",
      { instance: this.requireInstance(), ...req },
      sinks,
      signal,
    );
  }

  /** Upload a compiled sketch to a board. Streams output via `sinks`. */
  upload(
    req: {
      fqbn: string;
      sketch_path: string;
      port: object;
      verbose?: boolean;
      user_fields?: Record<string, string>;
    },
    sinks: BuildStreamSinks,
    signal?: AbortSignal,
  ): Promise<UploadResult | undefined> {
    return this.runBuildStream<UploadResult>(
      "Upload",
      { instance: this.requireInstance(), ...req },
      sinks,
      signal,
    );
  }

  /** Upload via an external programmer. Stream has only out/err (no progress). */
  uploadUsingProgrammer(
    req: {
      fqbn: string;
      sketch_path: string;
      port: object;
      programmer: string;
      user_fields?: Record<string, string>;
    },
    sinks: { out: (s: string) => void; err: (s: string) => void },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.outputStream(
      "UploadUsingProgrammer",
      { instance: this.requireInstance(), ...req },
      sinks,
      signal,
    );
  }

  /** Burn a bootloader to the board via a programmer. */
  burnBootloader(
    req: {
      fqbn: string;
      port: object;
      programmer: string;
      user_fields?: Record<string, string>;
    },
    sinks: { out: (s: string) => void; err: (s: string) => void },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.outputStream(
      "BurnBootloader",
      { instance: this.requireInstance(), ...req },
      sinks,
      signal,
    );
  }

  /**
   * Lightweight server-stream consumer for RPCs that only emit out_stream/err_stream
   * (no progress or result oneofs). Used by UploadUsingProgrammer and BurnBootloader.
   */
  private outputStream(
    method: string,
    request: object,
    sinks: { out: (s: string) => void; err: (s: string) => void },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.serverStream(method, request, {
      signal,
      onData: (msg: { message?: string; out_stream?: Buffer; err_stream?: Buffer }) => {
        if (msg.message === "out_stream" && msg.out_stream) {
          sinks.out(Buffer.from(msg.out_stream).toString("utf-8"));
        } else if (msg.message === "err_stream" && msg.err_stream) {
          sinks.err(Buffer.from(msg.err_stream).toString("utf-8"));
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Bidirectional streaming (Monitor)
  // ---------------------------------------------------------------------------

  /**
   * Open a serial monitor on `port`. Sends the mandatory `open_request` (with the
   * instance injected) as the first message and returns an event-shaped duplex
   * for subsequent tx/config/close writes and rx reads. The caller attaches
   * listeners immediately after this returns.
   */
  startMonitor(req: {
    port: object;
    fqbn?: string;
    port_configuration?: object;
  }): MonitorStream {
    const call = this.service.Monitor();
    const stream: MonitorStream = {
      sendData: (data: Buffer) => call.write({ tx_data: data }),
      sendConfiguration: (configuration: object) =>
        call.write({ updated_configuration: configuration }),
      close: () => call.write({ close: true }),
      cancel: () => call.cancel(),
      on: (event: string, cb: (...args: any[]) => void) => call.on(event, cb),
    };
    call.write({
      open_request: {
        instance: this.requireInstance(),
        port: req.port,
        fqbn: req.fqbn ?? "",
        ...(req.port_configuration
          ? { port_configuration: req.port_configuration }
          : {}),
      },
    });
    return stream;
  }

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------

  isDebugSupported(req: {
    fqbn: string;
    port?: object;
    interpreter?: string;
    programmer?: string;
  }): Promise<IsDebugSupportedResponse> {
    return this.unary<IsDebugSupportedResponse>("IsDebugSupported", {
      instance: this.requireInstance(),
      fqbn: req.fqbn,
      ...(req.port ? { port: req.port } : {}),
      ...(req.interpreter ? { interpreter: req.interpreter } : {}),
      ...(req.programmer ? { programmer: req.programmer } : {}),
    });
  }

  getDebugConfig(req: {
    fqbn: string;
    sketch_path: string;
    port?: object;
    interpreter?: string;
    import_dir?: string;
    programmer?: string;
  }): Promise<GetDebugConfigResponse> {
    return this.unary<GetDebugConfigResponse>("GetDebugConfig", {
      instance: this.requireInstance(),
      ...req,
    });
  }

  /**
   * Open the bidirectional Debug stream (raw GDB I/O). The first message must
   * carry the GetDebugConfigRequest. Wrapped for completeness; the debug flow
   * delegates to external debug adapters and does not use this today.
   */
  startDebug(req: {
    fqbn: string;
    sketch_path: string;
    port?: object;
    interpreter?: string;
    programmer?: string;
  }): DebugStream {
    const call = this.service.Debug();
    const stream: DebugStream = {
      sendData: (data: Buffer) => call.write({ data }),
      sendInterrupt: () => call.write({ send_interrupt: true }),
      cancel: () => call.cancel(),
      on: (event: string, cb: (...args: any[]) => void) => call.on(event, cb),
    };
    call.write({
      debug_request: { instance: this.requireInstance(), ...req },
    });
    return stream;
  }

  async destroy(): Promise<void> {
    if (this.instance) {
      await this.unary("Destroy", { instance: this.instance }).catch(
        () => undefined,
      );
      this.instance = undefined;
    }
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }

  /** True once Create+Init have completed and an instance handle is held. */
  get ready(): boolean {
    return this.instance !== undefined;
  }

  /** The current instance, or throw if the client has not been initialized. */
  private requireInstance(): Instance {
    if (!this.instance) {
      throw new Error("arduino-cli instance not initialized");
    }
    return this.instance;
  }

  /** Promisified unary call helper. */
  private unary<T>(method: string, request: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.service[method](request, (err: grpc.ServiceError | null, res: T) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}
