/**
 * Browser-safe stand-in for `context.ts`, swapped in only when bundling the
 * `logquill/browser` entry (see the `"#context"` subpath import in
 * package.json's `imports` map) so that entry never pulls in
 * `node:async_hooks`. Browsers have no equivalent of `AsyncLocalStorage`,
 * so nesting is tracked with a plain stack of merged contexts instead:
 * correct for synchronous `bindContext()` nesting, but — unlike the Node
 * build — two `bindContext()` calls running concurrently across an `await`
 * on the same logger can interleave and see each other's values. Same
 * documented trade-off as `core/span-browser.ts`.
 */
const contextStack: Record<string, unknown>[] = [];

/** The merged key/value pairs bound by every `bindContext()` block currently active, or `{}` outside any block. */
export function currentContext(): Record<string, unknown> {
  return contextStack[contextStack.length - 1] ?? {};
}

export function bindContext<T>(values: Record<string, unknown>, fn: () => T): T {
  contextStack.push({ ...currentContext(), ...values });
  try {
    return fn();
  } finally {
    contextStack.pop();
  }
}
