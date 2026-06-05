import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import { resolveSketch } from "./sketch";

/** Create a new build profile in the current sketch's sketch.yaml. */
export async function createProfile(
  client: ArduinoClient,
  boards: BoardManager,
): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create Build Profile"),
    prompt: vscode.l10n.t("Profile name"),
    placeHolder: "release",
    validateInput: (v) =>
      v.trim().length === 0
        ? vscode.l10n.t("Name cannot be empty")
        : undefined,
  });
  if (!name) {
    return;
  }

  const fqbn = boards.fqbn || sketch.default_fqbn;
  if (!fqbn) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No board selected. Select a board first."),
    );
    return;
  }

  const setDefault = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Yes"), value: true },
      { label: vscode.l10n.t("No"), value: false },
    ],
    { title: vscode.l10n.t("Set as default profile?") },
  );
  if (!setDefault) {
    return;
  }

  await client.profileCreate(
    sketch.location_path,
    name.trim(),
    fqbn,
    setDefault.value,
  );
  vscode.window.showInformationMessage(
    vscode.l10n.t('Profile “{0}” created.', name.trim()),
  );
}

/** Set the default build profile for the current sketch. */
export async function setDefaultProfile(
  client: ArduinoClient,
): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("Set Default Profile"),
    prompt: vscode.l10n.t("Profile name"),
  });
  if (!name) {
    return;
  }

  await client.profileSetDefault(sketch.location_path, name.trim());
  vscode.window.showInformationMessage(
    vscode.l10n.t('Default profile set to "{0}".', name.trim()),
  );
}

/** Add a library (name@version) to a sketch build profile. */
export async function addLibraryToProfile(
  client: ArduinoClient,
): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const profileName = await vscode.window.showInputBox({
    title: vscode.l10n.t("Add Library to Profile"),
    prompt: vscode.l10n.t("Profile name"),
  });
  if (!profileName) {
    return;
  }

  const libInput = await vscode.window.showInputBox({
    title: vscode.l10n.t("Add Library to Profile"),
    prompt: vscode.l10n.t("Library name and version (e.g. Servo@1.2.0)"),
    placeHolder: "Servo@1.2.0",
  });
  if (!libInput) {
    return;
  }

  const [libName, libVersion] = libInput.split("@");
  if (!libName?.trim()) {
    return;
  }

  const res = await client.profileLibAdd(
    sketch.location_path,
    profileName.trim(),
    {
      index_library: {
        name: libName.trim(),
        version: libVersion?.trim() ?? "",
        is_dependency: false,
      },
    },
  );

  const added = (res.added_libraries ?? [])
    .map((l) => l.index_library?.name)
    .filter(Boolean);
  const skipped = (res.skipped_libraries ?? [])
    .map((l) => l.index_library?.name)
    .filter(Boolean);

  if (added.length) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Added to profile: {0}", added.join(", ")),
    );
  }
  if (skipped.length) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Already in profile: {0}", skipped.join(", ")),
    );
  }
}

/** Remove a library from a sketch build profile. */
export async function removeLibraryFromProfile(
  client: ArduinoClient,
): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const profileName = await vscode.window.showInputBox({
    title: vscode.l10n.t("Remove Library from Profile"),
    prompt: vscode.l10n.t("Profile name"),
  });
  if (!profileName) {
    return;
  }

  const listRes = await client.profileLibList(
    sketch.location_path,
    profileName.trim(),
  );
  const libs = listRes.libraries ?? [];
  if (libs.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('No libraries in profile "{0}".', profileName.trim()),
    );
    return;
  }

  type Item = vscode.QuickPickItem & { lib: typeof libs[number] };
  const items: Item[] = libs.map((l) => {
    const idx = l.index_library;
    const loc = l.local_library;
    return {
      label: idx?.name ?? loc?.path ?? "?",
      description: idx?.version ?? "",
      lib: l,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Remove Library from Profile"),
    placeHolder: vscode.l10n.t("Pick a library to remove"),
  });
  if (!pick) {
    return;
  }

  const res = await client.profileLibRemove(
    sketch.location_path,
    profileName.trim(),
    pick.lib,
  );
  const removed = (res.removed_libraries ?? [])
    .map((l) => l.index_library?.name)
    .filter(Boolean);
  if (removed.length) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Removed from profile: {0}", removed.join(", ")),
    );
  }
}

/** List libraries pinned in a sketch build profile. */
export async function listProfileLibraries(
  client: ArduinoClient,
  output: vscode.OutputChannel,
): Promise<void> {
  const sketch = await resolveSketch(client);
  if (!sketch) {
    return;
  }

  const profileName = await vscode.window.showInputBox({
    title: vscode.l10n.t("List Profile Libraries"),
    prompt: vscode.l10n.t("Profile name"),
  });
  if (!profileName) {
    return;
  }

  const res = await client.profileLibList(
    sketch.location_path,
    profileName.trim(),
  );
  const libs = res.libraries ?? [];
  if (libs.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('No libraries in profile "{0}".', profileName.trim()),
    );
    return;
  }

  output.show(true);
  output.appendLine(
    `\n[profile] Libraries in "${res.profile_name}":`,
  );
  for (const l of libs) {
    if (l.index_library) {
      const dep = l.index_library.is_dependency ? " (dependency)" : "";
      output.appendLine(
        `  ${l.index_library.name}@${l.index_library.version}${dep}`,
      );
    } else if (l.local_library) {
      output.appendLine(`  [local] ${l.local_library.path}`);
    }
  }
}
