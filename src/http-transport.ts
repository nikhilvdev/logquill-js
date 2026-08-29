import type { Formatter } from "./formatter.js";
import { Transport } from "./transport.js";

/** Sends one batch of formatted lines to `url`. Swap in a fake for tests. */
export type Sender = (url: string, batch: readonly string[]) => Promise<void> | void;

async function fetchSender(url: string, batch: readonly string[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: batch.join("\n"),
  });
  if (!response.ok) {
    throw new Error(`HTTPTransport: request to ${url} failed with status ${String(response.status)}`);
  }
}

export interface HTTPTransportOptions {
  formatter?: Formatter;
  batchSize?: number;
  sender?: Sender;
}

/**
 * Batches formatted records and POSTs them as newline-delimited JSON via `fetch`.
 * Pass `sender` to swap in a fake for tests, or a different backend.
 */
export class HTTPTransport extends Transport {
  readonly url: string;
  readonly batchSize: number;
  private readonly sender: Sender;
  private batch: string[] = [];

  constructor(url: string, options: HTTPTransportOptions = {}) {
    super(options.formatter);
    this.url = url;
    this.batchSize = options.batchSize ?? 50;
    this.sender = options.sender ?? fetchSender;
  }

  write(formatted: string): void {
    this.batch.push(formatted);
    if (this.batch.length >= this.batchSize) {
      this.flush();
    }
  }

  /** Send the current batch now, even if it hasn't reached `batchSize`. */
  flush(): void {
    if (this.batch.length === 0) {
      return;
    }
    const batch = this.batch;
    this.batch = [];

    const result = this.sender(this.url, batch);
    if (result) {
      result.catch((error: unknown) => {
        // write()/close() are non-blocking by contract, so a send failure can't
        // propagate to the caller — report it the same way a broken plugin would.
        console.error("HTTPTransport: failed to send log batch", error);
      });
    }
  }

  override close(): void {
    this.flush();
  }
}
