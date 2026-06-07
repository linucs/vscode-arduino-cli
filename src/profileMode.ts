import * as vscode from "vscode";
import type { ArduinoClient, ArduinoInstance } from "./arduinoClient";
import type { BoardManager } from "./boardManager";
import type { PlatformManager } from "./platformManager";
import type { Sketch } from "./proto/types";

/**
 * The resolved execution context for a toolchain command on a sketch.
 *
 * Two modes, decided by whether sketch.yaml declares a `default_profile`:
 *
 *  - **Profile mode** (`profileMode: true`): the daemon resolves board, platform
 *    and libraries from the profile, isolated from globally-installed resources.
 *    Calls run through the profile-bound `instance`. `fqbn` carries the profile's
 *    board (mandatory in sketch.yaml) for upload/monitor/debug tool selection —
 *    but Compile MUST omit it (the bound instance supplies it; passing both is a
 *    conflict).
 *
 *  - **Global mode** (`profileMode: false`): today's behavior — no bound instance
 *    (the global one is used), explicit `fqbn`, libraries resolved by `#include`
 *    discovery against globally-installed libraries.
 */
export interface Execution {
  /** Profile-bound instance to hand to client calls; undefined => global instance. */
  instance?: ArduinoInstance;
  /** Active profile name when in profile mode. */
  profileName?: string;
  /**
   * Profile mode only: whether the profile-bound instance is ready. False when
   * resolved with `create: false` and the instance has not been built yet (the
   * profile's platform is not installed). Always true in global mode.
   */
  profileReady?: boolean;
  /**
   * Board FQBN. Profile mode -> the profile's fqbn (board selector has no say).
   * Global mode -> status-bar selection or `default_fqbn`. Undefined only when
   * global mode has no board selected at all.
   */
  fqbn?: string;
  profileMode: boolean;
}

/**
 * Decide how to execute a command against `sketch`. In profile mode this lazily
 * creates (and caches) the profile-bound instance via the client.
 */
export async function resolveExecution(
  client: ArduinoClient,
  boards: BoardManager,
  sketch: Sketch,
  opts: {
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
    /**
     * When false, never create the profile instance — return the cached one if
     * present, otherwise `profileReady: false` with no instance. Background /
     * auto-triggered callers pass this so they never start the profile's library
     * resolution; only explicit Compile/Upload create it. Default true.
     */
    create?: boolean;
  } = {},
): Promise<Execution> {
  const profileName = sketch.default_profile?.name;
  if (profileName) {
    const fqbn = sketch.default_profile?.fqbn || undefined;
    if (opts.create === false) {
      const instance = client.peekProfileInstance(
        sketch.location_path,
        profileName,
      );
      return {
        instance,
        profileName,
        fqbn,
        profileMode: true,
        profileReady: Boolean(instance),
      };
    }
    const instance = await client.getProfileInstance(
      sketch.location_path,
      profileName,
      opts,
    );
    return {
      instance,
      profileName,
      fqbn,
      profileMode: true,
      profileReady: true,
    };
  }
  return {
    fqbn: boards.fqbn || sketch.default_fqbn || undefined,
    profileMode: false,
  };
}

/**
 * Ensure the sketch's platform is installed and resolve its execution context.
 * The single entry point for Compile and Upload — handles both profile and
 * global mode.
 *
 * 1. Determine the fqbn (from the profile or the board selector / sketch defaults).
 * 2. Ensure the platform is installed (profile mode: the version pinned in the
 *    profile; global mode: latest).
 * 3. Resolve the execution context (profile mode: Create+Init the profile-bound
 *    instance under a cancellable progress notification; global mode: thin resolve).
 *
 * Returns the {@link Execution}, or undefined when the caller should abort (the
 * user declined/cancelled the install, or init failed — already messaged).
 */
export async function prepareExecution(
  client: ArduinoClient,
  boards: BoardManager,
  sketch: Sketch,
  platforms: PlatformManager,
  output: vscode.OutputChannel,
  tag: string,
): Promise<Execution | undefined> {
  const profileName = sketch.default_profile?.name;
  const fqbn = profileName
    ? sketch.default_profile?.fqbn
    : boards.fqbn || sketch.default_fqbn;

  if (!fqbn) {
    return undefined;
  }

  const profilePlatformVersion = sketch.default_profile?.platforms
    ?.find((p) => p.id === fqbn.split(":").slice(0, 2).join(":"))?.version;
  if (!(await platforms.ensurePlatformInstalled(fqbn, profilePlatformVersion))) {
    return undefined;
  }

  try {
    if (profileName && !client.peekProfileInstance(sketch.location_path, profileName)) {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Preparing profile {0}…", profileName),
          cancellable: true,
        },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return resolveExecution(client, boards, sketch, {
            onProgress: (message) => progress.report({ message }),
            signal: ac.signal,
          });
        },
      );
    }
    return await resolveExecution(client, boards, sketch);
  } catch (err) {
    output.show(true);
    output.appendLine(
      `[${tag}] profile init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not prepare the build profile — see the Arduino CLI output.",
      ),
    );
    return undefined;
  }
}
