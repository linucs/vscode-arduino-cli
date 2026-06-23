# Change Log

All notable changes to the "Arduino Sketch Studio" extension will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [Unreleased]

## [0.5.0] - 2026-06-23

### Added

- **Status bar actions** — Compile, Upload, and Serial Monitor now have quick
  buttons in the status bar, available alongside the existing `editor/title`
  toolbar buttons.
- **Select the `arduino-cli` executable** — a new **Select Executable Path**
  command (and a *Browse…* link in the `arduinoCli.path` setting) lets you point
  the extension at a specific `arduino-cli` binary. When the executable can't be
  found, the daemon now surfaces an actionable error with a recovery option
  instead of a bare ENOENT.

### Changed

- **Renamed to "Arduino Sketch Studio"** — the extension's Marketplace display
  name, command category, and settings section are now **Arduino Sketch Studio**
  (formerly "Arduino CLI IDE"). This is a branding change only; command IDs,
  settings keys, and the underlying `arduino-cli` integration are unchanged.

### Fixed

- **Multi-tab sketches** — sketch resolution now uses the enclosing sketch
  folder instead of counting open files, so actions target the right sketch when
  several tabs of it are open.

## [0.4.1] - 2026-06-14

### Added

- **Richer Serial Plotter (Teleplot subset)** — the plotter now understands more
  of the [Teleplot](https://github.com/nesnes/teleplot) serial protocol:
  - **Units** — a `§unit` suffix (e.g. `>temp:23.5§°C`) labels the series with its
    unit in the legend.
  - **Multiple points per line** — `;` separates several samples for one series in
    a single line (e.g. `>temp:1:23.4;2:23.6;3:23.9`), handy for batching or
    replaying buffered data.
  - **Text/log values** — the `|t` flag (e.g. `>state:Running|t`) shows a value as
    a labelled card instead of plotting it.
  - **XY scatter timestamps** — XY points accept an explicit millisecond timestamp
    (`>pos:12:8:1627551892437|xy`).

  The Serial Plotting section of the README documents the full supported grammar
  with Arduino examples.

### Changed

- **XY scatter format** — scatter points now use a single series name
  (`>name:x:y|xy`) instead of the previous two-name `>nameX:nameY:x:y|xy` shape,
  matching Teleplot.

## [0.4.0] - 2026-06-14

### Added

- **Profile library management** — the **Project libraries** view (renamed from
  *Profile Libraries*) now lets you manage the libraries pinned to a `sketch.yaml`
  build profile. A new **Arduino CLI: Add Library to Profile** command adds a
  library to the active profile, and an inline action removes one — keeping the
  profile's `libraries:` list in sync without hand-editing the YAML.
- **Confirmation prompts for destructive actions** — uninstalling a library or
  core, and removing a library from a profile, now ask for a modal confirmation
  first. Every entry point (tree inline action, command palette, interactive
  picker) confirms the same way.
- **Eager daemon start** — a new `eagerDaemonStart` setting starts the
  `arduino-cli` daemon as soon as a project containing a `sketch.yaml` is opened,
  so profile mode resolves immediately. Enabled by default; turn it off to keep
  the daemon starting lazily on the first command that needs it.

### Fixed

- **Localized daemon messages** — the client now waits for the gRPC channel to be
  ready before issuing calls, and daemon readiness is detected from its address,
  so localized strings coming from the daemon resolve correctly.

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
