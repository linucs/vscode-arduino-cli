import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import { resolveSketch } from "./sketch";
import type {
  BoardDetailsResponse,
  BoardListItem,
  BoardListWatchResponse,
  ConfigOption,
  DetectedPort,
  Port,
} from "./proto/types";

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

  /** QuickPick over detected ports → matching boards; falls back to search or identify. */
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
      let board: { fqbn: string; name: string } | undefined;

      // Try auto-identifying the board from port properties first.
      if (pick.port && Object.keys(pick.port.properties ?? {}).length > 0) {
        board = await this.identifyBoard(pick.port);
      }

      if (!board) {
        board = await this.pickBoardViaSearch();
      }
      if (!board) {
        return;
      }

      const fqbn = await this.configureBoardOptions(board.fqbn);
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
      await this.persist({ fqbn, boardName: board.name, port });
      return;
    }

    const fqbn = await this.configureBoardOptions(pick.fqbn);
    await this.persist({
      fqbn,
      boardName: pick.boardName ?? pick.fqbn,
      port: pick.port!,
    });
  }

  // --- BoardIdentify ---------------------------------------------------------

  /** Try to identify an unknown board from its port properties. */
  private async identifyBoard(
    port: Port,
  ): Promise<{ fqbn: string; name: string } | undefined> {
    this.output.appendLine(
      `[boards] identifying board on ${port.label || port.address}…`,
    );
    let boards: BoardListItem[];
    try {
      const res = await this.client.boardIdentify(port.properties, true);
      boards = res.boards ?? [];
    } catch (err) {
      this.output.appendLine(
        `[boards] identify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (boards.length === 0) {
      return undefined;
    }

    type IdItem = vscode.QuickPickItem & { fqbn?: string; boardName?: string };
    const items: IdItem[] = boards.map((b) => ({
      label: `$(circuit-board) ${b.name}`,
      description: b.fqbn,
      fqbn: b.fqbn,
      boardName: b.name,
      alwaysShow: true,
    }));
    items.push({
      label: vscode.l10n.t("$(search) None of these — search manually"),
      alwaysShow: true,
    });

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Board identified on {0}", port.label || port.address),
      placeHolder: vscode.l10n.t("Select the matching board, or search manually"),
      matchOnDescription: true,
    });
    if (!pick?.fqbn) {
      return undefined;
    }
    return { fqbn: pick.fqbn, name: pick.boardName ?? pick.fqbn };
  }

  // --- BoardSearch (search-as-you-type) --------------------------------------

  /** Managed QuickPick with server-side board search. */
  private pickBoardViaSearch(): Promise<
    { fqbn: string; name: string } | undefined
  > {
    type Item = vscode.QuickPickItem & { fqbn: string; boardName: string };
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = vscode.l10n.t("Select Arduino Board");
      qp.placeholder = vscode.l10n.t(
        "Type to search all Arduino boards",
      );
      qp.matchOnDetail = true;

      let seq = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const search = (raw: string): void => {
        const query = raw.trim();
        if (query.length < 2) {
          qp.items = [];
          qp.busy = false;
          return;
        }
        const mySeq = ++seq;
        qp.busy = true;
        this.client
          .boardSearch(query)
          .then((res) => {
            if (mySeq !== seq) {
              return;
            }
            qp.items = (res.boards ?? []).map((b) => ({
              label: b.name,
              description:
                b.platform?.release?.name ?? b.platform?.metadata?.id ?? "",
              detail: b.fqbn,
              alwaysShow: true,
              fqbn: b.fqbn,
              boardName: b.name,
            }));
            qp.busy = false;
          })
          .catch(() => {
            if (mySeq === seq) {
              qp.busy = false;
            }
          });
      };

      qp.onDidChangeValue((value) => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => search(value), 250);
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        resolve(sel ? { fqbn: sel.fqbn, name: sel.boardName } : undefined);
        qp.hide();
      });
      qp.onDidHide(() => {
        if (timer) {
          clearTimeout(timer);
        }
        qp.dispose();
        resolve(undefined);
      });
      qp.show();
    });
  }

  // --- BoardDetails (config options) -----------------------------------------

  /**
   * Fetch config options for a board and let the user choose values. Returns an
   * FQBN with selected options appended (e.g. `arduino:avr:mega:cpu=atmega2560`).
   */
  private async configureBoardOptions(fqbn: string): Promise<string> {
    const baseFqbn = fqbn.split(":").slice(0, 3).join(":");
    let details: BoardDetailsResponse;
    try {
      details = await this.client.boardDetails(baseFqbn);
    } catch {
      return fqbn;
    }

    const options = (details.config_options ?? []).filter(
      (o) => o.values.length > 1,
    );
    if (options.length === 0) {
      return baseFqbn;
    }

    const selected: string[] = [];
    for (const opt of options) {
      const defaultVal = opt.values.find((v) => v.selected) ?? opt.values[0];
      const pick = await this.pickConfigOption(opt, defaultVal.value);
      selected.push(`${opt.option}=${pick ?? defaultVal.value}`);
    }

    return `${baseFqbn}:${selected.join(",")}`;
  }

  private async pickConfigOption(
    opt: ConfigOption,
    activeValue: string,
  ): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { optValue: string };
    const items: Item[] = opt.values.map((v) => ({
      label: v.value_label,
      description: v.value,
      picked: v.value === activeValue,
      alwaysShow: true,
      optValue: v.value,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      title: opt.option_label,
      placeHolder: vscode.l10n.t(
        "Select a value for {0}",
        opt.option_label,
      ),
    });
    return pick?.optValue;
  }

  // --- Board Details command -------------------------------------------------

  /** Show board details for the currently selected board. */
  async showBoardDetails(): Promise<void> {
    const sel = this.requireSelection();
    const baseFqbn = sel.fqbn.split(":").slice(0, 3).join(":");

    const details = await this.client.boardDetails(baseFqbn);

    const lines: string[] = [
      `${details.name} (${details.fqbn})`,
      "",
      `${vscode.l10n.t("Platform")}: ${details.platform?.name ?? "—"} ${details.version || ""}`.trim(),
      `${vscode.l10n.t("Official")}: ${details.official ? vscode.l10n.t("Yes") : vscode.l10n.t("No")}`,
    ];

    if (details.config_options?.length) {
      lines.push("", vscode.l10n.t("Config options:"));
      for (const opt of details.config_options) {
        const cur = opt.values.find((v) => v.selected);
        lines.push(
          `  ${opt.option_label}: ${cur?.value_label ?? "—"}`,
        );
      }
    }

    if (details.programmers?.length) {
      lines.push(
        "",
        `${vscode.l10n.t("Default programmer")}: ${
          details.programmers.find((p) => p.id === details.default_programmer_id)
            ?.name ?? (details.default_programmer_id || "—")
        }`,
      );
    }

    const actions: string[] = [];
    if (details.pinout) {
      actions.push(vscode.l10n.t("View Pinout"));
    }
    const picked = await vscode.window.showInformationMessage(
      lines.join("\n"),
      { modal: true },
      ...actions,
    );
    if (picked === vscode.l10n.t("View Pinout") && details.pinout) {
      await vscode.env.openExternal(vscode.Uri.parse(details.pinout));
    }
  }

  // --- Persist ---------------------------------------------------------------

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
      return;
    }
    if (!sketch) {
      return;
    }
    try {
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
