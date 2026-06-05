import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import { resolveSketch } from "./sketch";
import type { BoardListWatchResponse, DetectedPort, Port } from "./proto/types";

const STATE_KEY = "arduinoCli.selectedBoard";

/** Persisted board selection. The full Port is kept for upload/monitor. */
interface Selection {
  fqbn: string;
  boardName: string;
  port: Port;
}

/**
 * Owns the user's board+port selection: a status-bar item, a QuickPick backed by
 * `BoardList`, and a long-lived `BoardListWatch` subscription that tracks live
 * ports. The watch is bound to the daemon instance, so it is torn down and
 * recreated across daemon restarts (see `restartWatch`).
 */
export class BoardManager {
  private selection: Selection | undefined;
  private readonly status: vscode.StatusBarItem;
  private watchAbort: AbortController | undefined;
  private disposed = false;
  /** Live ports keyed by address, maintained from the watch stream. */
  private readonly livePorts = new Map<string, DetectedPort>();

  constructor(
    private readonly client: ArduinoClient,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.selection = context.workspaceState.get<Selection>(STATE_KEY);
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.status.command = "arduinoCli.selectBoard";
    context.subscriptions.push(this.status);
    this.render();
    this.status.show();
  }

  get fqbn(): string | undefined {
    return this.selection?.fqbn;
  }

  get port(): Port | undefined {
    return this.selection?.port;
  }

  /** Throws a user-facing error if nothing is selected; returns the selection otherwise. */
  requireSelection(): Selection {
    if (!this.selection) {
      throw new Error(
        vscode.l10n.t("No board selected. Run “Arduino CLI: Select Board” first."),
      );
    }
    return this.selection;
  }

  /** QuickPick over detected ports → matching boards; falls back to the full catalog. */
  async selectBoard(): Promise<void> {
    const res = await this.client.boardList();
    type Item = vscode.QuickPickItem & {
      fqbn?: string;
      boardName?: string;
      port?: Port;
      manual?: boolean;
    };
    const items: Item[] = [];
    for (const dp of res.ports ?? []) {
      const boards = dp.matching_boards ?? [];
      if (boards.length === 0) {
        items.push({
          label: `$(circle-outline) ${dp.port.label || dp.port.address}`,
          description: dp.port.protocol_label || dp.port.protocol,
          detail: vscode.l10n.t("Unknown board — pick one manually"),
          port: dp.port,
          manual: true,
        });
      }
      for (const b of boards) {
        items.push({
          label: `$(circuit-board) ${b.name}`,
          description: dp.port.label || dp.port.address,
          detail: b.fqbn,
          fqbn: b.fqbn,
          boardName: b.name,
          port: dp.port,
        });
      }
    }
    items.push({
      label: vscode.l10n.t("$(search) Choose a board manually…"),
      manual: true,
      alwaysShow: true,
    });

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Select Arduino Board"),
      placeHolder: vscode.l10n.t("Pick a connected board, or choose one manually"),
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }

    if (pick.manual || !pick.fqbn) {
      const board = await this.pickFromCatalog();
      if (!board) {
        return;
      }
      // Manual pick keeps the port if one was associated, else a bare port.
      const port =
        pick.port ??
        ({
          address: "",
          label: "",
          protocol: "serial",
          protocol_label: "",
          properties: {},
          hardware_id: "",
        } satisfies Port);
      await this.persist({ fqbn: board.fqbn, boardName: board.name, port });
      return;
    }

    await this.persist({
      fqbn: pick.fqbn,
      boardName: pick.boardName ?? pick.fqbn,
      port: pick.port!,
    });
  }

  private async pickFromCatalog(): Promise<{ fqbn: string; name: string } | undefined> {
    const all = await this.client.boardListAll();
    const pick = await vscode.window.showQuickPick(
      (all.boards ?? []).map((b) => ({
        label: b.name,
        description: b.fqbn,
        fqbn: b.fqbn,
      })),
      {
        title: vscode.l10n.t("Select Arduino Board"),
        placeHolder: vscode.l10n.t("Search installed boards by name"),
        matchOnDescription: true,
      },
    );
    return pick ? { fqbn: pick.fqbn, name: pick.label } : undefined;
  }

  /**
   * Persist a selection. The authoritative store is the sketch's `sketch.yaml`
   * (via `SetSketchDefaults`) when a sketch is unambiguously resolvable —
   * matching the Arduino IDE and keeping the plain `arduino-cli` in sync.
   * `workspaceState` is always updated too, as a fast cache and as the fallback
   * for loose `.ino` files with no resolvable project.
   */
  private async persist(sel: Selection): Promise<void> {
    this.selection = sel;
    this.render();
    await this.context.workspaceState.update(STATE_KEY, sel);
    await this.pinToSketch(sel);
  }

  private async pinToSketch(sel: Selection): Promise<void> {
    let sketch;
    try {
      sketch = await resolveSketch(this.client, { silent: true });
    } catch {
      return; // resolution failure is non-fatal; the workspaceState cache stands.
    }
    if (!sketch) {
      return;
    }
    try {
      // Only write port fields when we actually have a connected port, so a
      // manual board pick doesn't clobber an existing port in sketch.yaml.
      const hasPort = Boolean(sel.port.address);
      await this.client.setSketchDefaults({
        sketch_path: sketch.location_path,
        default_fqbn: sel.fqbn,
        ...(hasPort
          ? {
              default_port_address: sel.port.address,
              default_port_protocol: sel.port.protocol,
            }
          : {}),
      });
      this.output.appendLine(
        `[boards] pinned ${sel.fqbn}${
          hasPort ? ` @ ${sel.port.address}` : ""
        } to sketch.yaml (${sketch.location_path})`,
      );
    } catch (err) {
      this.output.appendLine(
        `[boards] could not write sketch.yaml: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- BoardListWatch lifecycle --------------------------------------------

  /** Start (or restart) the watch. Safe to call after a daemon restart. */
  restartWatch(): void {
    this.stopWatch();
    this.watchAbort = new AbortController();
    void this.runWatch(this.watchAbort.signal);
  }

  private stopWatch(): void {
    this.watchAbort?.abort();
    this.watchAbort = undefined;
    this.livePorts.clear();
  }

  /** Self-healing watch loop: reconnects until aborted. */
  private async runWatch(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.disposed) {
      try {
        await this.client.watchBoardList({
          signal,
          onEvent: (ev) => this.onWatchEvent(ev),
        });
        // Clean end (e.g. instance torn down) — stop unless we were aborted.
        if (signal.aborted) {
          return;
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        this.output.appendLine(
          `[boards] watch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Backoff before reconnecting.
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private onWatchEvent(ev: BoardListWatchResponse): void {
    if (ev.error) {
      this.output.appendLine(`[boards] ${ev.error}`);
      return;
    }
    const addr = ev.port?.port.address;
    if (!addr) {
      return;
    }
    if (ev.event_type === "add") {
      this.livePorts.set(addr, ev.port!);
    } else if (ev.event_type === "remove") {
      this.livePorts.delete(addr);
    }
    this.render();
  }

  /** True when the selected port is currently connected (or no port is required). */
  private get selectedPortConnected(): boolean {
    const addr = this.selection?.port.address;
    if (!addr) {
      return true;
    }
    return this.livePorts.has(addr);
  }

  private render(): void {
    if (!this.selection) {
      this.status.text = "$(circuit-board) " + vscode.l10n.t("No board");
      this.status.tooltip = vscode.l10n.t("Select an Arduino board");
      this.status.backgroundColor = undefined;
      return;
    }
    const portLabel =
      this.selection.port.label || this.selection.port.address || "";
    this.status.text = `$(circuit-board) ${this.selection.boardName}${
      portLabel ? ` @ ${portLabel}` : ""
    }`;
    this.status.tooltip = `${this.selection.fqbn}${
      portLabel ? `\n${portLabel}` : ""
    }`;
    this.status.backgroundColor =
      this.selection.port.address && !this.selectedPortConnected
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatch();
    this.status.dispose();
  }
}
