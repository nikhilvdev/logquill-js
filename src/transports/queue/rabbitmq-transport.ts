import { BaseQueueTransport, type BaseQueueTransportOptions } from "./base-queue-transport.js";
import type { LogRecord } from "../../core/records.js";

/** The subset of an `amqplib` `Channel` that `RabbitMQTransport` needs. Inject a fake in tests. */
export interface AmqpChannelLike {
  /** Optional: only called once, and only when provided, to ensure the queue exists. */
  assertQueue?(queue: string, options?: unknown): Promise<unknown>;
  /** Publishes one message directly to `queue`, matching `amqplib`'s own `Channel.sendToQueue()`. */
  sendToQueue(queue: string, content: Buffer, options?: unknown): boolean;
}

export interface RabbitMQTransportOptions extends BaseQueueTransportOptions {
  /** Pre-built channel, e.g. for tests, or an already-open amqplib `Channel`. Skips the `amqplib` auto-import entirely. */
  client?: AmqpChannelLike;
  /** Connection URL passed to `amqplib.connect()` when no `client` is injected. Default `"amqp://localhost"`. */
  url?: string;
}

/**
 * Publishes batches to a RabbitMQ queue via `amqplib`. RabbitMQ's core API
 * has no native multi-message batch primitive — there is no
 * `sendToQueue`-equivalent that takes an array — so `publishBatch()` loops
 * one `sendToQueue()` call per record. The "batch" LogQuill promises is at
 * the buffering level: `maxRecords`/`maxBytes` still governs how often that
 * loop runs, so this transport never makes one network round trip per log
 * call; it just can't make one round trip per *batch* either, honestly,
 * since RabbitMQ itself doesn't offer that primitive.
 *
 * `amqplib` is an optional peer dependency: install it yourself, or inject a
 * `client` (e.g. a fake, or an already-open `Channel`).
 */
export class RabbitMQTransport extends BaseQueueTransport {
  private readonly injectedClient: AmqpChannelLike | undefined;
  private readonly url: string;
  private client: AmqpChannelLike | undefined;

  constructor(options: RabbitMQTransportOptions) {
    super(options);
    this.injectedClient = options.client;
    this.url = options.url ?? "amqp://localhost";
  }

  /** Synchronously available channel, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): AmqpChannelLike | undefined {
    return this.injectedClient ?? this.client;
  }

  /**
   * Opens the real `amqplib` connection/channel and asserts the queue
   * exists. Both happen here, once, as part of acquiring the driver — not on
   * every `publishBatch()` call — so an injected `client` (tests, or a
   * caller's own already-open channel) is trusted to already have its queue
   * set up and is never re-asserted.
   */
  private async importClient(): Promise<AmqpChannelLike> {
    let channel: AmqpChannelLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "amqplib";
      const mod = (await import(moduleName)) as unknown as {
        connect(url: string): Promise<{ createChannel(): Promise<AmqpChannelLike> }>;
      };
      const connection = await mod.connect(this.url);
      channel = await connection.createChannel();
      await channel.assertQueue?.(this.topic);
    } catch {
      throw new Error(
        "RabbitMQTransport: install `amqplib` to use this transport without providing a client — `npm install amqplib`",
      );
    }

    this.client = channel;
    return channel;
  }

  protected async publishBatch(records: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    for (const record of records) {
      client.sendToQueue(this.topic, Buffer.from(JSON.stringify(record)));
    }
  }
}
