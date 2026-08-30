import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** DynamoDB's hard cap on items per `BatchWriteItem` call — respected by chunking within `sendBatch()`. */
const DYNAMO_BATCH_LIMIT = 25;

/** One item written to DynamoDB: `runId` is the partition key, `timestamp` is the sort key. */
export interface DynamoLogItem {
  runId: string;
  timestamp: string;
  level: string;
  logger: string;
  message: string;
  meta: Record<string, unknown>;
  spanId?: string;
  parentSpanId?: string;
  traceId?: string;
}

/**
 * The subset of DynamoDB write access `DynamoDBTransport` needs, deliberately
 * narrower than the AWS SDK v3 command pattern (`send(command)`): one
 * `BatchWriteItem`-equivalent call per sub-batch, already capped at
 * `DYNAMO_BATCH_LIMIT` items by the caller. This keeps fake-based tests
 * trivial — a fake just needs to record `(tableName, items)` calls, not
 * emulate a `DynamoDBClient`. Inject a fake in tests, or rely on the built-in
 * `@aws-sdk/client-dynamodb` wrapper by not injecting a `client`.
 */
export interface DynamoClientLike {
  batchWriteItems(tableName: string, items: readonly DynamoLogItem[]): Promise<unknown>;
}

export interface DynamoDBTransportOptions extends BatchingTransportOptions {
  /** Pre-built client, e.g. for tests, or a custom wrapper. Skips the `@aws-sdk/client-dynamodb` auto-import entirely. */
  client?: DynamoClientLike;
  /** Table to write into. Default `"logs"`. */
  tableName?: string;
  /** AWS region, used when no `client` is injected. Falls back to the SDK's own credential-chain resolution when omitted. */
  region?: string;
}

/** Minimal JS -> DynamoDB `AttributeValue` marshaller for the real-SDK code path, so this transport doesn't need `@aws-sdk/util-dynamodb` as a second peer dependency just to build one request shape. */
function toAttributeValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { NULL: true };
  }
  if (typeof value === "string") {
    return { S: value };
  }
  if (typeof value === "number") {
    return { N: String(value) };
  }
  if (typeof value === "boolean") {
    return { BOOL: value };
  }
  if (typeof value === "bigint") {
    return { N: value.toString() };
  }
  if (Array.isArray(value)) {
    return { L: value.map((entry) => toAttributeValue(entry)) };
  }
  if (typeof value === "object") {
    const m: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      m[key] = toAttributeValue(entryValue);
    }
    return { M: m };
  }
  // Functions/symbols aren't serializable log data — drop rather than stringify unpredictably.
  return { NULL: true };
}

function marshallItem(item: DynamoLogItem): Record<string, unknown> {
  return toAttributeValue({ ...item }).M as Record<string, unknown>;
}

/**
 * Sink for Amazon DynamoDB. Partition key is `runId`/`traceId` (whichever is
 * present on `record.meta`, `runId` taking priority), falling back to the
 * logger name when neither is set, so every record always lands under some
 * partition even before `RunPlugin`/`TraceContextPlugin` are wired up. Sort
 * key is `timestamp`.
 *
 * DynamoDB's actual `BatchWriteItem` API caps a call at 25 items, so
 * `sendBatch()` chunks a larger batch into sub-batches of 25 — matching how
 * `SQSTransport` respects `SendMessageBatch`'s 10-item cap.
 *
 * `@aws-sdk/client-dynamodb` is an optional peer dependency: install it
 * yourself, or inject a `client` (e.g. a fake, or a custom wrapper around a
 * `DynamoDBClient` your app already manages).
 */
export class DynamoDBTransport extends BatchingTransport {
  private readonly injectedClient: DynamoClientLike | undefined;
  private readonly tableName: string;
  private readonly region: string | undefined;
  private client: DynamoClientLike | undefined;

  constructor(options: DynamoDBTransportOptions = {}) {
    super(options);
    this.injectedClient = options.client;
    this.tableName = options.tableName ?? "logs";
    this.region = options.region;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): DynamoClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<DynamoClientLike> {
    let DynamoDBClientCtor: new (config: { region?: string }) => { send(command: unknown): Promise<unknown> };
    let BatchWriteItemCommandCtor: new (input: unknown) => unknown;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "@aws-sdk/client-dynamodb";
      const mod = (await import(moduleName)) as unknown as {
        DynamoDBClient: new (config: { region?: string }) => { send(command: unknown): Promise<unknown> };
        BatchWriteItemCommand: new (input: unknown) => unknown;
      };
      DynamoDBClientCtor = mod.DynamoDBClient;
      BatchWriteItemCommandCtor = mod.BatchWriteItemCommand;
    } catch {
      throw new Error(
        "DynamoDBTransport: install `@aws-sdk/client-dynamodb` to use this transport without providing a client — `npm install @aws-sdk/client-dynamodb`",
      );
    }

    const sdkClient = new DynamoDBClientCtor(this.region ? { region: this.region } : {});
    this.client = {
      async batchWriteItems(tableName: string, items: readonly DynamoLogItem[]): Promise<unknown> {
        const requestItems = {
          [tableName]: items.map((item) => ({ PutRequest: { Item: marshallItem(item) } })),
        };
        return sdkClient.send(new BatchWriteItemCommandCtor({ RequestItems: requestItems }));
      },
    };
    return this.client;
  }

  /** `meta.runId`, else `meta.traceId`, else the logger name — see the class doc for why. */
  private partitionKey(record: LogRecord): string {
    const runId = record.meta.runId;
    if (typeof runId === "string" && runId.length > 0) {
      return runId;
    }
    const traceId = record.meta.traceId;
    if (typeof traceId === "string" && traceId.length > 0) {
      return traceId;
    }
    return record.logger;
  }

  private toDynamoItem(record: LogRecord): DynamoLogItem {
    const spanId = record.meta.spanId;
    const parentSpanId = record.meta.parentSpanId;
    const traceId = record.meta.traceId;
    return {
      runId: this.partitionKey(record),
      timestamp: record.timestamp,
      level: record.level,
      logger: record.logger,
      message: record.message,
      meta: record.meta,
      ...(typeof spanId === "string" ? { spanId } : {}),
      ...(typeof parentSpanId === "string" ? { parentSpanId } : {}),
      ...(typeof traceId === "string" ? { traceId } : {}),
    };
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const items = batch.map((record) => this.toDynamoItem(record));
    const chunks: DynamoLogItem[][] = [];
    for (let offset = 0; offset < items.length; offset += DYNAMO_BATCH_LIMIT) {
      chunks.push(items.slice(offset, offset + DYNAMO_BATCH_LIMIT));
    }
    // Dispatched concurrently rather than one-at-a-time: each sub-batch is an
    // independent BatchWriteItem call, and issuing them together (instead of
    // serially awaiting each) is both higher-throughput and keeps every call
    // in a sub-batch-sized flush starting in the same tick `sendBatch` runs.
    await Promise.all(chunks.map((chunk) => client.batchWriteItems(this.tableName, chunk)));
  }
}
