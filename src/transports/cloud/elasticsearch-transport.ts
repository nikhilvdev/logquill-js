import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";
import { toEcsDocument } from "./ecs-mapper.js";

/** Sends one pre-built NDJSON `_bulk` body to `url` with the given headers. Swap in a fake for tests. */
export type ElasticsearchSender = (
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
) => Promise<void> | void;

async function fetchElasticsearchSender(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-ndjson" },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `ElasticsearchTransport: request to ${url} failed with status ${String(response.status)}`,
    );
  }
}

/** Options for {@link ElasticsearchTransport}. */
export interface ElasticsearchTransportOptions extends BatchingTransportOptions {
  /** Cluster base URL, e.g. `"https://localhost:9200"`. */
  node: string;
  /** Index to write into. Default `"logs"`. */
  index?: string;
  /** Elasticsearch API key (base64 `id:api_key`), sent as `Authorization: ApiKey <apiKey>`. Omit to send no auth header (e.g. behind a proxy that adds its own). */
  apiKey?: string;
  /** Delivers one NDJSON `_bulk` body. Defaults to a `fetch` POST; override for a fake or a different delivery mechanism. */
  sender?: ElasticsearchSender;
}

/**
 * Batches records and POSTs them to Elasticsearch's `_bulk` API
 * (`<node>/_bulk`) via `fetch`, as newline-delimited action+source pairs —
 * no client dependency needed, just NDJSON body construction. Each document
 * is the record plus Elastic Common Schema fields (`@timestamp`, `log.level`,
 * `service.name`, `trace.id`, ...) so Kibana works on it with no field
 * mapping; it is always JSON, so a custom `formatter` is not applied. Pass `sender`
 * to swap in a fake for tests, or a different delivery mechanism.
 */
export class ElasticsearchTransport extends BatchingTransport {
  /** `_bulk` endpoint derived from the `node` option. */
  readonly url: string;
  /** Index written into. */
  readonly index: string;
  private readonly apiKey: string | undefined;
  private readonly sender: ElasticsearchSender;

  constructor(options: ElasticsearchTransportOptions) {
    super(options);
    if (options.formatter) {
      console.warn(
        "ElasticsearchTransport: the `formatter` option is ignored — documents are always JSON with Elastic Common Schema fields added. Remove it, or use another transport to control the output format.",
      );
    }
    this.index = options.index ?? "logs";
    this.url = `${options.node.replace(/\/+$/, "")}/_bulk`;
    this.apiKey = options.apiKey;
    this.sender = options.sender ?? fetchElasticsearchSender;
  }

  protected override sendBatch(batch: readonly LogRecord[]): Promise<void> | void {
    const lines: string[] = [];
    for (const record of batch) {
      lines.push(JSON.stringify({ index: { _index: this.index } }));
      lines.push(JSON.stringify(toEcsDocument(record)));
    }
    // The bulk API requires a trailing newline after the final action/source pair.
    const body = `${lines.join("\n")}\n`;
    const headers: Record<string, string> = {};
    if (this.apiKey !== undefined) {
      headers.Authorization = `ApiKey ${this.apiKey}`;
    }
    return this.sender(this.url, headers, body);
  }
}
