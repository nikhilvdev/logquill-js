import { AsyncLocalStorage } from "node:async_hooks";

const contextStore = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * The merged key/value pairs bound by every `bindContext()` block currently
 * active in this execution context, or `{}` outside any block. Backed by
 * `AsyncLocalStorage` (not a plain module variable) so concurrent async
 * operations sharing one `Logger` don't see each other's bound context —
 * the Node equivalent of Python's `contextvars`-based `current_context()`.
 */
export function currentContext(): Record<string, unknown> {
  return contextStore.getStore() ?? {};
}

/**
 * Runs `fn` with `values` merged into the request-scoped context for the
 * rest of its execution — every `Logger` call underneath it, through any
 * number of function calls and `await`s deep, picks them up in `meta`
 * automatically, without threading them through every signature by hand:
 *
 * ```ts
 * await bindContext({ requestId: "abc123" }, async () => {
 *   await handleRequest(); // any logging in here, or in what it calls,
 *                          // gets meta.requestId = "abc123" for free
 * });
 * ```
 *
 * Calls nest by merging: an inner `bindContext`'s value wins over an outer
 * one on key collision, the same way an explicit call-site `meta` value
 * always wins over anything bound here. `fn`'s return value (including a
 * `Promise`, whose continuations stay inside the bound context across any
 * `await`) is returned unchanged.
 */
export function bindContext<T>(values: Record<string, unknown>, fn: () => T): T {
  return contextStore.run({ ...currentContext(), ...values }, fn);
}
