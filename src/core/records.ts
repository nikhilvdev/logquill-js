import { Level, levelName } from "./levels.js";

/** The record shape this version writes. Shared with `logquill-python`: a record carries it as `schema_version` so a reader can tell which shape it has. */
export const SCHEMA_VERSION = "2.0";

/** What a record with no `schema_version` — anything written by logquill 1.x — is taken to be. */
export const LEGACY_SCHEMA_VERSION = "1.0";

/**
 * The LLM-call fields, first-class on a record rather than free-form `meta` so
 * cost and latency dashboards can rely on their names. Every key is optional;
 * a record that isn't an LLM call has no `llm` block at all.
 */
export interface LLMBlock {
  /** The model that was called, e.g. `"gpt-4o"`. */
  model?: string;
  /** Prompt tokens; a non-negative integer. */
  tokens_in?: number;
  /** Completion tokens; a non-negative integer. */
  tokens_out?: number;
  /** Cost of the call in US dollars. */
  cost_usd?: number;
  /** Wall-clock latency of the call in milliseconds. */
  latency_ms?: number;
  /** Why generation stopped, e.g. `"stop"` or `"length"`. */
  finish_reason?: string;
}

/** The cross-language record shape shared with logquill-python (see `schema/record.schema.json`). */
export interface LogRecord {
  /** The record shape version, e.g. `"2.0"`. */
  schema_version: string;
  /** ISO8601 UTC timestamp with millisecond precision. */
  timestamp: string;
  /** Level name, e.g. `"INFO"`. */
  level: string;
  /** Name of the `Logger` that created this record. */
  logger: string;
  /** The log message. */
  message: string;
  /** Structured payload — always present, even if empty. */
  meta: Record<string, unknown>;
  /** The LLM-call fields; present only on LLM-call records. */
  llm?: LLMBlock;
}

/** ISO8601 UTC timestamp with millisecond precision, matching Python's `utc_timestamp()`. */
export function utcTimestamp(): string {
  return new Date().toISOString();
}

/** Builds a `LogRecord` stamped with `SCHEMA_VERSION` and the current UTC timestamp. Used internally by `Logger`; exported for transports/plugins that need to construct a record directly. `llm` is included only when given. */
export function createRecord(params: {
  level: Level;
  logger: string;
  message: string;
  meta: Record<string, unknown>;
  llm?: LLMBlock | undefined;
}): LogRecord {
  const record: LogRecord = {
    schema_version: SCHEMA_VERSION,
    timestamp: utcTimestamp(),
    level: levelName(params.level),
    logger: params.logger,
    message: params.message,
    meta: params.meta,
  };
  if (params.llm !== undefined) record.llm = params.llm;
  return record;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)$/;
const SUPPORTED_MAJOR = Number(SCHEMA_VERSION.split(".")[0]);
const LEVEL_NAMES: readonly string[] = [
  Level.TRACE,
  Level.DEBUG,
  Level.INFO,
  Level.WARN,
  Level.ERROR,
  Level.FATAL,
].map((level) => levelName(level));

// `meta` keys logquill-js 1.x wrote in camelCase; 2.x writes them snake_case. Only
// these named keys are renamed — everything else in `meta` is the caller's own data.
const LEGACY_META_KEYS: Readonly<Record<string, string>> = {
  runId: "run_id",
  spanId: "span_id",
  parentSpanId: "parent_span_id",
  traceId: "trace_id",
  durationMs: "duration_ms",
  prevHash: "prev_hash",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a record another process wrote — a decoded JSON log line — into the
 * current shape, accepting both 2.x records and logquill 1.x ones.
 *
 * A record with no `schema_version` (everything 1.x wrote) comes back labelled
 * `"1.0"`; a missing `meta` becomes `{}`. A 1.x record from this package, which
 * wrote its named `meta` keys in camelCase, has those keys renamed to the
 * snake_case 2.x uses (`runId` → `run_id`), so it reads the same as one from
 * `logquill-python`. Keys this version doesn't know are kept, so a record from a
 * newer minor version passes through without losing data. Returns a new object;
 * the input isn't modified.
 *
 * Throws, saying what to fix, if a required field is missing or has the wrong
 * type, the level isn't one of `TRACE DEBUG INFO WARN ERROR FATAL`, or the
 * record's `schema_version` is a newer major version than this logquill reads.
 */
export function parseRecord(raw: unknown): LogRecord {
  if (!isObject(raw)) {
    throw new Error(
      `a log record must be a JSON object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const record: Record<string, unknown> = { ...raw };
  const legacy = !("schema_version" in record);
  if (legacy) record.schema_version = LEGACY_SCHEMA_VERSION;
  const version = record.schema_version;
  const match = typeof version === "string" ? VERSION_PATTERN.exec(version) : null;
  if (match === null) {
    throw new Error(
      `schema_version must be a string like '2.0', got ${JSON.stringify(version)} — is this a LogQuill record?`,
    );
  }
  if (Number(match[1]) > SUPPORTED_MAJOR) {
    throw new Error(
      `this record has schema_version ${JSON.stringify(version)}, newer than the ${JSON.stringify(SCHEMA_VERSION)} this logquill understands — upgrade logquill to read it`,
    );
  }

  for (const field of ["timestamp", "level", "logger", "message"]) {
    if (typeof record[field] !== "string") {
      throw new Error(
        `record field '${field}' must be a string, got ${JSON.stringify(record[field])}`,
      );
    }
  }
  if (!LEVEL_NAMES.includes(record.level as string)) {
    throw new Error(
      `record level ${JSON.stringify(record.level)} isn't one of ${LEVEL_NAMES.join(", ")} (upper case)`,
    );
  }

  if (!("meta" in record)) record.meta = {};
  const rawMeta = record.meta;
  if (!isObject(rawMeta)) {
    throw new Error(
      `record field 'meta' must be an object, got ${Array.isArray(rawMeta) ? "array" : typeof rawMeta}`,
    );
  }
  // Copied (not shared with the input), and for a 1.x record the named keys are renamed.
  record.meta = legacy
    ? Object.fromEntries(
        Object.entries(rawMeta).map(([key, value]) => [LEGACY_META_KEYS[key] ?? key, value]),
      )
    : { ...rawMeta };
  if (record.llm !== undefined && !isObject(record.llm)) {
    throw new Error(
      `record field 'llm' must be an object, got ${Array.isArray(record.llm) ? "array" : typeof record.llm}`,
    );
  }
  if (record.llm !== undefined) record.llm = { ...(record.llm as object) };
  return record as unknown as LogRecord;
}

/** The LLM-call fields as `llmCall()` takes them, in the camelCase this package's code-level options use. */
export interface LlmCallFields {
  /** The model that was called, e.g. `"gpt-4o"`. */
  model?: string;
  /** Prompt tokens; a non-negative integer. */
  tokensIn?: number;
  /** Completion tokens; a non-negative integer. */
  tokensOut?: number;
  /** Cost of the call in US dollars. */
  costUsd?: number;
  /** Wall-clock latency of the call in milliseconds. */
  latencyMs?: number;
  /** Why generation stopped, e.g. `"stop"` or `"length"`. */
  finishReason?: string;
}

/** {@link LlmCallFields} plus the record's message. */
export interface LlmCallOptions extends LlmCallFields {
  /** The record's message. Default `"llm_call"`. */
  message?: string;
}

const LLM_FIELDS: Readonly<
  Record<
    keyof LlmCallFields,
    { wire: keyof LLMBlock; expected: string; valid: (v: unknown) => boolean }
  >
> = {
  model: { wire: "model", expected: "a string", valid: (v) => typeof v === "string" },
  tokensIn: {
    wire: "tokens_in",
    expected: "a non-negative integer",
    valid: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
  },
  tokensOut: {
    wire: "tokens_out",
    expected: "a non-negative integer",
    valid: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
  },
  costUsd: {
    wire: "cost_usd",
    expected: "a non-negative number",
    valid: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  },
  latencyMs: {
    wire: "latency_ms",
    expected: "a non-negative number",
    valid: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  },
  finishReason: {
    wire: "finish_reason",
    expected: "a string",
    valid: (v) => typeof v === "string",
  },
};

/**
 * Assembles an {@link LLMBlock} from the fields, leaving out anything
 * `undefined`/`null` and anything that doesn't fit the contract (a negative
 * count, a string where a number belongs) — with a warning naming the field,
 * since a log call must not throw over a bad value, and a record that breaks the
 * schema is worse than one missing a field. Returns `undefined` if nothing is
 * left, so a record with no usable LLM data has no `llm` key at all.
 */
export function buildLlmBlock(fields: LlmCallFields): LLMBlock | undefined {
  const block: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const spec = LLM_FIELDS[name as keyof LlmCallFields] as
      (typeof LLM_FIELDS)[keyof LlmCallFields] | undefined;
    if (spec?.valid(value)) {
      block[spec.wire] = value;
    } else {
      const expected = spec?.expected ?? `one of ${Object.keys(LLM_FIELDS).join(", ")}`;
      console.warn(`llmCall: ignoring ${name}=${JSON.stringify(value)} — expected ${expected}`);
    }
  }
  return Object.keys(block).length > 0 ? block : undefined;
}
