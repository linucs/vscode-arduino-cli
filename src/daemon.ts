import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";

/**
 * Thrown when the daemon executable cannot be found (spawn ENOENT): the
 * `arduinoCli.path` setting is wrong or arduino-cli simply isn't installed.
 * Carries the resolved path that failed so callers can offer recovery actions
 * (pick the executable, open the download page) instead of a dead-end error.
 */
export class ArduinoCliNotFoundError extends Error {
  constructor(
    message: string,
    readonly cliPath: string,
  ) {
    super(message);
    this.name = "ArduinoCliNotFoundError";
  }
}

/**
 * Manages the lifecycle of the `arduino-cli daemon` child process.
 *
 * The daemon exposes the ArduinoCoreService gRPC API on a local TCP port.
 * We spawn it once on activation and tear it down on deactivation.
 */
export class DaemonManager {
  private proc: ChildProcess | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  get port(): number {
    return vscode.workspace
      .getConfiguration("arduinoCli")
      .get<number>("daemonPort", 50051);
  }

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  private get cliPath(): string {
    return vscode.workspace
      .getConfiguration("arduinoCli")
      .get<string>("path", "arduino-cli")
      .trim();
  }

  /** Single actionable "not found" message, shared by the empty-path and
   * ENOENT cases so both surface the exact same recovery flow. */
  private notFoundMessage(cliPath: string): string {
    return vscode.l10n.t(
      'arduino-cli not found at "{0}". Set "arduinoCli.path" or install arduino-cli.',
      cliPath,
    );
  }

  /**
   * Starts the daemon and resolves once it reports it is listening.
   * Rejects if the process fails to spawn or exits before becoming ready.
   */
  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    // An empty/blank `arduinoCli.path` would spawn("") and fail with an opaque
    // error (EINVAL/ENOENT depending on platform). Treat it as "not found" up
    // front so callers get the exact same actionable recovery as a wrong path.
    const cliPath = this.cliPath;
    if (!cliPath) {
      throw new ArduinoCliNotFoundError(this.notFoundMessage(cliPath), cliPath);
    }

    const args = ["daemon", "--port", String(this.port)];
    this.output.appendLine(`[daemon] ${cliPath} ${args.join(" ")}`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(cliPath, args, { stdio: "pipe" });
      this.proc = proc;

      const onReady = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.output.append(text);
        // The daemon prints a ready line that includes its bound address, e.g.
        // "Daemon is now listening on 127.0.0.1:50051" — but that prose is
        // localized (Italian: "Deamon è ora in ascolto su 127.0.0.1:50051"), so
        // matching English words would never fire on a non-English daemon. The
        // address itself is locale-independent and present in every variant, so
        // detect on that. This is only an early-exit optimisation — the channel
        // is authoritatively gated by ArduinoClient.waitForReady afterwards.
        if (text.includes(this.address)) {
          onReady();
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        this.output.append(chunk.toString());
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          // Spawn failed: there is no live process. Clear it so a later start()
          // (e.g. after the user fixes arduinoCli.path) actually re-spawns
          // instead of early-returning on a stale, dead handle.
          this.proc = undefined;
          // ENOENT = the executable isn't on PATH (or `arduinoCli.path` is wrong):
          // the common case when arduino-cli simply isn't installed. Give one
          // actionable message instead of a raw spawn error.
          if (err.code === "ENOENT") {
            reject(
              new ArduinoCliNotFoundError(
                this.notFoundMessage(cliPath),
                cliPath,
              ),
            );
          } else {
            reject(
              new Error(
                vscode.l10n.t(
                  "Failed to start arduino-cli daemon ({0}): {1}",
                  cliPath,
                  err.message,
                ),
              ),
            );
          }
        }
      });

      proc.on("exit", (code) => {
        this.output.appendLine(`[daemon] exited with code ${code}`);
        this.proc = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(`arduino-cli daemon exited early (code ${code})`));
        }
      });

      // Fallback: if the daemon does not emit a recognizable ready line,
      // assume it is up after a short grace period.
      setTimeout(onReady, 2000);
    });
  }

  stop(): void {
    if (this.proc) {
      this.output.appendLine("[daemon] stopping");
      this.proc.kill();
      this.proc = undefined;
    }
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }
}
