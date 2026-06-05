import * as vscode from "vscode";
import type { LibraryManager } from "./libraryManager";

/**
 * Tree view of *installed* Arduino libraries, modelled on the sibling extension's
 * catalog view: the tree is a browse/manage surface, while finding and adding a
 * library is a separate **standard QuickPick** action (`addLibrary`) — VS Code's
 * built-in fuzzy filter does the searching, so the tree doesn't reimplement it.
 *
 * Installed items expose inline uninstall (and upgrade when an update exists).
 */

export interface LibNode {
  kind: "lib";
  name: string;
  version: string;
  sentence: string;
  updatable: boolean;
}

export class LibraryTreeProvider implements vscode.TreeDataProvider<LibNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    LibNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: LibNode[] = [];
  private loaded = false;

  constructor(private readonly resolve: () => Promise<LibraryManager>) {}

  /** Re-fetch installed libraries and repaint. */
  async refresh(): Promise<void> {
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: LibNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.updatable
      ? vscode.l10n.t("{0} — update available", node.version)
      : node.version;
    item.tooltip = node.sentence || undefined;
    item.iconPath = new vscode.ThemeIcon(node.updatable ? "arrow-up" : "library");
    item.contextValue = node.updatable
      ? "arduinoLibInstalledUpdatable"
      : "arduinoLibInstalled";
    return item;
  }

  async getChildren(node?: LibNode): Promise<LibNode[]> {
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
      const libraries = await this.resolve();
      const { installed, updatable } = await libraries.listInstalled();
      this.items = installed
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({
          kind: "lib" as const,
          name: l.name,
          version: l.version,
          sentence: l.sentence,
          updatable: updatable.has(l.name),
        }));
    } catch (err) {
      this.items = [];
      vscode.window.showErrorMessage(
        vscode.l10n.t("Arduino CLI: {0}", err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
