/**
 * Browser-safe stand-in for `context.ts`, swapped in only when bundling the
 * `logquill/browser` entry (see the `"#context"` subpath import in
 * package.json's `imports` map) so that entry never pulls in
 * `node:async_hooks`. Browsers have no equivalent of `AsyncLocalStorage`,
 * so nesting is tracked with a plain stack of merged contexts instead:
 * correct for one in-flight `bindContext()` block at a time — including
 * across an internal `await`, since the frame is only popped once `fn`'s
 * returned promise settles — but, unlike the Node build, two
 * `bindContext()` blocks on the same stack running concurrently across an
 * `await` can still interleave and see each other's values, since both
 * frames sit on one shared stack with no way to tell which is "current"
 * independent of call order. Same documented trade-off as
 * `core/span-browser.ts`.
 */
const contextStack: Record<string, unknown>[] = [];

/** The merged key/value pairs bound by every `bindContext()` block currently active, or `{}` outside any block. */
export function currentContext(): Record<string, unknown> {
  return contextStack[contextStack.length - 1] ?? {};
}

export function bindContext<T>(values: Record<string, unknown>, fn: () => T): T {
  contextStack.push({ ...currentContext(), ...values });
  let result: T;
  try {
    result = fn();
  } catch (error) {
    contextStack.pop();
    throw error;
  }
  if (result instanceof Promise) {
    // Defer the pop until fn's returned promise settles, so a log call made
    // after an internal `await` still sees this block's context — a plain
    // synchronous `finally` would pop the frame the moment fn returns its
    // (still-pending) promise, before any of its post-`await` code runs.
    return result.finally(() => contextStack.pop()) as T;
  }
  contextStack.pop();
  return result;
}
