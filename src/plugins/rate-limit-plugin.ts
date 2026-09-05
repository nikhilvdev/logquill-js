import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

/** Derives the key a record is rate-limited under. Any hashable value works — it's used as a `Map` key. */
export type RateLimitKeyFunc = (record: LogRecord) => unknown;

function defaultKey(record: LogRecord): string {
  return `${record.logger}:${record.level}`;
}

export interface RateLimitPluginOptions {
  /** Groups records into independent windows. Default: `(logger, level)`. */
  keyFunc?: RateLimitKeyFunc;
  /** Distinct keys tracked at once before the least-recently-seen one is evicted. Default 1000. */
  maxKeys?: number;
  /** Injectable clock (seconds), for deterministic window-rollover tests. Defaults to `performance.now() / 1000` — monotonic, so a wall-clock adjustment can't shrink or extend a window. */
  clock?: () => number;
}

interface Window {
  start: number;
  count: number;
}

/**
 * Drops records once a key — by default `(logger, level)` — exceeds
 * `maxRecords` within a rolling `perSeconds` window, capping a noisy loop
 * (a retry that logs the same error every iteration, a hot path that logs
 * once per request) without silencing the logger's other messages.
 *
 * Each key gets its own fixed window: the count for a key resets
 * `perSeconds` after that *key's own* first record in the current window,
 * not a shared global clock, so unrelated keys never reset in lockstep.
 *
 * Pass `keyFunc` to rate-limit on something other than `(logger, level)` —
 * e.g. per error message, or per a `meta` field identifying the caller.
 *
 * Bounded by `maxKeys` distinct keys tracked at once; past that, the
 * least-recently-seen key's window is evicted to make room for a new one —
 * the same bounded-memory trade-off `SamplingPlugin` makes for trace
 * buffering, since an unbounded key space (e.g. rate-limiting per user id)
 * would otherwise grow memory without limit.
 */
export class RateLimitPlugin implements Plugin {
  readonly maxRecords: number;
  readonly perSeconds: number;
  readonly maxKeys: number;
  private readonly keyFunc: RateLimitKeyFunc;
  private readonly clock: () => number;
  private readonly windows = new Map<unknown, Window>();

  constructor(maxRecords: number, perSeconds: number, options: RateLimitPluginOptions = {}) {
    if (maxRecords < 1) {
      throw new Error(`maxRecords must be at least 1, got ${String(maxRecords)}`);
    }
    if (perSeconds <= 0) {
      throw new Error(`perSeconds must be positive, got ${String(perSeconds)}`);
    }
    this.maxRecords = maxRecords;
    this.perSeconds = perSeconds;
    this.keyFunc = options.keyFunc ?? defaultKey;
    this.maxKeys = options.maxKeys ?? 1000;
    this.clock = options.clock ?? (() => performance.now() / 1000);
  }

  beforeLog(record: LogRecord): LogRecord | null {
    const key = this.keyFunc(record);
    const now = this.clock();
    const window = this.windows.get(key);

    if (window === undefined || now - window.start >= this.perSeconds) {
      this.windows.delete(key);
      this.windows.set(key, { start: now, count: 1 });
      while (this.windows.size > this.maxKeys) {
        this.evictOldest();
      }
      return record;
    }

    // move to the end, marking this key as most-recently-touched
    this.windows.delete(key);
    this.windows.set(key, window);

    if (window.count >= this.maxRecords) {
      return null;
    }

    window.count += 1;
    return record;
  }

  private evictOldest(): void {
    const oldest = this.windows.keys().next();
    if (!oldest.done) {
      this.windows.delete(oldest.value);
    }
  }
}
