# Copilot instructions

This extension ships GitHub Copilot Language Model tools (prefixed
`arduino-cli-*`) that drive the Arduino toolchain through the running
`arduino-cli` daemon: `arduino-cli-build-status`, `-compile`, `-board-search`,
`-board-details`, `-library-search`, `-library-install`, `-platform-install`,
`-upload`.

When helping with Arduino tasks in agent mode, prefer these tools over guessing
`arduino-cli` invocations:

- Diagnosing a build/upload/IntelliSense issue → start with `arduino-cli-build-status`.
- Reproducing a compile error → `arduino-cli-compile` (returns structured
  diagnostics); fix, then compile again to verify.
- Missing-header errors → `arduino-cli-library-search` then
  `arduino-cli-library-install`.
- A board needing a core → `arduino-cli-platform-install`.

A red `#include` that still compiles is an IntelliSense config issue → suggest the
"Arduino CLI: Configure IntelliSense" command, not a library install.
