import * as vscode from "vscode";
import type { ArduinoClient } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { PlatformManager } from "./platformManager";
import type { ProfileLibraryReference } from "./proto/types";
import type { LibNode } from "./libraryView";
import type { ProfileContext, ProfileLibNode } from "./profileLibraryView";
import { resolveSketch } from "./sketch";

/**
 * ProfileLibAdd + consistent reporting (added and already-present). The single
 * add path shared by the command-palette flow and the inline tree action, so
 * both report the same way. Refresh of any view is left to the caller.
 */
export async function applyProfileLibAdd(
  client: ArduinoClient,
  sketchPath: string,
  profileName: string,
  library: ProfileLibraryReference,
): Promise<void> {
  const res = await client.profileLibAdd(sketchPath, profileName, library);
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

/**
 * ProfileLibRemove + consistent reporting (removed). The single remove path
 * shared by the command-palette flow and the inline tree action.
 */
export async function applyProfileLibRemove(
  client: ArduinoClient,
  sketchPath: string,
  profileName: string,
  library: ProfileLibraryReference,
): Promise<void> {
  const res = await client.profileLibRemove(sketchPath, profileName, library);
  const removed = (res.removed_libraries ?? [])
    .map((l) => l.index_library?.name)
    .filter(Boolean);
  if (removed.length) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Removed from profile: {0}", removed.join(", ")),
    );
  }
}

/** Pin a library (by name + installed version) to a profile via the add path. */
async function pinLibraryToProfile(
  client: ArduinoClient,
  profile: ProfileContext,
  lib: { name: string; version: string },
): Promise<void> {
  await applyProfileLibAdd(client, profile.sketchPath, profile.profileName, {
    index_library: { name: lib.name, version: lib.version, is_dependency: false },
  });
}

/** Add an installed-library tree node (pinned to its version) to the profile. */
export async function addInstalledLibraryToProfile(
  client: ArduinoClient,
  profile: ProfileContext | undefined,
  node: LibNode | undefined,
): Promise<void> {
  if (node?.kind !== "lib" || !profile) {
    return;
  }
  await pinLibraryToProfile(client, profile, {
    name: node.name,
    version: node.version,
  });
}

/** Remove a profile-library tree node from the profile (inline tree action). */
export async function removeProfileLibrary(
  client: ArduinoClient,
  profile: ProfileContext | undefined,
  node: ProfileLibNode | undefined,
): Promise<void> {
  if (node?.kind !== "profileLib" || !profile) {
    return;
  }
  await applyProfileLibRemove(
    client,
    profile.sketchPath,
    profile.profileName,
    node.ref,
  );
}

/** After installing a library, offer to pin it to the current profile (Yes by default). */
export async function offerAddToProfile(
  client: ArduinoClient,
  profile: ProfileContext | undefined,
  lib: { name: string; version: string },
): Promise<void> {
  if (!profile) {
    return;
  }
  const yes = vscode.l10n.t("Yes");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Add "{0}" to profile "{1}"?', lib.name, profile.profileName),
    { modal: true },
    yes,
    vscode.l10n.t("No"),
  );
  if (choice === yes) {
    await pinLibraryToProfile(client, profile, lib);
  }
}

/** Create a new build profile in the current sketch's sketch.yaml. */
export async function createProfile(
  client: ArduinoClient,
  boards: BoardManager,
  platforms: PlatformManager,
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

  // The core must be installed before ProfileCreate: with it missing,
  // arduino-cli writes `platforms: []`, which later panics its own YAML loader
  // and kills the daemon.
  if (!(await platforms.ensurePlatformInstalled(fqbn))) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Profile not created: the “{0}” core must be installed first.',
        fqbn.split(":").slice(0, 2).join(":"),
      ),
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

  await applyProfileLibAdd(client, sketch.location_path, profileName.trim(), {
    index_library: {
      name: libName.trim(),
      version: libVersion?.trim() ?? "",
      is_dependency: false,
    },
  });
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

  await applyProfileLibRemove(
    client,
    sketch.location_path,
    profileName.trim(),
    pick.lib,
  );
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
