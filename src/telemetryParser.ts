/**
 * Pure helpers for parsing the serial telemetry protocol used by the plotter.
 *
 * Lines prefixed with `>` are telemetry; the prefix is stripped and the rest
 * is parsed into structured points. Plain log lines are ignored.
 *
 * Implements a subset of the Teleplot protocol (https://github.com/nesnes/teleplot).
 * The per-line grammar is:
 *
 *   name[:timestamp]:value[§unit][|flags]
 *
 * with `;` separating several points for the same `name` on one line. Recognised
 * flags: `xy` (scatter point) and `t` (text/log value). Examples:
 *
 *   >temp:23.5                       → time-series point (timestamp = now)
 *   >temp:1627551892437:23.5         → time-series point with explicit ms timestamp
 *   >temp:23.5§°C                    → time-series point carrying a unit
 *   >temp:1:23.4;2:23.6;3:23.9       → three points in one line
 *   >pos:12:8|xy                     → XY scatter point (x:y)
 *   >pos:12:8:1627551892437|xy       → XY scatter point with explicit ms timestamp
 *   >state:Running|t                 → text/log value
 *
 * Not implemented (out of scope): 3D shapes (`3D|…`) and remote function calls.
 */

/** A single time-series data point. */
export interface TelemetryPoint {
  name: string;
  value: number;
  timestamp?: number;
  unit?: string;
}

/** An XY scatter data point. */
export interface XYPoint {
  name: string;
  x: number;
  y: number;
  timestamp?: number;
  unit?: string;
}

/** A text/log value (the `|t` flag); rendered as text, not plotted. */
export interface TextPoint {
  name: string;
  text: string;
  timestamp?: number;
}

export type ParsedTelemetry =
  | { type: "value"; point: TelemetryPoint }
  | { type: "xy"; point: XYPoint }
  | { type: "text"; point: TextPoint };

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
 * Parse a single serial line into zero or more structured telemetry points.
 * Returns an empty array for plain log lines (no `>` prefix) and for malformed
 * telemetry. A single line may yield several points (the `;` separator).
 */
export function parseTelemetryLine(line: string): ParsedTelemetry[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith(">")) {
    return [];
  }

  let body = trimmed.slice(1);

  // Split off `|flags` (everything after the first `|`).
  let flagSet = new Set<string>();
  const pipeIdx = body.indexOf("|");
  if (pipeIdx !== -1) {
    flagSet = new Set(
      body
        .slice(pipeIdx + 1)
        .split(/[,\s]+/)
        .filter(Boolean),
    );
    body = body.slice(0, pipeIdx);
  }

  // Split off `§unit` (a single unit for the whole line).
  let unit: string | undefined;
  const unitIdx = body.indexOf("§");
  if (unitIdx !== -1) {
    const u = body.slice(unitIdx + 1).trim();
    unit = u.length > 0 ? u : undefined;
    body = body.slice(0, unitIdx);
  }

  // `name` is everything before the first `:`; the rest are `;`-separated records.
  const firstColon = body.indexOf(":");
  if (firstColon === -1) {
    return [];
  }
  const name = body.slice(0, firstColon);
  if (name.length === 0) {
    return [];
  }
  const records = body.slice(firstColon + 1).split(";");

  const isXy = flagSet.has("xy");
  const isText = flagSet.has("t");
  const out: ParsedTelemetry[] = [];

  for (const record of records) {
    if (record.length === 0) {
      continue;
    }
    const fields = record.split(":");

    if (isXy) {
      // x:y or x:y:timestamp (timestamp last)
      if (fields.length < 2) {
        continue;
      }
      const x = Number(fields[0]);
      const y = Number(fields[1]);
      if (isNaN(x) || isNaN(y)) {
        continue;
      }
      const point: XYPoint = { name, x, y, unit };
      if (fields.length >= 3) {
        const ts = Number(fields[2]);
        if (!isNaN(ts)) {
          point.timestamp = ts;
        }
      }
      out.push({ type: "xy", point });
      continue;
    }

    if (isText) {
      // value or timestamp:value (value is free-form text)
      const hasTs = fields.length >= 2 && !isNaN(Number(fields[0]));
      const text = hasTs ? fields.slice(1).join(":") : fields.join(":");
      const point: TextPoint = { name, text };
      if (hasTs) {
        point.timestamp = Number(fields[0]);
      }
      out.push({ type: "text", point });
      continue;
    }

    // Numeric time series: value or timestamp:value
    if (fields.length === 1) {
      const value = Number(fields[0]);
      if (!isNaN(value)) {
        out.push({ type: "value", point: { name, value, unit } });
      }
    } else if (fields.length >= 2) {
      const ts = Number(fields[0]);
      const value = Number(fields[1]);
      if (!isNaN(ts) && !isNaN(value)) {
        out.push({ type: "value", point: { name, value, timestamp: ts, unit } });
      }
    }
  }

  return out;
}
