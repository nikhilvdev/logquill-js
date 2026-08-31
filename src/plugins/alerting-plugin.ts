import { Level, parseLevel, type LevelInput } from "../core/levels.js";
import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

interface DedupeWindow {
  record: LogRecord;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface AlertingPluginOptions {
  /** A record at or above this level fires an alert. Default `Level.ERROR`. */
  threshold?: LevelInput;
  /** How long a dedupe window stays open before a collapsed follow-up alert (if any) fires. Default 300_000 (5 minutes). */
  dedupeWindowMs?: number;
  /** Groups records into the same dedupe window. Default: `level:logger:message`. */
  dedupeKey?: (record: LogRecord) => string;
  /** Distinct concurrent dedupe keys tracked at once; beyond this, new keys are dropped rather than tracked. Default 500. */
  maxTrackedKeys?: number;
}

function defaultDedupeKey(record: LogRecord): string {
  return `${record.level}:${record.logger}:${record.message}`;
}

/**
 * Base class for plugins that fire an external alert on ERROR/FATAL (or any
 * configurable `threshold`).
 *
 * A concrete subclass implements only `sendAlert(record, occurrences)` —
 * everything else (thresholding, deduplication, never blocking the caller,
 * never letting a broken destination crash logging) lives here.
 *
 * The first record at or above `threshold` for a given dedupe key (by
 * default: level + logger + message) fires `sendAlert` right away, without
 * awaiting it — so the log call that triggered it is never blocked on a
 * webhook, SMTP handshake, or any other I/O, even if the destination is
 * slow or unreachable. This stands in for the shared async dispatch queue
 * a later phase will introduce; once that queue exists, `AlertingPlugin`
 * can route through it instead of firing its own unawaited call per alert.
 *
 * Any further record matching the same dedupe key within
 * `dedupeWindowMs` of the first is *not* sent again — it just increments a
 * counter. When the window closes, if more than one record matched,
 * exactly one follow-up alert is sent with the total occurrence count,
 * instead of spamming the destination once per record. Tracking is bounded
 * to `maxTrackedKeys` distinct concurrent dedupe keys; beyond that, new
 * keys are dropped rather than tracked (alerting degrades under extreme
 * cardinality, logging itself never does).
 *
 * `sendAlert` is always called without being awaited, and any rejection is
 * routed to this plugin's own `onError`, the same as any other plugin hook
 * that throws.
 */
export abstract class AlertingPlugin implements Plugin {
  readonly threshold: Level;
  readonly dedupeWindowMs: number;
  readonly maxTrackedKeys: number;
  private readonly dedupeKeyFn: (record: LogRecord) => string;
  private readonly windows = new Map<string, DedupeWindow>();

  constructor(options: AlertingPluginOptions = {}) {
    this.threshold = parseLevel(options.threshold ?? Level.ERROR);
    this.dedupeWindowMs = options.dedupeWindowMs ?? 300_000;
    this.dedupeKeyFn = options.dedupeKey ?? defaultDedupeKey;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 500;
  }

  afterLog(record: LogRecord): void {
    if (parseLevel(record.level) < this.threshold) {
      return;
    }

    const key = this.dedupeKeyFn(record);
    const existing = this.windows.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    if (this.windows.size >= this.maxTrackedKeys) {
      return;
    }

    const timer = setTimeout(() => {
      this.flush(key);
    }, this.dedupeWindowMs);
    timer.unref();
    this.windows.set(key, { record, count: 1, timer });

    this.safeSend(record, 1);
  }

  private flush(key: string): void {
    const window = this.windows.get(key);
    this.windows.delete(key);
    if (!window || window.count <= 1) {
      return;
    }
    this.safeSend(window.record, window.count);
  }

  private safeSend(record: LogRecord, occurrences: number): void {
    Promise.resolve()
      .then(() => this.sendAlert(record, occurrences))
      .catch((error: unknown) => {
        try {
          this.onError?.(error, record);
        } catch {
          /* swallowed */
        }
      });
  }

  /**
   * Send one alert for `record`, representing `occurrences` collapsed
   * duplicates (1 on first occurrence; the deduped total on a follow-up
   * flush). Override in a concrete subclass — never call this directly,
   * `AlertingPlugin` calls it without awaiting it.
   */
  protected abstract sendAlert(record: LogRecord, occurrences: number): void | Promise<void>;

  onError?(error: unknown, record: LogRecord): void;

  /** Cancel any pending dedupe-window timers. Call on logger shutdown. */
  close(): void {
    const windows = [...this.windows.values()];
    this.windows.clear();
    for (const window of windows) {
      clearTimeout(window.timer);
    }
  }
}
