import * as path from "node:path";
import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { ProfileLibraryReference } from "./proto/types";

/**
 * Tree of libraries pinned in the **default profile** of the active sketch.
 * Shown only in profile mode (the `arduinoCli.profileMode` context key gates the
 * view in package.json). The profile name is surfaced as the view description.
 *
 * Data comes from `ProfileLibList` (the authoritative profile contents), not
 * from the globally-installed set. Items expose an inline "remove from profile"
 * action; installed-library items in the sibling view expose "add to profile".
 */

export interface ProfileLibNode {
  kind: "profileLib";
  label: string;
  version?: string;
  isLocal: boolean;
  /** The reference to hand back to `ProfileLibRemove`. */
  ref: ProfileLibraryReference;
}

/** The active sketch's default-profile context, or undefined outside profile mode. */
export interface ProfileContext {
  sketchPath: string;
  profileName: string;
}

export class ProfileLibraryTreeProvider
  implements vscode.TreeDataProvider<ProfileLibNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ProfileLibNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly resolveClient: () => Promise<ArduinoClient>,
    private readonly getContext: () => ProfileContext | undefined,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: ProfileLibNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.isLocal ? vscode.l10n.t("local") : node.version;
    item.iconPath = new vscode.ThemeIcon(node.isLocal ? "file-directory" : "library");
    item.contextValue = "arduinoProfileLib";
    return item;
  }

  async getChildren(node?: ProfileLibNode): Promise<ProfileLibNode[]> {
    if (node) {
      return [];
    }
    const ctx = this.getContext();
    if (!ctx) {
      return [];
    }
    try {
      const client = await this.resolveClient();
      const res = await client.profileLibList(ctx.sketchPath, ctx.profileName);
      return (res.libraries ?? [])
        .map((ref) => toNode(ref))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Arduino CLI: {0}", err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }
}

function toNode(ref: ProfileLibraryReference): ProfileLibNode {
  const idx = ref.index_library;
  const loc = ref.local_library;
  if (idx) {
    return {
      kind: "profileLib",
      label: idx.name,
      version: idx.version,
      isLocal: false,
      ref,
    };
  }
  return {
    kind: "profileLib",
    label: loc ? path.basename(loc.path) : "?",
    isLocal: true,
    ref,
  };
}
