import type { Formatter } from "../core/formatter.js";
import { Transport } from "./transport.js";

/** Sends one batch of formatted lines to `url`. Swap in a fake for tests. */
export type BeaconSender = (url: string, batch: readonly string[]) => void;

/**
 * `@types/node`'s `Navigator` doesn't declare `sendBeacon` (it's DOM-only,
 * and this project has no DOM lib), so it's cast to this local shape at the
 * one call site that needs it.
 */
interface BeaconNavigator {
  sendBeacon(url: string, data: string): boolean;
}

function defaultBeaconSender(url: string, batch: readonly string[]): void {
  const body = batch.join("\n");
  // Isomorphic guard: `navigator` doesn't exist at runtime before Node 21,
  // and its presence there is limited (no `sendBeacon`) — same pattern as
  // ConsoleTransport's `typeof process === "undefined"` guard.
  const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as BeaconNavigator);
  if (nav && typeof nav.sendBeacon === "function") {
    nav.sendBeacon(url, body);
    return;
  }
  // Fallback for environments without `navigator.sendBeacon` (a worker, an
  // older browser, or this transport running under Node): `fetch` with
  // `keepalive` so the request can still complete after the page/caller
  // that queued it goes away, matching `sendBeacon`'s fire-and-forget contract.
  void fetch(url, { method: "POST", body, keepalive: true }).catch((error: unknown) => {
    // write()/close() are non-blocking by contract, so a send failure can't
    // propagate to the caller — report it the same way HTTPTransport does.
    console.error("BeaconTransport: failed to send log batch", error);
  });
}

/** Options for {@link BeaconTransport}. */
export interface BeaconTransportOptions {
  /** Turns a `LogRecord` into the string this transport writes. Defaults to `JSONFormatter`. */
  formatter?: Formatter;
  /** Flush once the buffer holds this many lines. Default 20 — kept low since `sendBeacon` payloads are capped. */
  batchSize?: number;
  /** Delivers one batch. Defaults to `sendBeacon` with a `fetch(..., { keepalive: true })` fallback; override for a fake or a different backend. */
  sender?: BeaconSender;
}

/**
 * Batches formatted records and sends them via `navigator.sendBeacon`,
 * falling back to a `keepalive` `fetch` where `sendBeacon` isn't available.
 * Meant for the browser: unlike `HTTPTransport`, a beacon send can complete
 * even after the page that queued it starts unloading. Keep `batchSize`
 * small — `sendBeacon` payloads are capped (64KB in most browsers).
 */
export class BeaconTransport extends Transport {
  /** Endpoint each batch is sent to. */
  readonly url: string;
  /** Buffer is flushed once it holds this many lines. */
  readonly batchSize: number;
  private readonly sender: BeaconSender;
  private batch: string[] = [];

  constructor(url: string, options: BeaconTransportOptions = {}) {
    super(options.formatter);
    this.url = url;
    this.batchSize = options.batchSize ?? 20;
    this.sender = options.sender ?? defaultBeaconSender;
  }

  /** Buffers the formatted line, flushing the batch once `batchSize` is reached. */
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

    try {
      this.sender(this.url, batch);
    } catch (error) {
      console.error("BeaconTransport: failed to send log batch", error);
    }
  }

  override close(): void {
    this.flush();
  }
}
