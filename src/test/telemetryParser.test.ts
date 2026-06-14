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
    assert.deepStrictEqual(r, [
      { type: "value", point: { name: "temp", value: 23.5, unit: undefined } },
    ]);
  });

  test("parses name:timestamp:value", () => {
    const r = parseTelemetryLine(">temp:1627551892437:23.5");
    assert.deepStrictEqual(r, [
      {
        type: "value",
        point: {
          name: "temp",
          value: 23.5,
          timestamp: 1627551892437,
          unit: undefined,
        },
      },
    ]);
  });

  test("parses a §unit suffix", () => {
    const r = parseTelemetryLine(">temp:23.5§°C");
    assert.deepStrictEqual(r, [
      { type: "value", point: { name: "temp", value: 23.5, unit: "°C" } },
    ]);
  });

  test("parses several ;-separated points on one line", () => {
    const r = parseTelemetryLine(">temp:1:23.4;2:23.6;3:23.9");
    assert.deepStrictEqual(r, [
      {
        type: "value",
        point: { name: "temp", value: 23.4, timestamp: 1, unit: undefined },
      },
      {
        type: "value",
        point: { name: "temp", value: 23.6, timestamp: 2, unit: undefined },
      },
      {
        type: "value",
        point: { name: "temp", value: 23.9, timestamp: 3, unit: undefined },
      },
    ]);
  });

  test("parses XY scatter points (single name) with |xy flag", () => {
    const r = parseTelemetryLine(">pos:12:8|xy");
    assert.deepStrictEqual(r, [
      { type: "xy", point: { name: "pos", x: 12, y: 8, unit: undefined } },
    ]);
  });

  test("parses an XY point with a trailing timestamp", () => {
    const r = parseTelemetryLine(">pos:12:8:1627551892437|xy");
    assert.deepStrictEqual(r, [
      {
        type: "xy",
        point: {
          name: "pos",
          x: 12,
          y: 8,
          timestamp: 1627551892437,
          unit: undefined,
        },
      },
    ]);
  });

  test("parses several ;-separated XY points", () => {
    const r = parseTelemetryLine(">traj:1:1;2:4;3:9|xy");
    assert.deepStrictEqual(r, [
      { type: "xy", point: { name: "traj", x: 1, y: 1, unit: undefined } },
      { type: "xy", point: { name: "traj", x: 2, y: 4, unit: undefined } },
      { type: "xy", point: { name: "traj", x: 3, y: 9, unit: undefined } },
    ]);
  });

  test("parses negative and decimal XY values", () => {
    const r = parseTelemetryLine(">geo:-33.8:151.2|xy");
    assert.deepStrictEqual(r, [
      {
        type: "xy",
        point: { name: "geo", x: -33.8, y: 151.2, unit: undefined },
      },
    ]);
  });

  test("parses a text value with the |t flag", () => {
    const r = parseTelemetryLine(">state:Running|t");
    assert.deepStrictEqual(r, [
      { type: "text", point: { name: "state", text: "Running" } },
    ]);
  });

  test("parses a timestamped text value", () => {
    const r = parseTelemetryLine(">state:1627551892437:Off|t");
    assert.deepStrictEqual(r, [
      {
        type: "text",
        point: { name: "state", text: "Off", timestamp: 1627551892437 },
      },
    ]);
  });

  test("returns an empty array for plain log lines", () => {
    assert.deepStrictEqual(parseTelemetryLine("Hello, World!"), []);
    assert.deepStrictEqual(parseTelemetryLine(""), []);
  });

  test("returns an empty array for malformed telemetry", () => {
    assert.deepStrictEqual(parseTelemetryLine(">novalue"), []);
    assert.deepStrictEqual(parseTelemetryLine(">name:notanumber"), []);
  });

  test("handles leading whitespace", () => {
    const r = parseTelemetryLine("  >temp:1");
    assert.deepStrictEqual(r, [
      { type: "value", point: { name: "temp", value: 1, unit: undefined } },
    ]);
  });

  test("handles integer values", () => {
    const r = parseTelemetryLine(">count:42");
    assert.deepStrictEqual(r, [
      { type: "value", point: { name: "count", value: 42, unit: undefined } },
    ]);
  });
});
