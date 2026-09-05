import { gzipSync } from "node:zlib";
import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** Which New Relic ingest region to send to — determines the Log API host. */
export type NewRelicRegion = "US" | "EU";

/** What `NewRelicSender` reports back about one delivery attempt, so the transport can drive its own 429 backoff logic. */
export interface NewRelicSenderResult {
  /** `true` for a 2xx response. */
  ok: boolean;
  /** HTTP status code of the response. */
  status: number;
  /** The raw `Retry-After` response header value, if present — either a number of seconds or an HTTP-date, per RFC 9110. */
  retryAfter: string | null;
}

/** Sends one gzip-compressed batch to New Relic's Log API at `url`. Swap in a fake for tests. */
export type NewRelicSender = (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer,
) => Promise<NewRelicSenderResult> | NewRelicSenderResult;

async function fetchNewRelicSender(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer,
): Promise<NewRelicSenderResult> {
  const response = await fetch(url, { method: "POST", headers, body });
  return {
    ok: response.ok,
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
  };
}

/** Returns a copy of `record` with the reserved `meta.eventType` key removed, leaving the original record untouched. */
function withoutEventType(record: LogRecord): LogRecord {
  const meta = { ...record.meta };
  delete meta.eventType;
  return { ...record, meta };
}

/** Resolves a `Retry-After` header value (seconds, or an HTTP-date) to an absolute epoch-ms resume time. */
function resumeTimestamp(retryAfter: string | null, now: number): number {
  if (retryAfter === null) {
    // New Relic blocks further sends for the rest of that calendar minute on
    // a rate-limit breach even when the header is missing — 60s is a safe floor.
    return now + 60_000;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return now + seconds * 1000;
  }
  const dateMs = Date.parse(retryAfter);
  return Number.isNaN(dateMs) ? now + 60_000 : dateMs;
}

/** Options for {@link NewRelicTransport}. */
export interface NewRelicTransportOptions extends BatchingTransportOptions {
  /** New Relic license key, sent in the `Api-Key` header. */
  licenseKey: string;
  /**
   * New Relic account region — selects the ingest host
   * (`log-api.newrelic.com` for US, `log-api.eu.newrelic.com` for EU).
   * Never hardcode this: an EU-region license key sent to the US host (or
   * vice versa) is rejected. Default `"US"`.
   */
  region?: NewRelicRegion;
  /** Delivers one gzip-compressed batch. Defaults to a `fetch` POST; override for a fake or to intercept 429s in tests. */
  sender?: NewRelicSender;
  /** Injectable clock for the 429 backoff window, matching `SamplingPlugin`'s injectable `rng`. Default `Date.now`. */
  clock?: () => number;
}

/**
 * Batches records and POSTs them, gzip-compressed, to New Relic's Log API
 * (`log-api.newrelic.com` / `log-api.eu.newrelic.com`, region-configurable)
 * via `fetch`. Strips the reserved `meta.eventType` key (New Relic drops
 * records carrying it) and honors 429 responses by reading `Retry-After`
 * and pausing further sends until it elapses, rather than hammering an
 * account that's already been rate-limited for the rest of the minute.
 *
 * Pass `sender` to swap in a fake for tests, and `clock` to control time in
 * backoff tests without waiting on a real clock.
 */
export class NewRelicTransport extends BatchingTransport {
  /** Ingest endpoint derived from `region`. */
  readonly url: string;
  /** New Relic account region this transport sends to. */
  readonly region: NewRelicRegion;
  private readonly licenseKey: string;
  private readonly sender: NewRelicSender;
  private readonly clock: () => number;
  private pausedUntil: number | null = null;

  constructor(options: NewRelicTransportOptions) {
    super(options);
    this.licenseKey = options.licenseKey;
    this.region = options.region ?? "US";
    this.url =
      this.region === "EU" ? "https://log-api.eu.newrelic.com/log/v1" : "https://log-api.newrelic.com/log/v1";
    this.sender = options.sender ?? fetchNewRelicSender;
    this.clock = options.clock ?? Date.now;
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const now = this.clock();
    if (this.pausedUntil !== null && now < this.pausedUntil) {
      console.error(
        `NewRelicTransport: sends paused until ${new Date(this.pausedUntil).toISOString()} after a 429 rate-limit response — skipping this batch rather than making a doomed request`,
      );
      return;
    }
    this.pausedUntil = null;

    const records = batch.map((record) => withoutEventType(record));
    const body = gzipSync(Buffer.from(JSON.stringify(records)));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Api-Key": this.licenseKey,
    };

    const result = await this.sender(this.url, headers, body);

    if (result.status === 429) {
      this.pausedUntil = resumeTimestamp(result.retryAfter, now);
      console.error(
        `NewRelicTransport: received 429 from New Relic — pausing sends until ${new Date(this.pausedUntil).toISOString()}. Reduce log volume or increase batching to stay under the rate limit.`,
      );
      return;
    }

    if (!result.ok) {
      throw new Error(
        `NewRelicTransport: request to ${this.url} failed with status ${String(result.status)} — check the license key and region`,
      );
    }
  }
}
