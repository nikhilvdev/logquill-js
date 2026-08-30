import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** The subset of a `redis` (node-redis v4) client that `RedisTransport` needs. Inject a fake in tests. */
export interface RedisClientLike {
  xAdd(stream: string, id: string, fields: Record<string, string>): Promise<unknown>;
}

export interface RedisTransportOptions extends BatchingTransportOptions {
  /** Pre-built, already-connected client, e.g. for tests. Skips the `redis` auto-import entirely. */
  client?: RedisClientLike;
  /** `redis` connection URL, used when no `client` is injected. Default `"redis://localhost:6379"`. */
  url?: string;
  /** Stream key to `XADD` into. Default `"logquill:logs"`. */
  stream?: string;
}

/**
 * Sink for Redis, via Redis Streams (`XADD`) — as CLAUDE.md's spec puts it,
 * "a fast local buffer, a different use case from durable storage, not a
 * replacement for the others." Reach for this when you want a low-latency
 * local tail (e.g. feeding a `redis-cli XREAD`-based live viewer) rather than
 * a system of record.
 *
 * Streams has no true multi-entry `XADD`, so unlike the other batching
 * transports this issues one `XADD` per record within the batch rather than
 * one network call per batch — batching here still bounds memory and reduces
 * GC/buffer churn, but it is honestly not a network-call batch the way
 * `MongoDBTransport.insertMany()` or `DynamoDBTransport`'s `BatchWriteItem`
 * chunks are.
 *
 * `redis` is an optional peer dependency: install it yourself, or inject a
 * `client` (e.g. a fake, or an already-connected client your app manages).
 */
export class RedisTransport extends BatchingTransport {
  private readonly injectedClient: RedisClientLike | undefined;
  private readonly url: string;
  private readonly stream: string;
  private client: RedisClientLike | undefined;

  constructor(options: RedisTransportOptions = {}) {
    super(options);
    this.injectedClient = options.client;
    this.url = options.url ?? "redis://localhost:6379";
    this.stream = options.stream ?? "logquill:logs";
  }

  /** Synchronously available client, if one was injected or already connected — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): RedisClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<RedisClientLike> {
    let createClient: (options: { url: string }) => RedisClientLike & { connect(): Promise<unknown> };
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "redis";
      const mod = (await import(moduleName)) as unknown as {
        createClient: (options: { url: string }) => RedisClientLike & { connect(): Promise<unknown> };
      };
      createClient = mod.createClient;
    } catch {
      throw new Error(
        "RedisTransport: install `redis` to use this transport without providing a client — `npm install redis`",
      );
    }

    const client = createClient({ url: this.url });
    await client.connect();
    this.client = client;
    return client;
  }

  private toFields(record: LogRecord): Record<string, string> {
    return {
      timestamp: record.timestamp,
      level: record.level,
      logger: record.logger,
      message: record.message,
      meta: JSON.stringify(record.meta),
    };
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    // One XADD per record, all issued together rather than serially awaited —
    // see the class doc for why Streams can't take a single multi-entry append.
    await Promise.all(batch.map((record) => client.xAdd(this.stream, "*", this.toFields(record))));
  }
}
