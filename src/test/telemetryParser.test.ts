import * as assert from "assert";
import { splitLines, parseTelemetryLine } from "../telemetryParser";

suite("telemetry parser — splitLines", () => {
  test("splits a single complete line", () => {
    const { lines, rest } = splitLines("", ">temp:23.5\n");
    assert.deepStrictEqual(lines, [">temp:23.5"]);
    assert.strictEqual(rest, "");
  });

  test("carries over an incomplete tail", () => {
    const { lines, rest } = splitLines("", ">temp:23.5\n>hum:");
    assert.deepStrictEqual(lines, [">temp:23.5"]);
    assert.strictEqual(rest, ">hum:");
  });

  test("joins a previous buffer with the new chunk", () => {
    const { lines, rest } = splitLines(">hum:", "60\n");
    assert.deepStrictEqual(lines, [">hum:60"]);
    assert.strictEqual(rest, "");
  });

  test("strips trailing \\r from lines", () => {
    const { lines, rest } = splitLines("", ">temp:1\r\n>temp:2\r\n");
    assert.deepStrictEqual(lines, [">temp:1", ">temp:2"]);
    assert.strictEqual(rest, "");
  });

  test("handles multiple lines in one chunk", () => {
    const { lines, rest } = splitLines("", ">a:1\n>b:2\n>c:3\n");
    assert.deepStrictEqual(lines, [">a:1", ">b:2", ">c:3"]);
    assert.strictEqual(rest, "");
  });

  test("empty chunk produces no lines", () => {
    const { lines, rest } = splitLines("", "");
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(rest, "");
  });
});

suite("telemetry parser — parseTelemetryLine", () => {
  test("parses a simple name:value pair", () => {
    const r = parseTelemetryLine(">temp:23.5");
    assert.deepStrictEqual(r, {
      type: "value",
      point: { name: "temp", value: 23.5 },
    });
  });

  test("parses name:timestamp:value", () => {
    const r = parseTelemetryLine(">temp:1627551892437:23.5");
    assert.deepStrictEqual(r, {
      type: "value",
      point: { name: "temp", value: 23.5, timestamp: 1627551892437 },
    });
  });

  test("parses XY scatter points with |xy flag", () => {
    const r = parseTelemetryLine(">posX:posY:12:8|xy");
    assert.deepStrictEqual(r, {
      type: "xy",
      point: { nameX: "posX", nameY: "posY", x: 12, y: 8 },
    });
  });

  test("parses negative and decimal XY values", () => {
    const r = parseTelemetryLine(">lat:lon:-33.8:151.2|xy");
    assert.deepStrictEqual(r, {
      type: "xy",
      point: { nameX: "lat", nameY: "lon", x: -33.8, y: 151.2 },
    });
  });

  test("returns undefined for plain log lines", () => {
    assert.strictEqual(parseTelemetryLine("Hello, World!"), undefined);
    assert.strictEqual(parseTelemetryLine(""), undefined);
  });

  test("returns undefined for malformed telemetry", () => {
    assert.strictEqual(parseTelemetryLine(">novalue"), undefined);
    assert.strictEqual(parseTelemetryLine(">name:notanumber"), undefined);
  });

  test("handles leading whitespace", () => {
    const r = parseTelemetryLine("  >temp:1");
    assert.deepStrictEqual(r, {
      type: "value",
      point: { name: "temp", value: 1 },
    });
  });

  test("handles integer values", () => {
    const r = parseTelemetryLine(">count:42");
    assert.deepStrictEqual(r, {
      type: "value",
      point: { name: "count", value: 42 },
    });
  });
});
