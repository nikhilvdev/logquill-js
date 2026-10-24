import type { Formatter } from "./formatter.js";
import type { LogRecord } from "./records.js";

const RESERVED_KEYS = ["timestamp", "level", "logger", "message"];

// Nested objects flatten to dotted keys up to this depth; deeper values are
// emitted as one JSON string so a pathologically nested (or circular) value
// can't blow up the line.
const MAX_FLATTEN_DEPTH = 5;

const CONTROL = "\\x00-\\x1f\\x7f\\x85\\u2028\\u2029";
const NEEDS_QUOTES = new RegExp(`[\\s"=\\\\${CONTROL}]|^$`);
const BAD_KEY_CHARS = new RegExp(`[\\s"=\\\\${CONTROL}]`, "g");
const CONTROL_CHAR = new RegExp(`^[${CONTROL}]$`);
const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function quote(text: string): string {
  if (!NEEDS_QUOTES.test(text)) return text;
  const escaped = Array.from(text, (char) => {
    if (ESCAPES[char]) return ESCAPES[char];
    return CONTROL_CHAR.test(char)
      ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      : char;
  }).join("");
  return `"${escaped}"`;
}

function key(raw: unknown): string {
  return String(raw).replace(BAD_KEY_CHARS, "_") || "_";
}

function safeStr(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `<unrepresentable ${typeof value}>`;
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return safeStr(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "string") return quote(value);
  if (value instanceof Date) return quote(value.toISOString());
  if (typeof value === "object") return quote(json(value));
  return quote(safeStr(value));
}

function flatten(prefix: string, value: unknown, depth: number, out: string[]): void {
  if (isPlainObject(value) && Object.keys(value).length > 0 && depth < MAX_FLATTEN_DEPTH) {
    for (const [childKey, child] of Object.entries(value))
      flatten(`${prefix}.${key(childKey)}`, child, depth + 1, out);
    return;
  }
  out.push(`${prefix}=${scalar(value)}`);
}

/**
 * Single-line `key=value` output — the logfmt convention from Heroku and Go's
 * logging ecosystem — for downstream tooling (Loki, Splunk, `grep`) that
 * expects it:
 *
 *     timestamp=2026-01-01T00:00:00.000Z level=INFO logger=app message="user signed up" userId=42
 *
 * `meta` keys follow the four record fields as top-level pairs; nested
 * objects flatten to dotted keys (`http.status=200`); arrays are emitted as a
 * JSON string. Values with whitespace, `=`, quotes or control characters are
 * double-quoted and escaped, so the output is always exactly one line. A
 * `meta` key named like a record field is emitted as `meta.<key>`. Use
 * `parseLogfmt` to read the format back. Never throws on odd `meta` values.
 */
export class LogfmtFormatter implements Formatter {
  /** Renders `record` as one logfmt line. */
  format(record: LogRecord): string {
    const pairs = [
      `timestamp=${quote(record.timestamp)}`,
      `level=${quote(record.level)}`,
      `logger=${quote(record.logger)}`,
      `message=${quote(record.message)}`,
    ];
    for (const [metaKey, value] of Object.entries(record.meta)) {
      const k = key(metaKey);
      flatten(RESERVED_KEYS.includes(k) ? `meta.${k}` : k, value, 1, pairs);
    }
    return pairs.join(" ");
  }
}

const LOGFMT_PAIR = /([^\s="]+)(?:=("(?:[^"\\]|\\.)*"|[^\s"]*))?/g;
const UNESCAPES: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" };

function unescape(quoted: string): string {
  return quoted.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, code: string) =>
    code.length === 5
      ? String.fromCharCode(parseInt(code.slice(1), 16))
      : (UNESCAPES[code] ?? `\\${code}`),
  );
}

/**
 * Splits one logfmt line (`LogfmtFormatter` output, or any Heroku/Go-style
 * `key=value` line) into an object of strings. Quoted values are unescaped; a
 * bare key with no `=` maps to `""`; if a key repeats, the last value wins.
 * Values are always strings — convert them yourself, or use `parse()` with a
 * pattern if you need typed fields.
 */
export function parseLogfmt(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, k = "", v = ""] of line.matchAll(LOGFMT_PAIR)) {
    fields[k] =
      v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? unescape(v.slice(1, -1)) : v;
  }
  return fields;
}
