import * as path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/**
 * Thin wrapper around the arduino-cli ArduinoCoreService gRPC API.
 *
 * Responsibilities kept deliberately minimal (Phase 1):
 *  - load the proto definitions
 *  - open a channel to the daemon
 *  - manage the instance lifecycle (Create -> Init -> Destroy)
 *  - expose a couple of unary calls as proof of life (Version)
 *
 * Higher-level operations (Compile, Upload, Monitor, ...) are layered on top
 * in later phases — see .claude/docs.
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

export interface ArduinoInstance {
  id: number;
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
