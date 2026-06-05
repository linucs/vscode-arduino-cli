import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { applyBuildMessage, type BuildStreamSinks } from "./buildStream";
import type {
  BoardListResponse,
  BoardListAllResponse,
  BoardListWatchResponse,
  BuilderResult,
  EnumerateMonitorPortSettingsResponse,
  Instance,
  ListProgrammersResponse,
  LoadSketchResponse,
  SetSketchDefaultsRequest,
  SetSketchDefaultsResponse,
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
    req: { fqbn: string; sketch_path: string; verbose?: boolean },
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

  // ---------------------------------------------------------------------------
  // Bidirectional streaming (Monitor) — added in milestone 1c.
  // ---------------------------------------------------------------------------

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
