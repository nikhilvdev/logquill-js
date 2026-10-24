/**
 * Counts how many times the same tool call has been reopened, so
 * `meta.retry_count` can be stamped on `.action()` records automatically — a
 * retry loop is one of the commonest agent failure modes and is otherwise
 * invisible in the logs.
 *
 * A tool call is identified by (enclosing span, tool name, tool call id). The
 * first `.action()` for it is attempt 0; each further one before it succeeds is
 * a retry (1, 2, 3, ...). A successful `.observation()` ends the chain, so a
 * loop that legitimately calls one tool ten times isn't reported as ten
 * retries.
 *
 * Bounded: at most `maxEntries` in-flight calls are remembered, oldest
 * forgotten first, so a long-running process can't grow it without limit.
 */
export class RetryTracker {
  private readonly attempts = new Map<string, number>();

  /** @param maxEntries How many distinct in-flight tool calls to remember. */
  constructor(readonly maxEntries = 1024) {
    if (maxEntries < 1) {
      throw new Error(`RetryTracker: maxEntries must be >= 1, got ${String(maxEntries)}`);
    }
  }

  private static key(spanId: string | undefined, tool: string, callId: string | undefined): string {
    return JSON.stringify([spanId ?? "", tool, callId ?? ""]);
  }

  /** Records another action for this call; returns its retry count (0 for the first attempt). */
  opened(spanId: string | undefined, tool: string, callId?: string): number {
    const key = RetryTracker.key(spanId, tool, callId);
    const count = (this.attempts.get(key) ?? -1) + 1;
    this.attempts.delete(key); // re-insert so it counts as most recently used
    this.attempts.set(key, count);
    if (this.attempts.size > this.maxEntries) {
      const oldest = this.attempts.keys().next();
      if (!oldest.done) this.attempts.delete(oldest.value);
    }
    return count;
  }

  /** The call finished successfully; forget it. */
  succeeded(spanId: string | undefined, tool: string, callId?: string): void {
    this.attempts.delete(RetryTracker.key(spanId, tool, callId));
  }
}
