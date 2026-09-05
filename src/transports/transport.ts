import { JSONFormatter, type Formatter } from "../core/formatter.js";
import type { LogRecord } from "../core/records.js";

/**
 * Sink for log records, per the cross-language transport contract:
 * `format(record) -> string`, `write(formatted, record)`, `close()` on shutdown.
 */
export abstract class Transport {
  /** Turns a `LogRecord` into the string this transport actually writes. Defaults to `JSONFormatter`. */
  formatter: Formatter;

  constructor(formatter: Formatter = new JSONFormatter()) {
    this.formatter = formatter;
  }

  /** Formats `record` via `this.formatter`. Called once per record before `write()`. */
  format(record: LogRecord): string {
    return this.formatter.format(record);
  }

  /** Sends the already-formatted record to this transport's sink. */
  abstract write(formatted: string, record: LogRecord): void;

  /** Flush/release resources on shutdown. No-op unless a transport overrides it. */
  close(): void {}
}

/** Duck-typed: a transport (typically a `BatchingTransport`) whose `flush()` sends its current buffer now, without closing. */
export interface FlushableTransport {
  /** Sends the current buffer now, even if it hasn't reached its own flush threshold. */
  flush(): void | Promise<void>;
}

/** Type guard for {@link FlushableTransport} — true for any transport (e.g. every `BatchingTransport`) that exposes a `flush()` method. */
export function hasFlush(transport: Transport): transport is Transport & FlushableTransport {
  return typeof (transport as Partial<FlushableTransport>).flush === "function";
}

/** In-memory transport for tests: collects every (formatted, record) pair written to it. */
export class CollectingTransport extends Transport {
  /** Every formatted string passed to `write()`, in call order. */
  readonly formatted: string[] = [];
  /** Every raw `LogRecord` passed to `write()`, in call order. */
  readonly records: LogRecord[] = [];
  /** Set once `close()` has been called. */
  closed = false;

  write(formatted: string, record: LogRecord): void {
    this.formatted.push(formatted);
    this.records.push(record);
  }

  override close(): void {
    this.closed = true;
  }
}
