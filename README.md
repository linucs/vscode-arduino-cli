# vscode-arduino-cli

A **lightweight** VS Code extension that wraps the
[`arduino-cli`](https://github.com/arduino/arduino-cli) gRPC daemon
(`ArduinoCoreService`). It spawns the daemon as a child process and talks to it
over local gRPC — no reimplementation of arduino-cli, just a thin editor layer.

## Requirements

- [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/) on
  your `PATH` (or set `arduinoCli.path`).
- Node.js 18+ to build.

## Getting started

```bash
npm install
./scripts/fetch-protos.sh   # vendor the proto definitions (already included)
npm run build               # bundle to dist/extension.js
```

Press **F5** in VS Code to launch an Extension Development Host, then run
**Arduino CLI: Show Daemon Version** from the command palette to confirm the
daemon is reachable.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `arduinoCli.path` | `arduino-cli` | Path to the executable |
| `arduinoCli.daemonPort` | `50051` | Local daemon TCP port |

## Status

Early scaffold — daemon lifecycle and instance `Create`/`Init`/`Destroy` work.
The full feature roadmap (compile, upload, monitor, library/core management,
debugging) is specified in [`.claude/docs/`](.claude/docs).

## License

MIT
