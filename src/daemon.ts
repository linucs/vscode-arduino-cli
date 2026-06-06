import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";

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
      .get<string>("path", "arduino-cli");
  }

  /**
   * Starts the daemon and resolves once it reports it is listening.
   * Rejects if the process fails to spawn or exits before becoming ready.
   */
  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    const args = ["daemon", "--port", String(this.port)];
    this.output.appendLine(`[daemon] ${this.cliPath} ${args.join(" ")}`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.cliPath, args, { stdio: "pipe" });
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
        // The daemon prints "Daemon is now listening on ..." when ready.
        if (/listening/i.test(text)) {
          onReady();
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        this.output.append(chunk.toString());
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          // ENOENT = the executable isn't on PATH (or `arduinoCli.path` is wrong):
          // the common case when arduino-cli simply isn't installed. Give one
          // actionable message instead of a raw spawn error.
          const message =
            err.code === "ENOENT"
              ? vscode.l10n.t(
                  'arduino-cli not found at "{0}". Set "arduinoCli.path" or install arduino-cli.',
                  this.cliPath,
                )
              : vscode.l10n.t(
                  "Failed to start arduino-cli daemon ({0}): {1}",
                  this.cliPath,
                  err.message,
                );
          reject(new Error(message));
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
