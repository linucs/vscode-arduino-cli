import * as assert from "assert";
import {
  tokenize,
  tokenizeResponseFile,
  expandResponseFiles,
  parseCompileCommand,
  pickSketchEntry,
  parseIncludeSet,
  buildCppProperties,
  mergeConfiguration,
} from "../intellisense";

suite("intellisense — parseCompileCommand", () => {
  test("extracts includes, defines, compiler, std and arch args", () => {
    const cmd =
      '/tools/arm-none-eabi-g++ -mcpu=cortex-m0plus -mthumb -DARDUINO=10607 -D ARDUINO_ARCH_SAMD ' +
      '-I/cores/arduino -isystem /libs/Servo/src -std=gnu++17 -c sketch.cpp';
    const p = parseCompileCommand({ directory: "/b", command: cmd, file: "sketch.cpp" });
    assert.deepStrictEqual(p.includes, ["/cores/arduino", "/libs/Servo/src"]);
    assert.deepStrictEqual(p.defines, ["ARDUINO=10607", "ARDUINO_ARCH_SAMD"]);
    assert.strictEqual(p.compilerPath, "/tools/arm-none-eabi-g++");
    assert.strictEqual(p.std, "gnu++17");
    assert.deepStrictEqual(p.compilerArgs, ["-mcpu=cortex-m0plus", "-mthumb"]);
  });

  test("prefers the arguments array when present", () => {
    const p = parseCompileCommand({
      directory: "/b",
      arguments: ["g++", "-I/a", "-I", "/b", "-DX=1"],
      file: "x.cpp",
    });
    assert.deepStrictEqual(p.includes, ["/a", "/b"]);
    assert.deepStrictEqual(p.defines, ["X=1"]);
  });

  test("de-dupes include dirs preserving order", () => {
    const p = parseCompileCommand({
      directory: "/b",
      arguments: ["g++", "-I/a", "-I/b", "-I/a"],
      file: "x.cpp",
    });
    assert.deepStrictEqual(p.includes, ["/a", "/b"]);
  });

  test("expands @response-files and resolves -iprefix/-iwithprefixbefore (esp32)", () => {
    // Mirrors how the esp32 core passes its SDK: a -iprefix base, an
    // @flags/includes file of -iwithprefixbefore dirs, and an @flags/defines
    // file carrying ESP_PLATFORM (with escaped-quote string values).
    const files: Record<string, string> = {
      "/sdk/flags/includes":
        "-iwithprefixbefore freertos/FreeRTOS-Kernel/include -iwithprefixbefore soc/esp32c6/include",
      "/sdk/flags/defines": '-DESP_PLATFORM -DIDF_VER=\\"v5.5.4\\"',
    };
    const p = parseCompileCommand(
      {
        directory: "/",
        arguments: [
          "riscv32-esp-elf-g++",
          "-DARDUINO=10607",
          "@/sdk/flags/defines",
          "-iprefix",
          "/sdk/include/",
          "@/sdk/flags/includes",
          "-I/sdk/qio_qspi/include",
          "-std=gnu++2b",
          "/build/sketch.ino.cpp",
        ],
        file: "/build/sketch.ino.cpp",
      },
      (f) => files[f],
    );
    assert.deepStrictEqual(p.includes, [
      "/sdk/include/freertos/FreeRTOS-Kernel/include",
      "/sdk/include/soc/esp32c6/include",
      "/sdk/qio_qspi/include",
    ]);
    assert.deepStrictEqual(p.defines, [
      "ARDUINO=10607",
      "ESP_PLATFORM",
      'IDF_VER="v5.5.4"',
    ]);
    assert.strictEqual(p.std, "gnu++2b");
  });

  test("leaves an unreadable @response-file as a literal (no throw)", () => {
    const p = parseCompileCommand(
      {
        directory: "/",
        arguments: ["g++", "-I/a", "@/missing/flags", "-DX=1"],
        file: "x.cpp",
      },
      () => {
        throw new Error("ENOENT");
      },
    );
    assert.deepStrictEqual(p.includes, ["/a"]);
    assert.deepStrictEqual(p.defines, ["X=1"]);
  });
});

suite("intellisense — response files", () => {
  test("tokenizeResponseFile unescapes backslash-quoted values", () => {
    // Source `\\"` is a single backslash-escaped quote in the file's bytes.
    assert.deepStrictEqual(
      tokenizeResponseFile('-DESP_PLATFORM -DIDF_VER=\\"v5.5.4\\"'),
      ["-DESP_PLATFORM", '-DIDF_VER="v5.5.4"'],
    );
  });

  test("expandResponseFiles inlines file contents in place, recursively", () => {
    const files: Record<string, string> = {
      "/r/a": "-DA @/r/b",
      "/r/b": "-DB -I/inc",
    };
    assert.deepStrictEqual(
      expandResponseFiles(["g++", "@/r/a", "-DC"], "/", (f) => files[f]),
      ["g++", "-DA", "-DB", "-I/inc", "-DC"],
    );
  });
});

suite("intellisense — tokenize", () => {
  test("honors double-quoted paths with spaces", () => {
    assert.deepStrictEqual(tokenize('g++ -I"/Program Files/x" -c a.cpp'), [
      "g++",
      "-I/Program Files/x",
      "-c",
      "a.cpp",
    ]);
  });
});

suite("intellisense — pickSketchEntry", () => {
  test("prefers the generated .ino.cpp", () => {
    const entries = [
      { directory: "/b", file: "/b/core/wiring.c", command: "" },
      { directory: "/b", file: "/b/sketch/Blink.ino.cpp", command: "" },
    ];
    assert.strictEqual(pickSketchEntry(entries)?.file, "/b/sketch/Blink.ino.cpp");
  });

  test("falls back to a cpp, then the first entry", () => {
    const entries = [
      { directory: "/b", file: "/b/core/a.S", command: "" },
      { directory: "/b", file: "/b/core/b.cpp", command: "" },
    ];
    assert.strictEqual(pickSketchEntry(entries)?.file, "/b/core/b.cpp");
  });
});

suite("intellisense — parseIncludeSet", () => {
  test("collects angle and quote includes", () => {
    const set = parseIncludeSet(
      '#include <Arduino.h>\n#include "local.h"\n  # include <Servo.h>\nint x;',
    );
    assert.deepStrictEqual([...set].sort(), ["Arduino.h", "Servo.h", "local.h"]);
  });
});

suite("intellisense — buildCppProperties", () => {
  test("uses the parsed C++ std, forced header and arch args; omits intelliSenseMode", () => {
    const cfg = buildCppProperties(
      {
        includes: ["/a"],
        defines: ["X"],
        compilerPath: "/g++",
        std: "gnu++17",
        compilerArgs: ["-mcpu=cortex-m0plus"],
      },
      "/cores/arduino/Arduino.h",
    );
    assert.strictEqual(cfg.name, "Arduino");
    assert.strictEqual(cfg.cppStandard, "gnu++17");
    assert.deepStrictEqual(cfg.forcedInclude, ["/cores/arduino/Arduino.h"]);
    assert.deepStrictEqual(cfg.includePath, ["/a", "${workspaceFolder}/**"]);
    assert.deepStrictEqual(cfg.compilerArgs, ["-mcpu=cortex-m0plus"]);
    // Inferred from compilerPath — must NOT be pinned to the host default.
    assert.ok(!("intelliSenseMode" in cfg));
  });

  test("omits forcedInclude and compilerArgs when none were discovered", () => {
    const cfg = buildCppProperties(
      { includes: [], defines: [], compilerPath: "/g++", std: "", compilerArgs: [] },
      undefined,
    );
    assert.ok(!("forcedInclude" in cfg));
    assert.ok(!("compilerArgs" in cfg));
    assert.strictEqual(cfg.cppStandard, "gnu++17");
  });
});

suite("intellisense — mergeConfiguration", () => {
  test("replaces an existing Arduino config and preserves others", () => {
    const existing = {
      version: 4,
      configurations: [
        { name: "Arduino", includePath: ["old"] },
        { name: "Mac", includePath: ["keep"] },
      ],
    };
    const merged = mergeConfiguration(existing, { name: "Arduino", includePath: ["new"] });
    const names = merged.configurations.map((c) => c.name);
    assert.deepStrictEqual(names, ["Arduino", "Mac"]);
    assert.deepStrictEqual(
      (merged.configurations[0] as { includePath: string[] }).includePath,
      ["new"],
    );
  });

  test("creates a version-4 doc when none exists", () => {
    const merged = mergeConfiguration({}, { name: "Arduino" });
    assert.strictEqual(merged.version, 4);
    assert.strictEqual(merged.configurations.length, 1);
  });
});
