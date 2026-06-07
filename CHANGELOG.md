# Change Log

All notable changes to the "Arduino CLI IDE" extension will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

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

[0.1.1]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.1.1
[0.0.1]: https://github.com/linucs/vscode-arduino-cli/releases/tag/v0.0.1
