/**
 * Browser-safe stand-in for `span.ts`, swapped in only when bundling the
 * `logquill/browser` entry (see the `alias` in tsup.config.ts) so that entry
 * never pulls in `node:async_hooks`/`node:crypto`. Browsers have no
 * equivalent of `AsyncLocalStorage`, so nesting is tracked with a plain
 * stack instead: correct for the common case (one span open at a time, or
 * cleanly nested synchronous spans), but — unlike the Node build — two
 * spans on the same `Logger` running concurrently across an `await` can
 * interleave and stamp the wrong `parentSpanId`. Documented trade-off, not
 * an oversight: `test/core/tracing.test.ts`'s concurrent-span guarantee is
 * a Node-only guarantee, exercised only through `src/index.ts`.
 */
const spanStack: string[] = [];

/** The innermost span active on this stack, or `undefined` outside any span. */
export function currentSpanId(): string | undefined {
  return spanStack[spanStack.length - 1];
}

/** A 16-hex-char id, matching the shape of `span.ts`'s Node id and an OTel span id. */
export function newSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function runInSpan<T>(spanId: string, fn: () => T): T {
  spanStack.push(spanId);
  try {
    return fn();
  } finally {
    spanStack.pop();
  }
}
