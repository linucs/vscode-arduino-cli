# Arduino CLI IDE v0.0.1 — first public release 🎉

Code Arduino sketches in **plain VS Code** — compile, upload, monitor, and debug right from the editor.

This is a **thin wrapper** around the official [`arduino-cli`](https://github.com/arduino/arduino-cli): it runs the `arduino-cli` daemon in the background and gives you buttons, menus, and tree views for what it already does. You keep your normal VS Code — editor, extensions, themes, keybindings — with no separate IDE on top.

> **Requires `arduino-cli`** on your `PATH` (or set `arduinoCli.path`). It isn't bundled — that's what keeps the extension small. See the [installation guide](https://arduino.github.io/arduino-cli/latest/installation/).

## Highlights

- 🧰 **Editor toolbar buttons** — Compile, Upload, Serial Monitor, and Debug on any `.ino` file.
- 🔌 **Board selection & discovery** — pick a board once; missing cores can be auto-installed.
- 📦 **Visual core & library management** — install, update, downgrade, and remove platforms and libraries from a sidebar; install libraries from ZIP or a Git URL.
- 📈 **Serial monitor _and_ plotter** — read text from your board, or graph live numbers as they stream in.
- 🐞 **Real debugging (DAP)** — breakpoints and stepping on supported boards, with automatic adapter detection.
- 🧠 **C/C++ IntelliSense** — auto-generates and keeps `c_cpp_properties.json` in sync with the active board.
- 📁 **Build profiles** (`sketch.yaml`) — reproducible builds with profile-scoped libraries.
- 🛠️ **Sketch tooling & maintenance** — new/archive sketch, upload via programmer, burn bootloader, CLI update checks, cache cleanup.
- 🌍 **Localized** into 14 languages.

## Works great with Blocks Editor

Prefer building programs by **dragging blocks**? Install the sister extension [**Blocks Editor**](https://marketplace.visualstudio.com/items?itemName=linucs.blocks-editor) — it generates real Arduino code and uses this extension's Compile/Upload buttons to build and flash. Each works standalone; together they're a full visual + text workflow.

## Getting started

1. Install `arduino-cli` (see above) and this extension.
2. Open a sketch folder, or run **Arduino CLI: New Sketch…**.
3. Open the `.ino`, click **Select Board**, plug in your board, and hit **Upload**.

Full walkthrough and command reference in the [README](https://github.com/linucs/vscode-arduino-cli#readme).

---

**Install:** [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=linucs.vscode-arduino-cli-ide) · [Open VSX](https://open-vsx.org/extension/linucs/vscode-arduino-cli-ide) · or download the `.vsix` below.

Found a bug or have an idea? [Open an issue](https://github.com/linucs/vscode-arduino-cli/issues). See the [full changelog](https://github.com/linucs/vscode-arduino-cli/blob/main/CHANGELOG.md).
