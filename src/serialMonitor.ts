import * as vscode from "vscode";
import type { ArduinoClient, MonitorStream } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import { resolveSketch } from "./sketch";
import type { MonitorResponse, Port } from "./proto/types";

interface Session {
  terminal: vscode.Terminal;
  port: Port;
  fqbn: string;
  portConfig?: object;
  stream?: MonitorStream;
  write: vscode.EventEmitter<string>;
  /** Line-buffered input, sent on Enter. */
  lineBuf: string;
  /** True when we closed the session ourselves (upload/dispose). */
  closing: boolean;
}

/**
 * Manages a single serial monitor session as a `vscode.Pseudoterminal` over the
 * bidirectional Monitor stream. Handles the open handshake, rx→terminal,
 * line-buffered terminal→tx, a baud picker, and suspend/resume around uploads
 * (the monitor holds the port, so it must release it for the upload tool).
 */
export class SerialMonitor {
  private session: Session | undefined;

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Open a monitor on the selected port, or focus the existing one. */
  async openOrFocus(): Promise<void> {
    const target = await this.resolveTarget();
    if (!target) {
      return;
    }
    if (this.session) {
      if (this.session.port.address === target.port.address) {
        this.session.terminal.show();
        return;
      }
      this.closeSession();
    }
    const portConfig = await this.pickConfiguration(target.port.protocol, target.fqbn);
    this.openSession(target.port, target.fqbn, portConfig);
  }

  /**
   * Run `action` (an upload) with the monitor released, then reopen it if it was
   * open and auto-reconnect is enabled. The port is re-resolved on reopen so
   * native-USB boards that re-enumerate after upload still reconnect.
   */
  async runWithMonitorSuspended<T>(action: () => Promise<T>): Promise<T> {
    const snapshot = this.session
      ? {
          fqbn: this.session.fqbn,
          portConfig: this.session.portConfig,
        }
      : undefined;
    if (this.session) {
      this.closeSession();
    }
    try {
      return await action();
    } finally {
      const reconnect = vscode.workspace
        .getConfiguration("arduinoCli")
        .get<boolean>("monitor.autoReconnect", true);
      if (snapshot && reconnect) {
        // Give the OS a moment to re-enumerate the port after reset.
        await new Promise((r) => setTimeout(r, 1500));
        const target = await this.resolveTarget(true);
        if (target?.port.address) {
          this.openSession(target.port, snapshot.fqbn, snapshot.portConfig);
        }
      }
    }
  }

  dispose(): void {
    this.closeSession();
  }

  // --- session lifecycle ----------------------------------------------------

  private openSession(port: Port, fqbn: string, portConfig?: object): void {
    const write = new vscode.EventEmitter<string>();
    const session: Session = {
      terminal: undefined as unknown as vscode.Terminal,
      port,
      fqbn,
      portConfig,
      write,
      lineBuf: "",
      closing: false,
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      open: () => {
        write.fire(vscode.l10n.t("Connecting to {0}…", port.address) + "\r\n");
        try {
          const stream = this.client.startMonitor({
            port,
            fqbn,
            port_configuration: portConfig,
          });
          session.stream = stream;
          stream.on("data", (msg: MonitorResponse) => this.onData(session, msg));
          stream.on("error", (err: Error) =>
            write.fire(`\r\n[error] ${err.message}\r\n`),
          );
          stream.on("end", () =>
            write.fire("\r\n" + vscode.l10n.t("[disconnected]") + "\r\n"),
          );
        } catch (err) {
          write.fire(
            `\r\n[error] ${err instanceof Error ? err.message : String(err)}\r\n`,
          );
        }
      },
      close: () => {
        // Fired when the terminal is closed (by the user or by closeSession).
        try {
          session.stream?.cancel();
        } catch {
          /* already gone */
        }
        if (this.session === session) {
          this.session = undefined;
        }
      },
      handleInput: (data: string) => this.handleInput(session, data),
    };

    session.terminal = vscode.window.createTerminal({
      name: `Serial — ${port.label || port.address}`,
      pty,
    });
    this.session = session;
    session.terminal.show();
  }

  private closeSession(): void {
    const s = this.session;
    if (!s) {
      return;
    }
    s.closing = true;
    try {
      s.stream?.close(); // graceful: daemon closes the port then the stream
    } catch {
      /* ignore */
    }
    s.terminal.dispose(); // triggers pty.close → cancel + clears this.session
  }

  // --- stream <-> terminal --------------------------------------------------

  private onData(session: Session, msg: MonitorResponse): void {
    switch (msg.message) {
      case "success":
        session.write.fire(
          vscode.l10n.t("Connected to {0}", session.port.address) + "\r\n",
        );
        break;
      case "rx_data":
        session.write.fire(toCRLF(Buffer.from(msg.rx_data ?? []).toString("utf8")));
        break;
      case "error":
        session.write.fire(`\r\n[error] ${msg.error}\r\n`);
        break;
      // applied_settings: nothing to render
    }
  }

  private handleInput(session: Session, data: string): void {
    for (const ch of data) {
      if (ch === "\r") {
        session.write.fire("\r\n");
        try {
          session.stream?.sendData(Buffer.from(session.lineBuf + "\n", "utf8"));
        } catch {
          /* stream gone */
        }
        session.lineBuf = "";
      } else if (ch === "\x7f") {
        if (session.lineBuf.length) {
          session.lineBuf = session.lineBuf.slice(0, -1);
          session.write.fire("\b \b");
        }
      } else {
        session.lineBuf += ch;
        session.write.fire(ch); // local echo
      }
    }
  }

  // --- resolution helpers ---------------------------------------------------

  private async resolveTarget(
    silent = false,
  ): Promise<{ port: Port; fqbn: string } | undefined> {
    const sketch = await resolveSketch(this.client, { silent: true });
    const fqbn = this.boards.fqbn || sketch?.default_fqbn || "";
    const selected = this.boards.port;
    if (selected?.address) {
      return { port: selected, fqbn };
    }
    if (sketch?.default_port) {
      return {
        port: {
          address: sketch.default_port,
          label: sketch.default_port,
          protocol: sketch.default_protocol || "serial",
          protocol_label: "",
          properties: {},
          hardware_id: "",
        },
        fqbn,
      };
    }
    if (!silent) {
      const pick = await vscode.window.showWarningMessage(
        vscode.l10n.t("No port selected. Pick a board on a connected port."),
        vscode.l10n.t("Select Board"),
      );
      if (pick) {
        await this.boards.selectBoard();
      }
    }
    return undefined;
  }

  /** Prompt for a baud rate when the port's monitor advertises one. */
  private async pickConfiguration(
    protocol: string,
    fqbn: string,
  ): Promise<object | undefined> {
    let res;
    try {
      res = await this.client.enumerateMonitorPortSettings(protocol, fqbn);
    } catch {
      // Monitor settings unavailable (e.g. platform not installed) — open with defaults.
      return undefined;
    }
    const baud = (res.settings ?? []).find(
      (s) => /baud/i.test(s.setting_id) || /baud/i.test(s.label),
    );
    if (!baud || !baud.enum_values?.length) {
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(baud.enum_values, {
      title: vscode.l10n.t("Baud Rate"),
      placeHolder: baud.value,
    });
    const value = pick ?? baud.value;
    if (!value) {
      return undefined;
    }
    return { settings: [{ setting_id: baud.setting_id, value }] };
  }
}

/** Normalize line endings to CRLF for terminal display (avoids doubling). */
function toCRLF(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}
