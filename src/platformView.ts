import * as vscode from "vscode";
import type { PlatformManager } from "./platformManager";

/**
 * Tree view of *installed* platforms/cores, modelled on the sibling Libraries
 * view ([libraryView.ts]): the tree is a browse/manage surface, while finding
 * and installing a core is a separate QuickPick action (`installPlatform`).
 *
 * Operates on the GLOBAL instance. Profile-isolated cores live in arduino-cli's
 * opaque managed cache and are intentionally not shown here.
 *
 * Installed items expose inline uninstall (and upgrade when an update exists).
 */

export interface PlatNode {
  kind: "platform";
  id: string;
  name: string;
  version: string;
  updatable: boolean;
}

export class PlatformTreeProvider implements vscode.TreeDataProvider<PlatNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    PlatNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: PlatNode[] = [];
  private loaded = false;

  constructor(private readonly resolve: () => Promise<PlatformManager>) {}

  /** Re-fetch installed platforms and repaint. */
  async refresh(): Promise<void> {
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: PlatNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.updatable
      ? vscode.l10n.t("{0} — update available", node.version)
      : node.version;
    item.tooltip = node.id;
    item.iconPath = new vscode.ThemeIcon(
      node.updatable ? "arrow-up" : "circuit-board",
    );
    item.contextValue = node.updatable
      ? "arduinoPlatformInstalledUpdatable"
      : "arduinoPlatformInstalled";
    return item;
  }

  async getChildren(node?: PlatNode): Promise<PlatNode[]> {
    if (node) {
      return [];
    }
    if (!this.loaded) {
      await this.load();
    }
    return this.items;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    try {
      const platforms = await this.resolve();
      const installed = await platforms.listInstalled();
      this.items = installed
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ kind: "platform" as const, ...p }));
    } catch (err) {
      this.items = [];
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Arduino CLI: {0}",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }
}
