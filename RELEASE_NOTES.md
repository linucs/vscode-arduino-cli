# Arduino Sketch Studio — Release Notes

Code Arduino sketches in **plain VS Code** — compile, upload, monitor, and debug right from the editor. A thin wrapper around the official [`arduino-cli`](https://github.com/arduino/arduino-cli): it runs the `arduino-cli` daemon in the background and gives you buttons, menus, and tree views for what it already does, with no separate IDE on top.

> **Requires `arduino-cli`** on your `PATH` (or set `arduinoCli.path`). It isn't bundled — that's what keeps the extension small. See the [installation guide](https://arduino.github.io/arduino-cli/latest/installation/). Prefer building programs by dragging blocks? Install the sister extension [**Blocks Editor**](https://marketplace.visualstudio.com/items?itemName=linucs.blocks-editor) — it generates real Arduino code and uses this extension's Compile/Upload buttons to build and flash.

---

## Unreleased

---

## v0.5.0 — 2026-06-23

- **Renamed to "Arduino Sketch Studio"** — the extension is now called **Arduino Sketch Studio** (formerly "Arduino CLI IDE") on the Marketplace, and its commands and settings group under that name. Branding only — command IDs, settings keys, and the `arduino-cli` integration are unchanged.
- **Status bar actions** — Compile, Upload, and Serial Monitor now have one-click buttons in the status bar, right next to the editor toolbar buttons.
- **Pick your `arduino-cli`** — a new **Select Executable Path** command (and a *Browse…* link in the `arduinoCli.path` setting) lets you point at a specific `arduino-cli` binary, and a missing executable now shows an actionable error with a way to fix it instead of a cryptic failure.
- **Fixed** — opening a sketch across several tabs no longer confuses which sketch an action targets; resolution now keys off the enclosing sketch folder.

---

## v0.4.1 — 2026-06-14

- **Richer Serial Plotter** — the plotter now speaks more of the [Teleplot](https://github.com/nesnes/teleplot) protocol. Add a **unit** to a series with `§` (e.g. `>temp:23.5§°C`), send **several samples on one line** separated by `;` (e.g. `>temp:1:23.4;2:23.6`), show a **text status** as a labelled card with the `|t` flag (e.g. `>state:Running|t`), and give **XY scatter** points an explicit timestamp (`>pos:12:8:1627551892437|xy`). The README's Serial Plotting section documents the full format with Arduino examples.
- **Changed** — XY scatter points now use a single series name (`>name:x:y|xy`) instead of the old two-name shape, matching Teleplot.

---

## v0.4.0 — 2026-06-14

- **Manage profile libraries** — the renamed **Project libraries** view now lets you manage the libraries pinned to a `sketch.yaml` build profile. Use **Add Library to Profile** to add one and the inline action to remove one — the profile's `libraries:` list stays in sync, no hand-editing the YAML.
- **Confirm before removing** — uninstalling a library or core, or removing a library from a profile, now asks for a confirmation first, the same way from the tree, the command palette, or the picker.
- **Eager daemon start** — opening a project that contains a `sketch.yaml` now starts the `arduino-cli` daemon right away, so profile mode resolves immediately. On by default; turn off `arduinoCli.eagerDaemonStart` to keep the daemon starting lazily on first use.
- **Fixed** — messages coming from the daemon now show up correctly localized (the client waits for the daemon to be ready before talking to it).

---

## v0.3.0 — 2026-06-09

- **Serial line ending** — the serial monitor status bar shows the active line ending (None / NL / CR / NL+CR) with a one-click picker. The chosen ending is appended to every message you send to the board.
- **Open library examples** — new **Open Library Example** command opens any example sketch from an installed library in the editor (read-only, so you can't accidentally edit the library source). **Open Library Website** opens the library's home page.
- **Library grouping** — toggle **Group by Category** in the Installed Libraries toolbar to organise libraries by their category.
- **Unified AI assistant** — **Install Arduino Skill** now drops a single skill that works with both GitHub Copilot Chat and Claude Code, instead of separate setups.
- **Removed** — the eight Copilot Language Model tools from v0.2.0 have been removed; the skill-based approach covers the same use cases and works across AI assistants.

---

## v0.2.0 — 2026-06-08

- **Works with GitHub Copilot** — Copilot Chat can now drive `arduino-cli` for you through eight new Language Model tools: check build status, compile, upload, search boards, get board details, search libraries, install a library, and install a core. Ask Copilot to compile your sketch or fix a build error and it can do it through the daemon.
- **Install Arduino Skill** — a new command drops a bundled Claude Code skill into `.claude/skills/arduino-cli/` in your workspace, teaching a Claude Code session how to build, upload, and troubleshoot sketches with `arduino-cli`. Re-run it after an upgrade to refresh.

---

## v0.1.1 — 2026-06-07

- **Saved-file follow-up actions** — saving a serial log, exporting plotter data, or archiving a sketch now offers an **Open** or **Reveal in File Explorer** action straight from the confirmation toast.
- **Smarter Save dialogs** — Save Serial Log, Export Plotter Data, and Archive Sketch now default to your sketch's workspace folder instead of the filesystem root.
- **New Sketch** adds the freshly created sketch folder as a root of the current window, so it becomes your working folder right away.
- **Fixed** — debugging in a multi-root workspace now resolves `${workspaceFolder}` against the root that actually contains the sketch.

---

## v0.0.1 — 2026-06-07 — first public release

- **Editor toolbar buttons** — Compile, Upload, Serial Monitor, and Debug appear in the editor title bar for any `.ino` file (over text *and* custom editors).
- **Compile & upload** — compile the active sketch, upload to a connected board, upload using a programmer, and burn the bootloader, with live build/upload progress streamed to an output channel.
- **Board selection & discovery** — pick a board (FQBN) from connected ports or the full board list, inspect Board Details, with automatic core installation offered when a board's core is missing.
- **Serial monitor** — configurable baud rate, optional auto-reconnect after upload, and a Save Serial Log command.
- **Serial plotter** — a real-time graphing webview that plots numeric CSV telemetry coming off the serial port.
- **Platform/core management** — an Installed Platforms tree view plus commands to search, install, uninstall, upgrade, downgrade, and download cores; refresh the package index and update from additional Board Manager URLs.
- **Library management** — an Installed Libraries tree view plus commands to search, add, uninstall, upgrade, downgrade, and download libraries; install from a ZIP or a Git URL; update the libraries index.
- **Build profiles (`sketch.yaml`)** — create profiles, set a default, and add/remove/list profile-scoped libraries, with a dedicated Profile Libraries view in profile mode.
- **Debugging (DAP)** — debug a sketch on a connected board through a contributed `arduino` debug type, with automatic adapter detection (`cortex-debug`, `cppdbg`, or a custom template).
- **C/C++ IntelliSense** — auto-generates and keeps `c_cpp_properties.json` in sync with the active board's includes and defines, so go-to-definition and completions work out of the box.
- **Daemon lifecycle** — lazily spawns and manages the `arduino-cli daemon` child process, one per window, with Show Daemon Version and Restart Daemon commands.
- **Sketch tooling & maintenance** — New Sketch and Archive Sketch commands, plus `arduino-cli` update checks and download-cache cleanup.
- **Localization** — the UI is translated into 14 languages.

---

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=linucs.vscode-arduino-cli-ide) · [Open VSX](https://open-vsx.org/extension/linucs/vscode-arduino-cli-ide) · or download the `.vsix` from the release.

Found a bug or have an idea? [Open an issue](https://github.com/linucs/vscode-arduino-cli/issues). For the structured, technical history see the [full changelog](https://github.com/linucs/vscode-arduino-cli/blob/main/CHANGELOG.md).
