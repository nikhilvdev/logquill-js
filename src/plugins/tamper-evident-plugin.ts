import { createHash } from "node:crypto";
import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

/** The hash chain's starting value — a record's `prevHash` when it's the first record in the chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Options for {@link TamperEvidentPlugin}. */
export interface TamperEvidentPluginOptions {
  /** Starting hash the chain builds from. Default `GENESIS_HASH`. Override to continue a chain started elsewhere (e.g. a previous process). */
  genesisHash?: string;
}

/** Deterministically stringifies a value with object keys sorted, so hashing doesn't depend on key insertion order. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`).join(",")}}`;
  }
  if (value === undefined) {
    return "null"; // JSON has no "undefined" literal; fold it the way JSON.stringify does inside arrays/objects
  }
  return JSON.stringify(value);
}

function computeHash(record: Pick<LogRecord, "timestamp" | "level" | "logger" | "message" | "meta">, prevHash: string): string {
  const restMeta = Object.fromEntries(Object.entries(record.meta).filter(([key]) => key !== "hash" && key !== "prevHash"));
  const payload = canonicalStringify({
    timestamp: record.timestamp,
    level: record.level,
    logger: record.logger,
    message: record.message,
    meta: restMeta,
  });
  return createHash("sha256").update(`${prevHash}${payload}`).digest("hex");
}

/**
 * Hash-chains every record so tampering with a written log can be
 * detected after the fact.
 *
 * Each record gets `meta.hash` — a SHA-256 hex digest over the record's
 * own content plus the previous record's hash (`meta.prevHash`) — the same
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
    const next = { ...record, meta: { ...record.meta, prevHash, hash: digest } };
    this.lastHash = digest;
    return next;
  }

  /**
   * Returns `true` iff every record's hash matches its content plus the
   * previous record's hash, in the given order. Returns `false` at the
   * first break in the chain (an edited, removed, or reordered record).
   */
  static verifyChain(
    records: Iterable<Pick<LogRecord, "timestamp" | "level" | "logger" | "message" | "meta">>,
    options: TamperEvidentPluginOptions = {},
  ): boolean {
    let prevHash = options.genesisHash ?? GENESIS_HASH;
    for (const record of records) {
      const storedHash = record.meta.hash;
      const storedPrevHash = record.meta.prevHash;
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
