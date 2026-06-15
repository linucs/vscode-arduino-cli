import * as vscode from "vscode";

/**
 * File-independent action buttons in the status bar: Compile, Upload and Serial
 * Monitor. Unlike the `editor/title` buttons (gated on an active `.ino`), these
 * stay reachable whatever editor is focused — mirroring App Lab's always-visible
 * app controls. They sit just right of the board selector (priority 100); the
 * monitor-scoped line-ending/plotter items (priority 99/98, in serialMonitor.ts)
 * follow. The commands resolve their target sketch themselves (active editor →
 * workspace scan), so no argument is passed.
 */
export class StatusBarActions implements vscode.Disposable {
  private readonly items: vscode.StatusBarItem[];

  constructor() {
    // Priorities descend left-to-right to match the toolbar's button order:
    // board (100), compile, upload, monitor, then the serial items (99/98).
    this.items = [
      this.make(99.9, "$(check)", "arduinoCli.compile", vscode.l10n.t("Compile the current sketch")),
      this.make(99.8, "$(arrow-up)", "arduinoCli.upload", vscode.l10n.t("Upload the current sketch to the board")),
      this.make(99.7, "$(plug)", "arduinoCli.openMonitor", vscode.l10n.t("Open the Serial Monitor")),
    ];
    for (const item of this.items) {
      item.show();
    }
  }

  private make(
    priority: number,
    text: string,
    command: string,
    tooltip: string,
  ): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    item.text = text;
    item.command = command;
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    for (const item of this.items) {
      item.dispose();
    }
  }
}
