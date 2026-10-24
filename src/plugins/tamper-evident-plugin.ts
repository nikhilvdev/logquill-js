import { createHash } from "node:crypto";
import type { Plugin } from "../core/plugin.js";
import { LEGACY_SCHEMA_VERSION, type LogRecord } from "../core/records.js";

/** The hash chain's starting value — a record's `prev_hash` when it's the first record in the chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Options for {@link TamperEvidentPlugin}. */
export interface TamperEvidentPluginOptions {
  /** Starting hash the chain builds from. Default `GENESIS_HASH`. Override to continue a chain started elsewhere (e.g. a previous process). */
  genesisHash?: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

// Python's `json.dumps` (ensure_ascii) escapes everything outside space..~.
function pythonString(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be escaped
  return `"${text.replace(/["\\\u0000-\u001f\u007f-\uffff]/g, (char) => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

// Python's `repr(float)` switches to exponent form below 1e-4 and from 1e16, with a
// two-digit minimum exponent; JS switches at other points. Integral values print as
// ints, so a Python float like `12.0` (hashed as "12.0") can't be told from `12`.
function pythonNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value))
    return Number.isFinite(value) ? String(value) : "null";
  const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
  const exp = Number(exponent);
  if (exp >= -4 && exp < 16) return String(value);
  return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/**
 * Stringifies a value exactly as Python's `json.dumps(value, sort_keys=True)`
 * does — `", "` and `": "` separators, ASCII-only escapes — so a chain written
 * by `logquill-python` verifies here and the other way round. Keys sort by UTF-16
 * code unit, which matches Python's code-point order except around astral characters.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return pythonString(value);
  if (typeof value === "number") return pythonNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    return canonicalStringify((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalStringify(entry)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entry]) =>
          entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${pythonString(key)}: ${canonicalStringify(entry)}`).join(", ")}}`;
  }
  return "null"; // functions and symbols: dropped from objects above, null elsewhere
}

/** The fields a record's hash covers; what {@link TamperEvidentPlugin.verifyChain} accepts. */
export type HashableRecord = Pick<LogRecord, "timestamp" | "level" | "logger" | "message" | "meta"> &
  Partial<Pick<LogRecord, "schema_version" | "llm">>;

function computeHash(record: HashableRecord, prevHash: string): string {
  const restMeta = Object.fromEntries(
    Object.entries(record.meta).filter(([key]) => key !== "hash" && key !== "prev_hash"),
  );
  const content: Record<string, unknown> = {
    timestamp: record.timestamp,
    level: record.level,
    logger: record.logger,
    message: record.message,
    meta: restMeta,
  };
  // `schema_version` and `llm` are covered when present, so editing either is caught. "1.0" is
  // what `parseRecord` labels a record that had none, so it is left out: a 1.x chain verifies
  // the same before and after parsing.
  if (record.schema_version !== undefined && record.schema_version !== LEGACY_SCHEMA_VERSION) {
    content.schema_version = record.schema_version;
  }
  if (record.llm !== undefined) content.llm = record.llm;
  return createHash("sha256")
    .update(`${prevHash}${canonicalStringify(content)}`)
    .digest("hex");
}

/**
 * Hash-chains every record so tampering with a written log can be
 * detected after the fact.
 *
 * Each record gets `meta.hash` — a SHA-256 hex digest over the record's
 * own content plus the previous record's hash (`meta.prev_hash`) — the same
 * hash-chain construction used by tamper-evident/append-only logs: editing
 * or deleting any one line breaks every hash after it in the chain, even
 * if the tamperer edits the file directly and not through this plugin.
 * Opt-in — hashing every record has a real, measurable CPU cost, so it
 * isn't part of the default pipeline.
 *
 * Verify a previously-written log with `TamperEvidentPlugin.verifyChain`,
 * which re-derives each record's hash from its content and confirms it
 * matches both the stored `meta.hash` and the chain built from the records
 * before it, in order.
 */
export class TamperEvidentPlugin implements Plugin {
  private readonly genesisHash: string;
  private lastHash: string;

  constructor(options: TamperEvidentPluginOptions = {}) {
    this.genesisHash = options.genesisHash ?? GENESIS_HASH;
    this.lastHash = this.genesisHash;
  }

  beforeLog(record: LogRecord): LogRecord {
    const prevHash = this.lastHash;
    const digest = computeHash(record, prevHash);
    const next = { ...record, meta: { ...record.meta, prev_hash: prevHash, hash: digest } };
    this.lastHash = digest;
    return next;
  }

  /**
   * Returns `true` iff every record's hash matches its content plus the
   * previous record's hash, in the given order. Returns `false` at the
   * first break in the chain (an edited, removed, or reordered record).
   */
  static verifyChain(
    records: Iterable<HashableRecord>,
    options: TamperEvidentPluginOptions = {},
  ): boolean {
    let prevHash = options.genesisHash ?? GENESIS_HASH;
    for (const record of records) {
      const storedHash = record.meta.hash;
      const storedPrevHash = record.meta.prev_hash;
      if (typeof storedHash !== "string" || storedPrevHash !== prevHash) {
        return false;
      }
      if (computeHash(record, prevHash) !== storedHash) {
        return false;
      }
      prevHash = storedHash;
    }
    return true;
  }
}
