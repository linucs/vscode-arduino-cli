# Change Log

All notable changes to the "Arduino CLI IDE" extension will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [0.3.0] - 2026-06-09

### Added

- **Serial line ending** — the serial monitor status bar now shows the active line
  ending (None / NL / CR / NL+CR) and lets you change it with one click or via the
  new **Arduino CLI: Set Serial Line Ending** command. The chosen ending is appended
  to every message sent to the board.
- **Open library examples** — a new **Arduino CLI: Open Library Example** command
  opens any example sketch from an installed library directly in the editor (the
  example folder is opened read-only so you don't accidentally modify the library's
  source). A complementary **Open Library Website** command opens the library's home
  page in the browser.
- **Library grouping** — the Installed Libraries tree view can now group libraries
  by category. Toggle grouping on or off with the new **Group by Category** /
  **Ungroup** toolbar action.

### Changed

- **Unified AI assistant setup** — the **Install Arduino Skill** command now
  installs a single, unified skill that works with both GitHub Copilot Chat and
  Claude Code, replacing the two separate setup paths.

### Removed

- **GitHub Copilot Language Model tools** — the eight LM tools contributed to
  Copilot Chat in v0.2.0 have been removed. The AI assistant integration is now
  handled entirely through the installed skill (see above), which is more
  maintainable and works across AI assistants.

## [0.2.0] - 2026-06-08

### Added

- **GitHub Copilot integration** — the extension now contributes eight Language
  Model tools that Copilot (and other Chat participants) can call to drive
  `arduino-cli`: report the current build status, compile, upload, search boards,
  get board details, search libraries, install a library, and install a core.
  Ask Copilot Chat to compile or fix a build and it can act through the daemon.
- **Install Arduino skill** — a new command, **Arduino: Install Arduino Skill**,
  copies a bundled Claude Code skill into `.claude/skills/arduino-cli/` in the
  current workspace, so a Claude Code session learns how to drive `arduino-cli`
  for this project. Re-run it after upgrading the extension to refresh the files.

## [0.1.1] - 2026-06-07

### Added

- **"Saved" toasts with follow-up actions** — after saving a serial log, exporting
  plotter data, or archiving a sketch, the confirmation now offers an **Open** or
  **Reveal in File Explorer** action.

### Changed

- **Smarter Save dialog defaults** — Save Serial Log, Export Plotter Data, and
  Archive Sketch now default to the active sketch's workspace folder instead of the
  filesystem root.
- **New Sketch** now adds the created sketch's folder as a root of the current
  window, so it immediately becomes the working folder.

### Fixed

- **Debugging in multi-root workspaces** — `${workspaceFolder}` now resolves against
  the workspace root that actually contains the sketch, rather than always the first
  root.

## [0.0.1] - 2026-06-07

First public release.

A thin VS Code wrapper over the [`arduino-cli`](https://github.com/arduino/arduino-cli)
gRPC daemon (`ArduinoCoreService`). It spawns `arduino-cli daemon` as a child process and
talks to it over local gRPC — no reimplementation of arduino-cli, just an editor layer.

### Added

- **Daemon lifecycle** — the extension lazily spawns and manages the `arduino-cli daemon`
  child process, with one daemon and one instance per window (`Create` → `Init` → `Destroy`).
  Commands to **Show Daemon Version** and **Restart Daemon**.
- **Compile & upload** — compile the active sketch, upload to a connected board, upload
  using a programmer, and burn the bootloader, with live build/upload progress streamed to
  an output channel.
- **Editor toolbar buttons** — Compile, Upload, Serial Monitor, and Debug buttons appear in
  the editor title bar for any `.ino` file (over text *and* custom editors).
- **Board selection & discovery** — pick a board (FQBN) from connected ports or the full
  board list, inspect **Board Details**, with automatic platform/core installation offered
  when a board's core is missing.
- **Serial monitor** — open a serial monitor with configurable baud rate, optional
  auto-reconnect after upload, and a **Save Serial Log** command.
- **Serial plotter** — a real-time graphing webview that plots numeric CSV telemetry coming
  off the serial port.
- **Platform/core management** — an **Installed Platforms** tree view plus commands to
  search, install, uninstall, upgrade, downgrade (change version), and download cores;
  refresh the package index and update from additional Board Manager URLs.
- **Library management** — an **Installed Libraries** tree view plus commands to search,
  add, uninstall, upgrade, downgrade, and download libraries; install from a **ZIP** or a
  **Git URL**; and update the libraries index.
- **Build profiles (`sketch.yaml`)** — create build profiles, set a default profile, and
  add/remove/list profile-scoped libraries, with a dedicated **Profile Libraries** view in
  profile mode.
- **Debugging (DAP)** — debug a sketch on a connected board through a contributed `arduino`
  debug type, with automatic adapter detection (`cortex-debug`, `cppdbg`, or a custom
  template) and a **Show Debug Configuration** command.
- **C/C++ IntelliSense** — auto-generates and keeps `c_cpp_properties.json` in sync with the
  active board's includes and defines, so go-to-definition and completions work out of the box.
- **Sketch tooling** — **New Sketch** and **Archive Sketch** commands.
- **Maintenance** — check for `arduino-cli` updates and clean the download cache.
- **Localization** — the UI is translated into 14 languages.

[0.3.0]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.3.0
[0.2.0]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.2.0
[0.1.1]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.1.1
[0.0.1]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.0.1
