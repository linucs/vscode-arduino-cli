import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { defaultSaveUri, notifySaved } from "./fileActions";
import type { ParsedTelemetry } from "./telemetryParser";

const VIEW_TYPE = "arduinoCli.plotter";

/**
 * Manages a single webview panel that renders serial telemetry as charts.
 * The extension posts parsed telemetry points; the webview renders them with
 * uPlot. The panel survives monitor disconnects (data is preserved) and
 * disposes when the user closes it.
 */
export class PlotterPanel {
  private static instance: PlotterPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this.panel = panel;
    panel.webview.html = this.buildHtml(panel.webview, extensionUri);
    panel.onDidDispose(() => {
      this.disposed = true;
      PlotterPanel.instance = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  static show(extensionUri: vscode.Uri): PlotterPanel {
    if (PlotterPanel.instance) {
      PlotterPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return PlotterPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Serial Plotter",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        retainContextWhenHidden: true,
      },
    );
    PlotterPanel.instance = new PlotterPanel(panel, extensionUri);
    return PlotterPanel.instance;
  }

  static current(): PlotterPanel | undefined {
    return PlotterPanel.instance;
  }

  get alive(): boolean {
    return !this.disposed;
  }

  postData(points: ParsedTelemetry[]): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({ type: "data", points });
  }

  notifyDisconnected(): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "disconnected" });
    }
  }

  notifyConnected(): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "connected" });
    }
  }

  // --- internals -------------------------------------------------------------

  private buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
    const uplotJs = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "vendor", "uplot", "uPlot.min.js"),
    );
    const uplotCss = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "vendor", "uplot", "uPlot.min.css"),
    );
    const plotterJs = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "plotter.js"),
    );
    const plotterCss = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaUri, "plotter.css"),
    );

    const htmlPath = path.join(extensionUri.fsPath, "media", "plotter.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{uplotJs\}\}/g, uplotJs.toString())
      .replace(/\{\{uplotCss\}\}/g, uplotCss.toString())
      .replace(/\{\{plotterJs\}\}/g, plotterJs.toString())
      .replace(/\{\{plotterCss\}\}/g, plotterCss.toString());
    return html;
  }

  private async onMessage(msg: { type: string; csv?: string }): Promise<void> {
    if (msg.type === "exportCsv" && msg.csv) {
      const dest = await vscode.window.showSaveDialog({
        title: vscode.l10n.t("Export Plotter Data"),
        filters: { CSV: ["csv"] },
        defaultUri: defaultSaveUri("serial-data.csv"),
      });
      if (dest) {
        await vscode.workspace.fs.writeFile(
          dest,
          Buffer.from(msg.csv, "utf8"),
        );
        void notifySaved(
          vscode.l10n.t("Data exported to {0}", path.basename(dest.fsPath)),
          dest.fsPath,
          "open",
        );
      }
    }
  }
}
