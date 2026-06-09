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
  paragraph: string;
  maintainer: string;
  license: string;
  category: string;
  /** Owning platform for bundled libraries (e.g. `arduino:avr`); "" otherwise. */
  containerPlatform: string;
  updatable: boolean;
  /** `url` from library.properties; "" when the library declares none. */
  website: string;
  /** Absolute paths to the library's example sketch directories. */
  examples: string[];
  /** Header files the library provides (from `includes` / source root). */
  providesIncludes: string[];
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
    item.tooltip = buildTooltip(node);
    item.iconPath = new vscode.ThemeIcon(node.updatable ? "arrow-up" : "library");
    // Compose availability flags so the context menu can gate the website/example
    // actions; keep the `arduinoLibInstalled[Updatable]` prefix the other menus
    // match against.
    let cv = "arduinoLibInstalled";
    if (node.updatable) {
      cv += "Updatable";
    }
    if (node.website) {
      cv += " hasWeb";
    }
    if (node.examples.length) {
      cv += " hasEx";
    }
    item.contextValue = cv;
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
          paragraph: l.paragraph,
          maintainer: l.maintainer,
          license: l.license,
          category: l.category,
          containerPlatform: l.containerPlatform,
          updatable: updatable.has(l.name),
          website: l.website,
          examples: l.examples,
          providesIncludes: l.providesIncludes,
        }));
    } catch (err) {
      this.items = [];
      vscode.window.showErrorMessage(
        vscode.l10n.t("Arduino CLI: {0}", err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/**
 * Hover card for an installed library: name/version header, description, then a
 * metadata block (category, maintainer, license, owning platform, provided
 * headers). Values are appended as text so library metadata can't inject markup.
 */
function buildTooltip(node: LibNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${node.name}** ${node.version}\n\n`);
  if (node.sentence) {
    md.appendText(node.sentence);
    md.appendMarkdown("\n\n");
  }
  if (node.paragraph && node.paragraph !== node.sentence) {
    md.appendText(node.paragraph);
    md.appendMarkdown("\n\n");
  }
  const meta: [string, string][] = [
    [vscode.l10n.t("Category"), node.category],
    [vscode.l10n.t("Maintainer"), node.maintainer],
    [vscode.l10n.t("License"), node.license],
    [vscode.l10n.t("Built-in"), node.containerPlatform],
    [vscode.l10n.t("Provides"), node.providesIncludes.join(", ")],
  ];
  const rows = meta.filter(([, value]) => value);
  rows.forEach(([label, value], i) => {
    md.appendMarkdown(`**${label}:** `);
    md.appendText(value);
    if (i < rows.length - 1) {
      md.appendMarkdown("\n\n");
    }
  });
  return md;
}
