---
name: arduino-cli
description: >
  Build, upload, and troubleshoot Arduino sketches with the `arduino-cli`
  command-line tool. Use for ANY Arduino or embedded-Arduino task, including: a
  `.ino` sketch or a sketch folder anywhere in the workspace; compiling,
  verifying, building, flashing, uploading, or burning a bootloader; opening the
  serial monitor/plotter or debugging a board; finding, installing, updating, or
  removing an Arduino library (`#include` of a non-standard header) or a board
  core/platform; picking, identifying, searching, or configuring a board, its
  FQBN, port, or programmer; reading or editing `sketch.yaml` build profiles;
  questions about an installed library's API or examples; and any Arduino
  compile/upload error, missing-header/missing-core error, `bad CPU type`
  toolchain failure, or red IntelliSense squiggle on Arduino code. Also use when
  the user mentions Arduino hardware (Uno, Nano, Mega, ESP32, ESP8266, RP2040,
  etc.) or asks how to do something "in Arduino" / "on the board". Covers FQBNs,
  cores, libraries, ports, `sketch.yaml` profiles, and the search → install →
  compile → upload → verify loop. Prefer this over generic shell or C/C++ help
  whenever `arduino-cli` is the right tool.
---

# Arduino CLI assistant

ALWAYS read reference.md before answering Arduino-CLI questions.
The assistant SHOULD open and read that file automatically (without asking for permission)
whenever handling Arduino-CLI related requests. The assistant may show a one-line preamble
before opening the file per tool-preamble rules but must not prompt the user for consent.
