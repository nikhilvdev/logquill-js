import { Level, parseLevel, type LevelInput } from "../core/levels.js";
import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";
import type { Transport } from "../transports/transport.js";

/** Options for {@link SamplingPlugin}. */
export interface SamplingPluginOptions {
  /** Source of randomness for the rate check. Defaults to `Math.random`; override with a seeded/fake generator for deterministic tests. */
  rng?: () => number;
  /** `meta` key holding the trace/run id used to group buffered records. Default `"traceId"`. */
  traceKey?: string;
  /** A record at or above this level elevates its whole trace. Default `Level.ERROR`. */
  elevateAt?: LevelInput;
  /** Enables tail-based elevation, writing straight to these transports on elevation. Omit to disable and get plain rate-based sampling. */
  transports?: Transport[];
  /** Total buffered records allowed across every trace before the oldest trace is evicted. Default 1000. */
  maxBufferedRecords?: number;
  /** Distinct trace ids held at once before the oldest is evicted. Default 200. */
  maxTraces?: number;
}

/**
 * Keeps roughly `rate` of records (0.0-1.0), dropping the rest.
 *
 * With `transports` set, sampling becomes tail-based per trace: a record
 * that would otherwise be dropped is buffered under its `meta[traceKey]`
 * value instead of discarded outright. If any later record sharing that
 * trace id reaches `elevateAt` or above, the whole trace is "elevated" —
 * every buffered record for that trace id is flushed straight to
 * `transports`, and every subsequent record for that trace id ships
 * unconditionally. This is what lets a sampled-out request still produce a
 * complete trace once it turns out to matter (it errored).
 *
 * Flushing writes buffered records directly to `transports` — pass the
 * same array given to the `Logger`. This bypasses `beforeLog`/`afterLog`/
 * `onError` for any plugin *after* `SamplingPlugin` in the pipeline (the
 * plugins before it already ran, since that's how the buffered record was
 * built); put `SamplingPlugin` last if that matters for your pipeline.
 *
 * Without `transports`, tail-based elevation is inactive and this behaves
 * exactly like plain rate-based sampling (the original behavior) — a
 * record without `meta[traceKey]` is also just rate-sampled, since there's
 * no trace to buffer it under.
 *
 * Buffering is bounded: at most `maxBufferedRecords` records total and
 * `maxTraces` distinct trace ids are held at once. Once either limit is
 * hit, the oldest buffered trace is evicted (and its records are lost, not
 * flushed) — a deliberate bounded-memory trade-off, not a bug: an
 * unbounded per-trace buffer would let a single pathologically long-lived
 * or high-cardinality trace grow memory without limit.
 */
export class SamplingPlugin implements Plugin {
  /** Fraction of non-elevated records kept, in `[0, 1]`. */
  readonly rate: number;
  /** `meta` key holding the trace/run id used to group buffered records. */
  readonly traceKey: string;
  /** A record at or above this level elevates its whole trace. */
  readonly elevateAt: Level;
  /** Transports buffered records are flushed straight to on elevation; `undefined` disables tail-based elevation. */
  readonly transports: Transport[] | undefined;
  /** Total buffered records allowed across every trace before the oldest trace is evicted. */
  readonly maxBufferedRecords: number;
  /** Distinct trace ids held at once before the oldest is evicted. */
  readonly maxTraces: number;
  private readonly rng: () => number;
  private readonly buffer = new Map<unknown, LogRecord[]>();
  private bufferedCount = 0;
  private readonly elevated = new Set<unknown>();

  constructor(rate: number, options: SamplingPluginOptions = {}) {
    if (rate < 0 || rate > 1) {
      throw new Error(`rate must be between 0 and 1, got ${String(rate)}`);
    }
    this.rate = rate;
    this.rng = options.rng ?? Math.random;
    this.traceKey = options.traceKey ?? "traceId";
    this.elevateAt = parseLevel(options.elevateAt ?? Level.ERROR);
    this.transports = options.transports;
    this.maxBufferedRecords = options.maxBufferedRecords ?? 1000;
    this.maxTraces = options.maxTraces ?? 200;
  }

  beforeLog(record: LogRecord): LogRecord | null {
    const transports = this.transports;
    if (transports === undefined) {
      return this.rng() < this.rate ? record : null;
    }

    const traceId = record.meta[this.traceKey];

    if (traceId !== undefined && this.elevated.has(traceId)) {
      return record;
    }

    const keep = this.rng() < this.rate;
    const reachedElevateLevel = parseLevel(record.level) >= this.elevateAt;

    if (traceId !== undefined && reachedElevateLevel) {
      this.elevate(traceId, transports);
      return record;
    }

    if (keep) {
      return record;
    }

    if (traceId !== undefined) {
      this.bufferRecord(traceId, record);
    }

    return null;
  }

  private elevate(traceId: unknown, transports: Transport[]): void {
    this.elevated.add(traceId);
    const buffered = this.buffer.get(traceId) ?? [];
    this.buffer.delete(traceId);
    this.bufferedCount -= buffered.length;
    for (const bufferedRecord of buffered) {
      for (const transport of transports) {
        transport.write(transport.format(bufferedRecord), bufferedRecord);
      }
    }
  }

  private bufferRecord(traceId: unknown, record: LogRecord): void {
    let records = this.buffer.get(traceId);
    if (records) {
      // move to the end, marking this trace as most-recently-touched
      this.buffer.delete(traceId);
      this.buffer.set(traceId, records);
    } else {
      if (this.buffer.size >= this.maxTraces) {
        this.evictOldestTrace();
      }
      records = [];
      this.buffer.set(traceId, records);
    }

    records.push(record);
    this.bufferedCount += 1;

    while (this.bufferedCount > this.maxBufferedRecords && this.buffer.size > 0) {
      this.evictOldestTrace();
    }
  }

  private evictOldestTrace(): void {
    const oldest = this.buffer.entries().next();
    if (oldest.done) {
      return;
    }
    const [oldestKey, oldestRecords] = oldest.value;
    this.buffer.delete(oldestKey);
    this.bufferedCount -= oldestRecords.length;
  }
}
