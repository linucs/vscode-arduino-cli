/**
 * Pure helpers for parsing the serial telemetry protocol used by the plotter.
 *
 * Lines prefixed with `>` are telemetry; the prefix is stripped and the rest
 * is parsed into structured points. Plain log lines are ignored.
 *
 * Formats:
 *   >name:value              → time-series point (timestamp = now)
 *   >name:timestamp:value    → time-series point with explicit ms timestamp
 *   >nameX:nameY:x:y|xy     → XY scatter point
 */

/** A single time-series data point. */
export interface TelemetryPoint {
  name: string;
  value: number;
  timestamp?: number;
}

/** An XY scatter data point. */
export interface XYPoint {
  nameX: string;
  nameY: string;
  x: number;
  y: number;
}

export type ParsedTelemetry =
  | { type: "value"; point: TelemetryPoint }
  | { type: "xy"; point: XYPoint };

/** Split a chunk into complete lines, carrying over an incomplete tail. */
export function splitLines(
  buffer: string,
  chunk: string,
): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  return { lines, rest };
}

/**
 * Parse a single serial line into a structured telemetry point.
 * Returns `undefined` for plain log lines (no `>` prefix).
 */
export function parseTelemetryLine(line: string): ParsedTelemetry | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(">")) {
    return undefined;
  }

  let body = trimmed.slice(1);
  let flags = "";
  const pipeIdx = body.indexOf("|");
  if (pipeIdx !== -1) {
    flags = body.slice(pipeIdx + 1);
    body = body.slice(0, pipeIdx);
  }

  const parts = body.split(":");

  if (flags.includes("xy") && parts.length >= 4) {
    const x = Number(parts[parts.length - 2]);
    const y = Number(parts[parts.length - 1]);
    if (!isNaN(x) && !isNaN(y)) {
      return {
        type: "xy",
        point: {
          nameX: parts[0],
          nameY: parts[1],
          x,
          y,
        },
      };
    }
  }

  if (parts.length === 2) {
    const value = Number(parts[1]);
    if (!isNaN(value)) {
      return { type: "value", point: { name: parts[0], value } };
    }
  }

  if (parts.length === 3) {
    const ts = Number(parts[1]);
    const value = Number(parts[2]);
    if (!isNaN(ts) && !isNaN(value)) {
      return {
        type: "value",
        point: { name: parts[0], value, timestamp: ts },
      };
    }
  }

  return undefined;
}
