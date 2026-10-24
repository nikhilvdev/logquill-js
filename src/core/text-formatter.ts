import type { Formatter } from "./formatter.js";
import type { LogRecord } from "./records.js";

function safeRepr(value: unknown): string {
  try {
    return String(value).slice(0, 200);
  } catch {
    return `<unrepresentable ${typeof value}>`;
  }
}

function dumpMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    // e.g. a circular reference or a BigInt: keep the entry readable rather
    // than let a log call's formatting fail
    return JSON.stringify(
      Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, safeRepr(v)])),
    );
  }
}

/**
 * Renders a record as one human-readable entry:
 *
 *     2026-01-01T00:00:00.000Z INFO  app.api: user signed up {"userId":42}
 *
 * Tolerant of partial records (a missing field renders as `?`), so it also
 * works on lines another tool wrote. A stack in `meta.stack` is printed on
 * the lines after the entry instead of as one long escaped JSON string.
 */
export function formatText(record: Partial<LogRecord>): string {
  const meta = { ...record.meta };
  const stack = typeof meta.stack === "string" && meta.stack ? meta.stack : undefined;
  if (stack !== undefined) delete meta.stack;

  let line = `${record.timestamp ?? "?"} ${(record.level ?? "?").padEnd(5)} ${record.logger ?? "?"}: ${record.message ?? ""}`;
  if (Object.keys(meta).length > 0) line += ` ${dumpMeta(meta)}`;
  if (stack !== undefined) line += `\n${stack.replace(/\n+$/, "")}`;
  return line;
}

/**
 * Human-readable single-entry output for local development and terminals —
 * `new ConsoleTransport({ formatter: new TextFormatter() })`. Use
 * `JSONFormatter` (the default) for anything a machine will read. Never
 * throws on odd `meta` values; they degrade to their string form.
 */
export class TextFormatter implements Formatter {
  /** Renders `record` via {@link formatText}. */
  format(record: LogRecord): string {
    return formatText(record);
  }
}
