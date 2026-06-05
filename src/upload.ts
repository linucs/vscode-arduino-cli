import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import { resolveSketch } from "./sketch";
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
  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Upload the resolved sketch to the selected board/port. Returns true on success. */
  async run(): Promise<boolean> {
    const sketch = await resolveSketch(this.client);
    if (!sketch) {
      return false;
    }

    const fqbn = this.boards.fqbn || sketch.default_fqbn;
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

    const userFields = await this.collectUserFields(fqbn, port.protocol);
    if (userFields === undefined) {
      return false; // user cancelled a required field
    }

    this.output.show(true);
    this.output.appendLine(`\n[upload] ${fqbn} → ${port.address}`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Uploading to {0}…", port.label || port.address),
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          await this.client.upload(
            {
              fqbn,
              sketch_path: sketch.location_path,
              port,
              user_fields: userFields,
            },
            {
              out: (s) => this.output.append(s),
              err: (s) => this.output.append(s),
              progress: (t) =>
                progress.report({ message: t.message || t.name }),
            },
            ac.signal,
          );
          vscode.window.showInformationMessage(
            vscode.l10n.t("Upload complete."),
          );
          return true;
        } catch (err) {
          if (ac.signal.aborted) {
            this.output.appendLine("[upload] cancelled");
            return false;
          }
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
  ): Promise<Record<string, string> | undefined> {
    const res = await this.client.supportedUserFields(fqbn, protocol);
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
  async runWithProgrammer(): Promise<boolean> {
    const sketch = await resolveSketch(this.client);
    if (!sketch) {
      return false;
    }

    const fqbn = this.boards.fqbn || sketch.default_fqbn;
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
      `\n[upload-programmer] ${fqbn} → ${port.address} (${programmer})`,
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
              user_fields: userFields,
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
      `\n[burn-bootloader] ${fqbn} → ${port.address} (${programmer})`,
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

  private async pickProgrammer(fqbn: string): Promise<string | undefined> {
    const res = await this.client.listProgrammers(fqbn);
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
