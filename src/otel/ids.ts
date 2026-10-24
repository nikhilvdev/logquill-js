import { sha256Hex } from "../core/sha256.js";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

// The first `hexChars` of the SHA-256 of `text`; an all-zero id is invalid in
// OpenTelemetry, so it becomes 1 (as in logquill-python).
function digest(text: string, hexChars: 16 | 32): string {
  const hex = sha256Hex(text).slice(0, hexChars);
  return /^0+$/.test(hex) ? `${"0".repeat(hexChars - 1)}1` : hex;
}

/**
 * The 64-bit OpenTelemetry span id (16 lowercase hex characters) for a LogQuill
 * span id: the id itself if it already is 16 hex characters (the shape
 * `Logger.span()` generates), otherwise a stable hash of it. LangChain's run ids
 * are UUIDs, for example. The same input always gives the same id, so a child's
 * `parent_span_id` and its parent's own `span_id` still meet, and it is the same
 * id `logquill-python` derives.
 */
export function spanIdFor(value: string): string {
  return SPAN_ID.test(value) && value !== ZERO_SPAN ? value : digest(value, 16);
}

/**
 * The 128-bit trace id (32 lowercase hex characters) a record belongs to:
 * `meta.trace_id` if it's a valid 32-hex id (what `TraceContextPlugin` writes),
 * else derived from `meta.run_id` so every span of one agent run shares a trace.
 * `undefined` if the record names neither.
 */
export function traceIdFor(meta: Readonly<Record<string, unknown>>): string | undefined {
  const traceId = meta.trace_id;
  if (typeof traceId === "string" && TRACE_ID.test(traceId) && traceId !== ZERO_TRACE) {
    return traceId;
  }
  const runId = meta.run_id;
  if (typeof runId === "string" && runId !== "") return digest(`run:${runId}`, 32);
  return undefined;
}

/** A trace id for spans that name a parent but no run or trace: derived from the parent's id, so siblings share a trace. */
export function traceIdFromParent(parentSpanId: string): string {
  return digest(`parent:${parentSpanId}`, 32);
}
