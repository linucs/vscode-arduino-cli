import * as vscode from "vscode";
import type {
  ArduinoClient,
  ArduinoInstance,
  MonitorStream,
} from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import { defaultSaveUri, notifySaved } from "./fileActions";
import { PlotterPanel } from "./plotterPanel";
import { resolveSketch } from "./sketch";
import { resolveExecution } from "./profileMode";
import { splitLines, parseTelemetryLine } from "./telemetryParser";
import type { MonitorResponse, Port } from "./proto/types";

interface Session {
  terminal: vscode.Terminal;
  port: Port;
  fqbn: string;
  portConfig?: object;
  /** Profile-bound instance when the sketch is in profile mode. */
  instance?: ArduinoInstance;
  stream?: MonitorStream;
  write: vscode.EventEmitter<string>;
  /** Line-buffered input, sent on Enter. */
  lineBuf: string;
  /** True when we closed the session ourselves (upload/dispose). */
  closing: boolean;
  /** Raw rx log with timestamps for save/export. */
  log: { ts: number; text: string }[];
}

/**
 * Manages a single serial monitor session as a `vscode.Pseudoterminal` over the
 * bidirectional Monitor stream. Handles the open handshake, rx→terminal,
 * line-buffered terminal→tx, a baud picker, and suspend/resume around uploads
 * (the monitor holds the port, so it must release it for the upload tool).
 */
export class SerialMonitor {
  private session: Session | undefined;
  /** Saved monitor state while a debug session holds the port. */
  private debugSnapshot: { fqbn: string; portConfig?: object } | undefined;
  /** Line buffer for parsing telemetry across rx chunk boundaries. */
  private plotLineBuf = "";

  constructor(
    private readonly client: ArduinoClient,
    private readonly boards: BoardManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Open a monitor on the selected port, or focus the existing one. */
  async openOrFocus(sketchTarget?: vscode.Uri | string): Promise<void> {
    const target = await this.resolveTarget(false, sketchTarget);
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
    const portConfig = await this.pickConfiguration(
      target.port.protocol,
      target.fqbn,
      target.instance,
    );
    this.openSession(target.port, target.fqbn, portConfig, target.instance);
  }

  /** Save the captured serial log to a file (plain text or CSV with timestamps). */
  async saveLog(): Promise<void> {
    if (!this.session || this.session.log.length === 0) {
      vscode.window.showInformationMessage(
        vscode.l10n.t("No serial data captured yet."),
      );
      return;
    }

    const format = await vscode.window.showQuickPick(
      [
        { label: "Plain text", id: "txt" },
        { label: "CSV (timestamp, data)", id: "csv" },
      ],
      { title: vscode.l10n.t("Save Serial Log") },
    );
    if (!format) {
      return;
    }

    const ext = format.id === "csv" ? "csv" : "txt";
    const dest = await vscode.window.showSaveDialog({
      title: vscode.l10n.t("Save Serial Log"),
      filters: { [format.label]: [ext] },
      defaultUri: defaultSaveUri(`serial-log.${ext}`),
    });
    if (!dest) {
      return;
    }

    let content: string;
    if (format.id === "csv") {
      const rows = ["timestamp,data"];
      for (const entry of this.session.log) {
        const escaped = entry.text.replace(/"/g, '""').replace(/\r?\n/g, "\\n");
        rows.push(`${entry.ts},"${escaped}"`);
      }
      content = rows.join("\n");
    } else {
      content = this.session.log.map((e) => e.text).join("");
    }

    await vscode.workspace.fs.writeFile(dest, Buffer.from(content, "utf8"));
    void notifySaved(
      vscode.l10n.t("Serial log saved to {0}", dest.fsPath),
      dest.fsPath,
      "open",
    );
  }

  /** Open (or reveal) the serial plotter webview panel. */
  openPlotter(extensionUri: vscode.Uri): void {
    const panel = PlotterPanel.show(extensionUri);
    if (this.session) {
      panel.notifyConnected();
    }
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
          this.openSession(
            target.port,
            snapshot.fqbn,
            snapshot.portConfig,
            target.instance,
          );
        }
      }
    }
  }

  /**
   * Close the monitor for the duration of a debug session and remember its
   * state. Unlike `runWithMonitorSuspended`, resume is a separate call because a
   * debug session outlives the function that starts it (it ends on a VS Code
   * event, not when `startDebugging` resolves). Pair with `resumeAfterDebug`.
   */
  suspendForDebug(): void {
    if (this.session) {
      this.debugSnapshot = {
        fqbn: this.session.fqbn,
        portConfig: this.session.portConfig,
      };
      this.closeSession();
    }
  }

  /** Reopen the monitor closed by `suspendForDebug`, if auto-reconnect is on. */
  async resumeAfterDebug(): Promise<void> {
    const snapshot = this.debugSnapshot;
    this.debugSnapshot = undefined;
    if (!snapshot) {
      return;
    }
    const reconnect = vscode.workspace
      .getConfiguration("arduinoCli")
      .get<boolean>("monitor.autoReconnect", true);
    if (!reconnect) {
      return;
    }
    const target = await this.resolveTarget(true);
    if (target?.port.address) {
      this.openSession(
        target.port,
        snapshot.fqbn,
        snapshot.portConfig,
        target.instance,
      );
    }
  }

  dispose(): void {
    this.closeSession();
  }

  // --- session lifecycle ----------------------------------------------------

  private openSession(
    port: Port,
    fqbn: string,
    portConfig?: object,
    instance?: ArduinoInstance,
  ): void {
    const write = new vscode.EventEmitter<string>();
    const session: Session = {
      terminal: undefined as unknown as vscode.Terminal,
      port,
      fqbn,
      portConfig,
      instance,
      write,
      lineBuf: "",
      closing: false,
      log: [],
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
            ...(instance ? { instance } : {}),
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
    PlotterPanel.current()?.notifyConnected();
  }

  private closeSession(): void {
    const s = this.session;
    if (!s) {
      return;
    }
    s.closing = true;
    this.plotLineBuf = "";
    PlotterPanel.current()?.notifyDisconnected();
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
      case "rx_data": {
        const text = Buffer.from(msg.rx_data ?? []).toString("utf8");
        session.write.fire(toCRLF(text));
        session.log.push({ ts: Date.now(), text });
        this.feedPlotter(text);
        break;
      }
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

  // --- plotter feed ----------------------------------------------------------

  private feedPlotter(chunk: string): void {
    const plotter = PlotterPanel.current();
    if (!plotter?.alive) {
      return;
    }
    const { lines, rest } = splitLines(this.plotLineBuf, chunk);
    this.plotLineBuf = rest;
    const points = lines
      .map(parseTelemetryLine)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    if (points.length > 0) {
      plotter.postData(points);
    }
  }

  // --- resolution helpers ---------------------------------------------------

  private async resolveTarget(
    silent = false,
    sketchTarget?: vscode.Uri | string,
  ): Promise<
    { port: Port; fqbn: string; instance?: ArduinoInstance } | undefined
  > {
    const sketch = await resolveSketch(this.client, {
      silent: true,
      target: sketchTarget,
    });
    // Profile mode: board + instance come from the profile. Global mode: keep
    // today's behavior (status-bar selection or default_fqbn).
    // Opening the monitor must not trigger the profile's platform download; use
    // the profile instance only if it is already built, else fall back below.
    const exec = sketch
      ? await resolveExecution(this.client, this.boards, sketch, {
          create: false,
        })
      : undefined;
    const fqbn = exec?.fqbn ?? this.boards.fqbn ?? "";
    const instance = exec?.instance;
    const selected = this.boards.port;
    if (selected?.address) {
      return { port: selected, fqbn, instance };
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
        instance,
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
    instance?: ArduinoInstance,
  ): Promise<object | undefined> {
    let res;
    try {
      res = await this.client.enumerateMonitorPortSettings(
        protocol,
        fqbn,
        instance,
      );
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
