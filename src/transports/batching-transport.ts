import type { Formatter } from "../core/formatter.js";
import type { LogRecord } from "../core/records.js";
import { Transport } from "./transport.js";

/** Options for {@link BatchingTransport} and every concrete batching transport that extends it. */
export interface BatchingTransportOptions {
  /** Turns a `LogRecord` into the string this transport writes. Defaults to `JSONFormatter`. */
  formatter?: Formatter;
  /** Flush once the buffer holds this many items. Default 100. */
  maxRecords?: number;
  /** Flush once the buffer's estimated byte size reaches this many bytes. Default 1_000_000 (1MB). */
  maxBytes?: number;
}

/**
 * Shared base for every batching sink transport (SQL, NoSQL, message queues,
 * batching cloud-native transports). Buffers items and flushes once either
 * `maxRecords` or `maxBytes` is reached, so no batching transport can grow
 * its buffer unboundedly under a sustained burst.
 *
 * `write()`/`close()` stay non-blocking from the caller's perspective: a
 * failed `sendBatch()` is reported via `console.error` rather than thrown,
 * matching `HTTPTransport`'s contract.
 */
export abstract class BatchingTransport<T = LogRecord> extends Transport {
  /** Buffer is flushed once it holds this many items. */
  readonly maxRecords: number;
  /** Buffer is flushed once its estimated byte size reaches this many bytes. */
  readonly maxBytes: number;
  private buffer: T[] = [];
  private bufferBytes = 0;

  constructor(options: BatchingTransportOptions = {}) {
    super(options.formatter);
    this.maxRecords = options.maxRecords ?? 100;
    this.maxBytes = options.maxBytes ?? 1_000_000;
  }

  /** Converts a written record into the buffered item type. Defaults to the record itself. */
  protected toItem(formatted: string, record: LogRecord): T {
    void formatted;
    return record as unknown as T;
  }

  /** Estimated byte size of one buffered item, used for the `maxBytes` bound. */
  protected sizeOf(item: T): number {
    return JSON.stringify(item).length;
  }

  /** Buffers the record, flushing the batch once `maxRecords`/`maxBytes` is reached. */
  write(formatted: string, record: LogRecord): void {
    const item = this.toItem(formatted, record);
    this.buffer.push(item);
    this.bufferBytes += this.sizeOf(item);
    if (this.buffer.length >= this.maxRecords || this.bufferBytes >= this.maxBytes) {
      this.flush();
    }
  }

  /** Send the current batch now, even if it hasn't reached a bound. */
  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    const result = this.sendBatch(batch);
    if (result) {
      result.catch((error: unknown) => {
        console.error(`${this.constructor.name}: failed to send log batch`, error);
      });
    }
  }

  override close(): void {
    this.flush();
  }

  /** Deliver one batch to the backend. Always called with a non-empty batch. */
  protected abstract sendBatch(batch: readonly T[]): Promise<void> | void;
}
