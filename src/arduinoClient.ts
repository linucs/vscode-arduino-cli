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
  InitResponse,
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
  /**
   * Profile-bound instances, keyed by sketch path. Created on demand for
   * sketches whose sketch.yaml has a `default_profile`; the daemon binds the
   * profile's board/platform/libraries at Init (isolated from globally-installed
   * resources). The global `instance` above still serves profile-less sketches.
   */
  private readonly profileInstances = new Map<
    string,
    { profile: string; instance: ArduinoInstance }
  >();
  /**
   * In-flight `getProfileInstance` calls keyed by sketch path, so concurrent
   * callers (e.g. a user Compile and the background IntelliSense config) share a
   * single Create+Init instead of each starting their own — which would launch
   * two identical (potentially hundreds-of-MB) platform downloads, only one of
   * which the Compile progress UI could cancel.
   */
  private readonly profileInstancesInFlight = new Map<
    string,
    { profile: string; promise: Promise<ArduinoInstance> }
  >();
  /**
   * Monotonic epoch per sketch path, bumped on every
   * `invalidateProfileInstance`. An in-flight Init captures the epoch when it
   * starts and only caches its result if the epoch is unchanged on completion —
   * so an Init that resolved against a now-superseded sketch.yaml does not write
   * a stale instance back into the cache after invalidation.
   */
  private readonly profileEpochs = new Map<string, number>();

  /**
   * @param address daemon gRPC address (loopback).
   * @param log optional sink for init/lifecycle diagnostics (e.g. profile
   *   platform downloads surfaced during `Init`). Decoupled from `vscode` on
   *   purpose — the caller passes `output.appendLine`.
   */
  constructor(
    private readonly address: string,
    private readonly log?: (line: string) => void,
  ) {}

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
    const instance = await this.createAndInit({});
    this.instance = instance;
    return instance;
  }

  /**
   * Create an instance and run Init to completion. When `profile`/`sketch_path`
   * are supplied the daemon binds that profile (board, platform, libraries),
   * downloading the profile's resources as needed. Init is server-streaming
   * progress; we await its end.
   */
  private async createAndInit(
    initReq: {
      profile?: string;
      sketch_path?: string;
    },
    opts: {
      /** Human-readable progress (profile platform/tool/library downloads). */
      onProgress?: (message: string) => void;
      /** Cancels the Init stream (e.g. user cancelled the progress UI). */
      signal?: AbortSignal;
    } = {},
  ): Promise<ArduinoInstance> {
    const create = await this.unary<{ instance: ArduinoInstance }>(
      "Create",
      {},
    );
    const instance = create.instance;

    try {
      await new Promise<void>((resolve, reject) => {
        const stream = this.service.Init({ instance, ...initReq });
        // Cancelling the gRPC stream aborts the daemon-side download (verified:
        // the partial file stops growing immediately). Log it so the output
        // channel doesn't keep showing the last "Downloading…" line as if live.
        const cancel = () => {
          this.log?.("[init] cancelled — download stopped");
          stream.cancel();
        };
        if (opts.signal) {
          if (opts.signal.aborted) {
            cancel();
          } else {
            opts.signal.addEventListener("abort", cancel, { once: true });
          }
        }
        // `download_progress` updates carry only bytes (no label), so remember
        // the label from the preceding `start` to annotate the percentage.
        let label = "";
        stream.on("data", (msg: InitResponse) => {
          // Init failures (e.g. the daemon could not resolve/download a
          // profile's platform) arrive as a normal stream message carrying the
          // `error` oneof — NOT as a gRPC transport error. Branch on the
          // `message` discriminator and reject on `error`, otherwise a
          // half-initialised instance would look successful and surface later
          // as a misleading "no platform installed" at Compile time.
          if (msg.message === "error" && msg.error) {
            reject(new Error(msg.error.message || "instance init failed"));
            return;
          }
          if (msg.message !== "init_progress") {
            return;
          }
          const line = describeInitProgress(msg.init_progress, (l) => {
            label = l || label;
            return label;
          });
          if (line) {
            this.log?.(`[init] ${line}`);
            opts.onProgress?.(line);
          }
        });
        stream.on("error", reject);
        stream.on("end", resolve);
      });
    } catch (err) {
      // Init failed after Create allocated a daemon-side instance — release it
      // so a failed profile resolution does not leak handles.
      this.destroyInstance(instance);
      throw err;
    }

    return instance;
  }

  /**
   * Create + Init an instance bound to `profileName` for the sketch at
   * `sketchPath`, cached per sketch path. The daemon resolves board, platform
   * and libraries from the profile (isolated from globally-installed
   * resources), so callers must NOT also pass an `fqbn` to Compile in this mode.
   * Re-inits (and discards the old instance) if the cached entry was bound to a
   * different profile.
   */
  async getProfileInstance(
    sketchPath: string,
    profileName: string,
    opts: {
      onProgress?: (message: string) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<ArduinoInstance> {
    const cached = this.profileInstances.get(sketchPath);
    if (cached && cached.profile === profileName) {
      return cached.instance;
    }
    // Join an in-flight Init for the same profile rather than starting a second
    // one (and a second download).
    const inFlight = this.profileInstancesInFlight.get(sketchPath);
    if (inFlight && inFlight.profile === profileName) {
      return inFlight.promise;
    }
    if (cached) {
      this.destroyInstance(cached.instance);
    }
    const entry: { profile: string; promise: Promise<ArduinoInstance> } = {
      profile: profileName,
      promise: undefined as unknown as Promise<ArduinoInstance>,
    };
    entry.promise = this.buildStableProfileInstance(
      sketchPath,
      profileName,
      opts,
    ).finally(() => {
      // Clear only OUR entry: a newer Init for the same profile (started after
      // an invalidation) may already own the slot — matching on profile name
      // alone would wrongly orphan it.
      const cur = this.profileInstancesInFlight.get(sketchPath);
      if (cur === entry) {
        this.profileInstancesInFlight.delete(sketchPath);
      }
    });
    this.profileInstancesInFlight.set(sketchPath, entry);
    return entry.promise;
  }

  /**
   * Create+Init a profile instance, retrying if `sketch.yaml` is invalidated
   * (epoch bumped) while the Init runs — so the returned instance always
   * reflects the current `sketch.yaml`, never a superseded one. Each superseded
   * instance is destroyed immediately: zero leak, and the awaiter is never
   * handed a stale handle. Re-Init is cheap (the platform is already installed
   * from the first attempt; only changed libraries re-resolve).
   */
  private async buildStableProfileInstance(
    sketchPath: string,
    profileName: string,
    opts: { onProgress?: (message: string) => void; signal?: AbortSignal },
  ): Promise<ArduinoInstance> {
    for (let attempt = 0; ; attempt++) {
      const epoch = this.profileEpochs.get(sketchPath) ?? 0;
      const instance = await this.createAndInit(
        { profile: profileName, sketch_path: sketchPath },
        opts,
      );
      if ((this.profileEpochs.get(sketchPath) ?? 0) === epoch) {
        this.profileInstances.set(sketchPath, { profile: profileName, instance });
        return instance;
      }
      // sketch.yaml changed during Init — this instance is stale. Destroy it and
      // rebuild against the current sketch.yaml.
      this.destroyInstance(instance);
      if (attempt >= 4) {
        throw new Error(
          "sketch.yaml changed repeatedly during profile initialization — please retry",
        );
      }
    }
  }

  /**
   * Return the cached profile-bound instance for a sketch, or undefined if none
   * exists yet — WITHOUT creating one. Lets background/auto-triggered features
   * (IntelliSense config, debug-support probing) reuse a ready instance without
   * ever kicking off the profile's platform download; that is reserved for
   * explicit user actions (Compile/Upload) which show cancellable progress.
   */
  peekProfileInstance(
    sketchPath: string,
    profileName: string,
  ): ArduinoInstance | undefined {
    const cached = this.profileInstances.get(sketchPath);
    return cached && cached.profile === profileName ? cached.instance : undefined;
  }

  /**
   * Drop the cached profile-bound instance for a sketch so the next operation
   * re-Inits. Called when sketch.yaml changes — either the `default_profile`
   * name or a profile's content (e.g. libraries appended by the blocks editor),
   * which the daemon must re-resolve.
   */
  invalidateProfileInstance(sketchPath: string): void {
    // Advance the epoch. An in-flight Init (the retry loop in
    // buildStableProfileInstance) checks the epoch on completion and, finding it
    // changed, discards the stale instance and rebuilds against the current
    // sketch.yaml — so we deliberately leave the in-flight entry in place rather
    // than deleting it (deleting would spawn a second concurrent loop). New
    // joiners attach to that loop and receive the rebuilt instance.
    this.profileEpochs.set(sketchPath, (this.profileEpochs.get(sketchPath) ?? 0) + 1);
    const cached = this.profileInstances.get(sketchPath);
    if (cached) {
      this.destroyInstance(cached.instance);
      this.profileInstances.delete(sketchPath);
    }
  }

  /** Best-effort release of a daemon instance handle. */
  private destroyInstance(instance: ArduinoInstance): void {
    this.unary("Destroy", { instance }).catch(() => undefined);
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
    instance?: ArduinoInstance,
  ): Promise<SupportedUserFieldsResponse> {
    return this.unary<SupportedUserFieldsResponse>("SupportedUserFields", {
      instance: this.requireInstance(instance),
      fqbn,
      protocol,
    });
  }

  listProgrammers(
    fqbn: string,
    instance?: ArduinoInstance,
  ): Promise<ListProgrammersResponse> {
    return this.unary<ListProgrammersResponse>(
      "ListProgrammersAvailableForUpload",
      { instance: this.requireInstance(instance), fqbn },
    );
  }

  enumerateMonitorPortSettings(
    portProtocol: string,
    fqbn: string,
    instance?: ArduinoInstance,
  ): Promise<EnumerateMonitorPortSettingsResponse> {
    return this.unary<EnumerateMonitorPortSettingsResponse>(
      "EnumerateMonitorPortSettings",
      {
        instance: this.requireInstance(instance),
        port_protocol: portProtocol,
        fqbn,
      },
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
      /** Omitted in profile mode — the profile-bound `instance` supplies it. */
      fqbn?: string;
      sketch_path: string;
      verbose?: boolean;
      optimize_for_debug?: boolean;
      build_path?: string;
      create_compilation_database_only?: boolean;
      /** Profile-bound instance; falls back to the global instance when absent. */
      instance?: ArduinoInstance;
    },
    sinks: BuildStreamSinks,
    signal?: AbortSignal,
  ): Promise<BuilderResult | undefined> {
    const { instance, ...rest } = req;
    return this.runBuildStream<BuilderResult>(
      "Compile",
      { instance: this.requireInstance(instance), ...rest },
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
      /** Profile-bound instance; falls back to the global instance when absent. */
      instance?: ArduinoInstance;
    },
    sinks: BuildStreamSinks,
    signal?: AbortSignal,
  ): Promise<UploadResult | undefined> {
    const { instance, ...rest } = req;
    return this.runBuildStream<UploadResult>(
      "Upload",
      { instance: this.requireInstance(instance), ...rest },
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
      verbose?: boolean;
      user_fields?: Record<string, string>;
      /** Profile-bound instance; falls back to the global instance when absent. */
      instance?: ArduinoInstance;
    },
    sinks: { out: (s: string) => void; err: (s: string) => void },
    signal?: AbortSignal,
  ): Promise<void> {
    const { instance, ...rest } = req;
    return this.outputStream(
      "UploadUsingProgrammer",
      { instance: this.requireInstance(instance), ...rest },
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
      verbose?: boolean;
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
    /** Profile-bound instance; falls back to the global instance when absent. */
    instance?: ArduinoInstance;
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
        instance: this.requireInstance(req.instance),
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
    /** Profile-bound instance; falls back to the global instance when absent. */
    instance?: ArduinoInstance;
  }): Promise<IsDebugSupportedResponse> {
    return this.unary<IsDebugSupportedResponse>("IsDebugSupported", {
      instance: this.requireInstance(req.instance),
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
    /** Profile-bound instance; falls back to the global instance when absent. */
    instance?: ArduinoInstance;
  }): Promise<GetDebugConfigResponse> {
    const { instance, ...rest } = req;
    return this.unary<GetDebugConfigResponse>("GetDebugConfig", {
      instance: this.requireInstance(instance),
      ...rest,
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
    /** Profile-bound instance; falls back to the global instance when absent. */
    instance?: ArduinoInstance;
  }): DebugStream {
    const call = this.service.Debug();
    const stream: DebugStream = {
      sendData: (data: Buffer) => call.write({ data }),
      sendInterrupt: () => call.write({ send_interrupt: true }),
      cancel: () => call.cancel(),
      on: (event: string, cb: (...args: any[]) => void) => call.on(event, cb),
    };
    const { instance, ...rest } = req;
    call.write({
      debug_request: { instance: this.requireInstance(instance), ...rest },
    });
    return stream;
  }

  async destroy(): Promise<void> {
    for (const { instance } of this.profileInstances.values()) {
      this.destroyInstance(instance);
    }
    this.profileInstances.clear();
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

  /**
   * Resolve the instance to use for a call: an explicit (profile-bound) instance
   * when provided, otherwise the global instance. Throws if neither exists.
   */
  private requireInstance(explicit?: ArduinoInstance): Instance {
    const inst = explicit ?? this.instance;
    if (!inst) {
      throw new Error("arduino-cli instance not initialized");
    }
    return inst;
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

/**
 * Render an `InitResponse.Progress` into a one-line status string. Download
 * `update` frames carry only byte counts, so `track` is called on each `start`
 * to remember the label and replay it on subsequent `update`/`end` frames.
 * Returns undefined for frames with nothing worth showing.
 */
function describeInitProgress(
  p: InitResponse["init_progress"],
  track: (label: string) => string,
): string | undefined {
  const dl = p?.download_progress;
  const task = p?.task_progress;
  if (dl?.start) {
    const label = track(dl.start.label || dl.start.url || "");
    return label ? `Downloading ${label}…` : "Downloading…";
  }
  if (dl?.update) {
    const label = track("");
    const total = Number(dl.update.total_size) || 0;
    const done = Number(dl.update.downloaded) || 0;
    if (total > 0) {
      const pct = Math.floor((done * 100) / total);
      return `Downloading ${label} — ${pct}% (${mib(done)}/${mib(total)} MiB)`;
    }
    return label ? `Downloading ${label}…` : "Downloading…";
  }
  if (dl?.end) {
    return dl.end.message || undefined;
  }
  // Stage messages (e.g. "Downloading the tool …", "Installing platform …").
  return task?.name || task?.message || undefined;
}

/** Bytes → MiB with one decimal, for compact progress strings. */
function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
