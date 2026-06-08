# Arduino CLI IDE — Release Notes

Code Arduino sketches in **plain VS Code** — compile, upload, monitor, and debug right from the editor. A thin wrapper around the official [`arduino-cli`](https://github.com/arduino/arduino-cli): it runs the `arduino-cli` daemon in the background and gives you buttons, menus, and tree views for what it already does, with no separate IDE on top.

> **Requires `arduino-cli`** on your `PATH` (or set `arduinoCli.path`). It isn't bundled — that's what keeps the extension small. See the [installation guide](https://arduino.github.io/arduino-cli/latest/installation/). Prefer building programs by dragging blocks? Install the sister extension [**Blocks Editor**](https://marketplace.visualstudio.com/items?itemName=linucs.blocks-editor) — it generates real Arduino code and uses this extension's Compile/Upload buttons to build and flash.

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
