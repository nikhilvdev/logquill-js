import { JSONFormatter, type Formatter } from "../core/formatter.js";
import type { LogRecord } from "../core/records.js";

/**
 * Sink for log records, per the cross-language transport contract:
 * `format(record) -> string`, `write(formatted, record)`, `close()` on shutdown.
 */
export abstract class Transport {
  formatter: Formatter;

  constructor(formatter: Formatter = new JSONFormatter()) {
    this.formatter = formatter;
  }

  format(record: LogRecord): string {
    return this.formatter.format(record);
  }

  abstract write(formatted: string, record: LogRecord): void;

  /** Flush/release resources on shutdown. No-op unless a transport overrides it. */
  close(): void {}
}

/** Duck-typed: a transport (typically a `BatchingTransport`) whose `flush()` sends its current buffer now, without closing. */
export interface FlushableTransport {
  flush(): void | Promise<void>;
}

export function hasFlush(transport: Transport): transport is Transport & FlushableTransport {
  return typeof (transport as Partial<FlushableTransport>).flush === "function";
}

/** In-memory transport for tests: collects every (formatted, record) pair written to it. */
export class CollectingTransport extends Transport {
  readonly formatted: string[] = [];
  readonly records: LogRecord[] = [];
  closed = false;

  write(formatted: string, record: LogRecord): void {
    this.formatted.push(formatted);
    this.records.push(record);
  }

  override close(): void {
    this.closed = true;
  }
}
