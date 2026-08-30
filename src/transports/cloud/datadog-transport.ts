import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** Sends one batch of formatted lines to Datadog's Logs intake API at `url`. Swap in a fake for tests. */
export type DatadogSender = (url: string, apiKey: string, batch: readonly string[]) => Promise<void> | void;

async function fetchDatadogSender(url: string, apiKey: string, batch: readonly string[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
    body: `[${batch.join(",")}]`,
  });
  if (!response.ok) {
    throw new Error(
      `DatadogTransport: request to ${url} failed with status ${String(response.status)} — check the API key and site region`,
    );
  }
}

export interface DatadogTransportOptions extends BatchingTransportOptions {
  /** Datadog API key, sent in the `DD-API-KEY` header. */
  apiKey: string;
  /**
   * Datadog site (region), e.g. `"datadoghq.com"` (US1, default),
   * `"datadoghq.eu"` (EU), `"us3.datadoghq.com"`, `"us5.datadoghq.com"`,
   * `"ap1.datadoghq.com"`. Never hardcode this — sending to the wrong
   * region's intake host silently fails to deliver logs to your account.
   */
  site?: string;
  sender?: DatadogSender;
}

/**
 * Batches records and POSTs them as a JSON array to Datadog's Logs intake
 * API (`https://http-intake.logs.<site>/api/v2/logs`) via `fetch`. Pass
 * `sender` to swap in a fake for tests, or a different delivery mechanism.
 */
export class DatadogTransport extends BatchingTransport {
  readonly url: string;
  readonly apiKey: string;
  readonly site: string;
  private readonly sender: DatadogSender;

  constructor(options: DatadogTransportOptions) {
    super(options);
    this.apiKey = options.apiKey;
    this.site = options.site ?? "datadoghq.com";
    this.url = `https://http-intake.logs.${this.site}/api/v2/logs`;
    this.sender = options.sender ?? fetchDatadogSender;
  }

  protected override sendBatch(batch: readonly LogRecord[]): Promise<void> | void {
    const formatted = batch.map((record) => this.format(record));
    return this.sender(this.url, this.apiKey, formatted);
  }
}
