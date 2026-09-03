/** How a full queue behaves when another task arrives. */
export type BackpressurePolicy = "dropOldest" | "dropNewest" | "block";

export interface DispatchQueueOptions {
  /** Maximum number of pending tasks the queue holds at once. Default 10_000. */
  maxSize?: number;
  /**
   * What happens when `enqueue()` is called while the queue is already at
   * `maxSize`:
   * - `"dropOldest"` (default) — evict the longest-waiting task (it never
   *   runs) and enqueue the new one. Favors recent records.
   * - `"dropNewest"` — discard the incoming task; everything already queued
   *   is left alone. Favors records already in flight.
   * - `"block"` — run the task synchronously, right now, on the caller's
   *   stack instead of queueing it. Nothing is ever dropped, at the cost of
   *   the caller (e.g. `logger.info()`) taking as long as the write itself —
   *   real backpressure rather than a silent drop.
   */
  policy?: BackpressurePolicy;
  /**
   * Called at most once per `warnIntervalMs` (default 5000) when the queue
   * drops tasks, with the number dropped since the last call — a
   * rate-limited way to surface sustained overload without flooding the
   * caller's own logs with one warning per drop. Defaults to `console.warn`.
   */
  onDrop?: (droppedSinceLastWarning: number, policy: BackpressurePolicy) => void;
  /** Minimum gap between `onDrop` calls. Default 5000ms. */
  warnIntervalMs?: number;
}

type Task = () => void | Promise<void>;

function isPromise(value: void | Promise<void>): value is Promise<void> {
  return typeof value === "object" && typeof value.then === "function";
}

function defaultScheduler(run: () => void): void {
  // Node has setImmediate (a real macrotask, letting the current call stack
  // — and any synchronous work queued right after it — finish first); a
  // browser bundle (Phase 8) falls back to a microtask.
  if (typeof setImmediate === "function") {
    setImmediate(run);
  } else {
    queueMicrotask(run);
  }
}

function defaultOnDrop(count: number, policy: BackpressurePolicy): void {
  console.warn(
    `DispatchQueue: dropped ${String(count)} record(s) — queue exceeded its configured size under the "${policy}" backpressure policy`,
  );
}

/**
 * A bounded, in-order queue of pending write tasks, drained outside the
 * caller's own call stack (`setImmediate`/microtask) so `Logger` methods can
 * return before the I/O they triggered actually runs. Backed by an explicit
 * size cap and backpressure policy — see `DispatchQueueOptions` — so a
 * sustained burst can never grow memory unboundedly.
 */
export class DispatchQueue {
  readonly maxSize: number;
  readonly policy: BackpressurePolicy;
  private readonly onDrop: (count: number, policy: BackpressurePolicy) => void;
  private readonly warnIntervalMs: number;

  private readonly tasks: Task[] = [];
  private draining = false;
  private scheduled = false;
  private idleWaiters: (() => void)[] = [];
  private droppedSinceWarning = 0;
  private lastWarnAt = 0;

  constructor(options: DispatchQueueOptions = {}) {
    this.maxSize = options.maxSize ?? 10_000;
    this.policy = options.policy ?? "dropOldest";
    this.onDrop = options.onDrop ?? defaultOnDrop;
    this.warnIntervalMs = options.warnIntervalMs ?? 5000;
  }

  /** Number of tasks currently waiting to run. Bounded by `maxSize`. */
  get size(): number {
    return this.tasks.length;
  }

  /**
   * Queue `task` to run outside the current call stack, applying the
   * configured backpressure policy if the queue is already full. Under
   * `"block"`, `task` may run synchronously before this call returns.
   */
  enqueue(task: Task): void {
    if (this.tasks.length < this.maxSize) {
      this.tasks.push(task);
      this.schedule();
      return;
    }

    switch (this.policy) {
      case "dropNewest":
        this.recordDrop();
        return;
      case "block":
        this.runInline(task);
        return;
      case "dropOldest":
      default:
        this.tasks.shift();
        this.recordDrop();
        this.tasks.push(task);
        this.schedule();
        return;
    }
  }

  /** Resolves once every task queued so far has run. Safe to call when idle. */
  async flush(): Promise<void> {
    if (this.tasks.length === 0 && !this.draining) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
      this.schedule();
    });
  }

  private recordDrop(): void {
    this.droppedSinceWarning += 1;
    const now = Date.now();
    if (now - this.lastWarnAt >= this.warnIntervalMs) {
      const count = this.droppedSinceWarning;
      this.droppedSinceWarning = 0;
      this.lastWarnAt = now;
      try {
        this.onDrop(count, this.policy);
      } catch {
        /* a broken onDrop callback must not crash logging */
      }
    }
  }

  private runInline(task: Task): void {
    try {
      const result = task();
      if (isPromise(result)) {
        result.catch((error: unknown) => {
          console.error("DispatchQueue: a blocked task failed", error);
        });
      }
    } catch (error) {
      console.error("DispatchQueue: a blocked task failed", error);
    }
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    defaultScheduler(() => {
      this.scheduled = false;
      void this.drainAll();
    });
  }

  private async drainAll(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (!task) {
          continue;
        }
        try {
          await task();
        } catch (error) {
          console.error("DispatchQueue: a queued task failed", error);
        }
      }
    } finally {
      this.draining = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }
}
