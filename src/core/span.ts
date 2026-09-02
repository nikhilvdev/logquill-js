import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const spanIdStore = new AsyncLocalStorage<string>();

/**
 * The `spanId` of the innermost `Logger.span()` block active in this
 * execution context, or `undefined` outside any span. Backed by
 * `AsyncLocalStorage` (not a plain module variable) so concurrent async
 * operations sharing one `Logger` don't see each other's span nesting —
 * the Node equivalent of Python's `contextvars`-based `current_span_id()`.
 */
export function currentSpanId(): string | undefined {
  return spanIdStore.getStore();
}

/** A 16-hex-char id, matching the shape of an OTel span id. */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Runs `fn` with `spanId` as the active span for the rest of its
 * synchronous execution and every asynchronous continuation chained from
 * it — including `await`s inside `fn` — so nested log calls and nested
 * `span()` blocks resolve `currentSpanId()` correctly without needing to
 * be passed the span explicitly.
 */
export function runInSpan<T>(spanId: string, fn: () => T): T {
  return spanIdStore.run(spanId, fn);
}
