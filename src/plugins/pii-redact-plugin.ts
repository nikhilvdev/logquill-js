import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

/**
 * Syntactic (not semantic) patterns — matched on shape, so both false
 * positives (a random 9-digit number) and false negatives (anything that
 * doesn't look like these shapes) are expected. Override via `patterns`
 * for anything stricter.
 */
export const DEFAULT_PII_PATTERNS: Readonly<Record<string, RegExp>> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]?){13,16}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
};

const MAX_DEPTH = 50;

export interface PIIRedactPluginOptions {
  patterns?: Readonly<Record<string, RegExp>>;
  replacement?: string;
}

/**
 * Regex-based PII redaction over `meta` **values**, not just keys.
 *
 * Complements `RedactPlugin`, which redacts by exact key match —
 * `PIIRedactPlugin` scans string values (recursively through nested
 * objects/arrays) for emails, SSNs, credit-card numbers, and phone
 * numbers, and redacts matches wherever they appear, regardless of which
 * key holds them (a `notes` field containing a stray SSN is still caught).
 *
 * Detection is pattern-based: fast and dependency-free, but it matches on
 * syntactic shape, not meaning — a random 9-digit number can false-positive
 * as an SSN, and anything that doesn't fit these shapes (a name, a street
 * address) is a false negative. Pass your own `patterns` to extend or
 * replace the defaults.
 *
 * Recursion into nested `meta` structures is depth- and cycle-bounded, so a
 * circular reference or a pathologically deep structure can't hang or
 * crash the caller — it's left unredacted past the bound rather than
 * throwing.
 */
export class PIIRedactPlugin implements Plugin {
  readonly patterns: Readonly<Record<string, RegExp>>;
  readonly replacement: string;

  constructor(options: PIIRedactPluginOptions = {}) {
    this.patterns = options.patterns ?? DEFAULT_PII_PATTERNS;
    this.replacement = options.replacement ?? "***";
  }

  beforeLog(record: LogRecord): LogRecord {
    return { ...record, meta: this.redactValue(record.meta, new Set(), 0) as Record<string, unknown> };
  }

  private redactValue(value: unknown, seen: ReadonlySet<unknown>, depth: number): unknown {
    if (depth > MAX_DEPTH) {
      return value;
    }
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return value; // circular reference — leave as-is rather than recurse forever
      }
      const nextSeen = new Set(seen).add(value);
      return value.map((entry) => this.redactValue(entry, nextSeen, depth + 1));
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) {
        return value;
      }
      const nextSeen = new Set(seen).add(value);
      const result: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value)) {
        result[key] = this.redactValue(entryValue, nextSeen, depth + 1);
      }
      return result;
    }
    return value;
  }

  private redactText(text: string): string {
    let redacted = text;
    for (const pattern of Object.values(this.patterns)) {
      // Custom patterns aren't guaranteed to carry the "g" flag, but every
      // occurrence must be replaced (matching Python's `pattern.sub`) —
      // reconstruct with "g" added rather than silently stopping at the
      // first match.
      const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
      redacted = redacted.replace(global, this.replacement);
    }
    return redacted;
  }
}
