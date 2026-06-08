import * as vscode from "vscode";
import type { ArduinoClient, ArduinoInstance } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { PlatformManager } from "./platformManager";
import { resolveSketch } from "./sketch";
import { prepareExecution } from "./profileMode";
import { tail } from "./compile";
import type { Port } from "./proto/types";

/**
 * Runs `Upload`. Resolves the sketch, board (FQBN) and port, prompts for any
 * board-specific user fields (e.g. OTA password) via `SupportedUserFields`, and
 * streams the upload through the shared build-stream demux.
 *
 * Assumes the sketch has already been compiled — the `arduinoCli.upload` command
 * runs a compile first (see extension.ts).
 */
export class Uploader {
  /** Tail of the last `run()`'s output, for the LLM `upload` tool (esp. on failure). */
  private lastOutput = "";

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly platforms: PlatformManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Captured stdout/stderr tail from the most recent `run()`. */
  getLastOutput(): string {
    return this.lastOutput;
  }

  /** Upload the resolved sketch to the selected board/port. Returns true on success. */
  async run(target?: vscode.Uri | string): Promise<boolean> {
    this.lastOutput = "";
    const sketch = await resolveSketch(this.client, { target });
    if (!sketch) {
      return false;
    }

    const exec = await prepareExecution(
      this.client, this.boards, sketch, this.platforms, this.output, "upload",
    );
    if (!exec) {
      return false;
    }
    const fqbn = exec.fqbn;
    if (!fqbn) {
      await this.promptSelectBoard(
        vscode.l10n.t("No board selected for this sketch."),
      );
      return false;
    }

    // Port stays physical/per-machine even in profile mode.
    const port = this.resolvePort(sketch.default_port, sketch.default_protocol);
    if (!port) {
      await this.promptSelectBoard(
        vscode.l10n.t("No port selected. Pick a board on a connected port."),
      );
      return false;
    }

    const userFields = await this.collectUserFields(
      fqbn,
      port.protocol,
      exec.instance,
    );
    if (userFields === undefined) {
      return false; // user cancelled a required field
    }

    this.output.show(true);
    this.output.appendLine(`\n[upload] ${fqbn} -> ${port.address}`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Uploading to {0}…", port.label || port.address),
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const captured: string[] = [];
        const append = (s: string) => {
          this.output.append(s);
          captured.push(s);
        };
        try {
          await this.client.upload(
            {
              fqbn,
              sketch_path: sketch.location_path,
              port,
              ...(this.verbose() ? { verbose: true } : {}),
              user_fields: userFields,
              ...(exec.instance ? { instance: exec.instance } : {}),
            },
            {
              out: append,
              err: append,
              progress: (t) =>
                progress.report({ message: t.message || t.name }),
            },
            ac.signal,
          );
          this.lastOutput = tail(captured.join(""));
          vscode.window.showInformationMessage(
            vscode.l10n.t("Upload complete."),
          );
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[upload] cancelled");
            return false;
          }
          this.lastOutput = tail(
            captured.join("") +
              `\n[upload] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.output.appendLine(
            `[upload] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Upload failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }

  /** Selected port, or a minimal port built from the sketch's defaults. */
  private resolvePort(
    defaultAddress: string,
    defaultProtocol: string,
  ): Port | undefined {
    const selected = this.boards.port;
    if (selected?.address) {
      return selected;
    }
    if (defaultAddress) {
      return {
        address: defaultAddress,
        label: defaultAddress,
        protocol: defaultProtocol || "serial",
        protocol_label: "",
        properties: {},
        hardware_id: "",
      };
    }
    return undefined;
  }

  /**
   * Prompt for any user fields the board's upload tool requires. Returns the
   * collected map, an empty map when none are needed, or `undefined` if the user
   * cancelled a prompt (caller should abort).
   */
  private async collectUserFields(
    fqbn: string,
    protocol: string,
    instance?: ArduinoInstance,
  ): Promise<Record<string, string> | undefined> {
    const res = await this.client.supportedUserFields(fqbn, protocol, instance);
    const fields = res.user_fields ?? [];
    const values: Record<string, string> = {};
    for (const f of fields) {
      const value = await vscode.window.showInputBox({
        title: vscode.l10n.t("Upload to {0}", fqbn),
        prompt: f.label,
        password: f.secret,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return undefined;
      }
      values[f.name] = value;
    }
    return values;
  }

  /** Upload via an external programmer (compile first is the caller's responsibility). */
  async runWithProgrammer(target?: vscode.Uri | string): Promise<boolean> {
    const sketch = await resolveSketch(this.client, { target });
    if (!sketch) {
      return false;
    }

    const exec = await prepareExecution(
      this.client, this.boards, sketch, this.platforms, this.output, "upload",
    );
    if (!exec) {
      return false;
    }
    const fqbn = exec.fqbn;
    if (!fqbn) {
      await this.promptSelectBoard(
        vscode.l10n.t("No board selected for this sketch."),
      );
      return false;
    }

    const port = this.resolvePort(sketch.default_port, sketch.default_protocol);
    if (!port) {
      await this.promptSelectBoard(
        vscode.l10n.t("No port selected. Pick a board on a connected port."),
      );
      return false;
    }

    const programmer = await this.pickProgrammer(fqbn, exec.instance);
    if (!programmer) {
      return false;
    }

    const userFields = await this.collectUserFields(
      fqbn,
      port.protocol,
      exec.instance,
    );
    if (userFields === undefined) {
      return false;
    }

    this.output.show(true);
    this.output.appendLine(
      `\n[upload-programmer] ${fqbn} -> ${port.address} (${programmer})`,
    );

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t(
          "Uploading to {0} using programmer…",
          port.label || port.address,
        ),
        cancellable: true,
      },
      async (_progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          await this.client.uploadUsingProgrammer(
            {
              fqbn,
              sketch_path: sketch.location_path,
              port,
              programmer,
              ...(this.verbose() ? { verbose: true } : {}),
              user_fields: userFields,
              ...(exec.instance ? { instance: exec.instance } : {}),
            },
            {
              out: (s) => this.output.append(s),
              err: (s) => this.output.append(s),
            },
            ac.signal,
          );
          vscode.window.showInformationMessage(
            vscode.l10n.t("Upload complete."),
          );
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[upload-programmer] cancelled");
            return false;
          }
          this.output.appendLine(
            `[upload-programmer] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Upload failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }

  /** Burn the bootloader onto the board via a programmer. */
  async burnBootloader(): Promise<boolean> {
    const fqbn = this.boards.fqbn;
    if (!fqbn) {
      await this.promptSelectBoard(
        vscode.l10n.t("No board selected for this sketch."),
      );
      return false;
    }

    const port = this.boards.port;
    if (!port?.address) {
      await this.promptSelectBoard(
        vscode.l10n.t("No port selected. Pick a board on a connected port."),
      );
      return false;
    }

    const programmer = await this.pickProgrammer(fqbn);
    if (!programmer) {
      return false;
    }

    const userFields = await this.collectUserFields(fqbn, port.protocol);
    if (userFields === undefined) {
      return false;
    }

    this.output.show(true);
    this.output.appendLine(
      `\n[burn-bootloader] ${fqbn} -> ${port.address} (${programmer})`,
    );

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Burning bootloader on {0}…", port.label || port.address),
        cancellable: true,
      },
      async (_progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          await this.client.burnBootloader(
            {
              fqbn,
              port,
              programmer,
              ...(this.verbose() ? { verbose: true } : {}),
              user_fields: userFields,
            },
            {
              out: (s) => this.output.append(s),
              err: (s) => this.output.append(s),
            },
            ac.signal,
          );
          vscode.window.showInformationMessage(
            vscode.l10n.t("Bootloader burned successfully."),
          );
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[burn-bootloader] cancelled");
            return false;
          }
          this.output.appendLine(
            `[burn-bootloader] failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          vscode.window.showErrorMessage(
            vscode.l10n.t("Burn bootloader failed — see the Arduino CLI output."),
          );
          return false;
        }
      },
    );
  }

  private verbose(): boolean {
    return vscode.workspace.getConfiguration("arduinoCli").get<boolean>("verbose", false);
  }

  private async pickProgrammer(
    fqbn: string,
    instance?: ArduinoInstance,
  ): Promise<string | undefined> {
    const res = await this.client.listProgrammers(fqbn, instance);
    const programmers = res.programmers ?? [];
    if (programmers.length === 0) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("No programmers available for this board."),
      );
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      programmers.map((p) => ({
        label: p.name,
        description: p.id,
        id: p.id,
      })),
      {
        title: vscode.l10n.t("Select Programmer"),
        placeHolder: vscode.l10n.t("Pick a programmer for this board"),
      },
    );
    return pick?.id;
  }

  private async promptSelectBoard(message: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      message,
      vscode.l10n.t("Select Board"),
    );
    if (choice) {
      await this.boards.selectBoard();
    }
  }
}
