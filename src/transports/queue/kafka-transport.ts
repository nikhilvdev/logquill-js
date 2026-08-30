import { BaseQueueTransport, type BaseQueueTransportOptions } from "./base-queue-transport.js";
import type { LogRecord } from "../../core/records.js";

/** The subset of a `kafkajs` `Producer` that `KafkaTransport` needs. Inject a fake in tests. */
export interface KafkaProducerLike {
  /** Optional: some injected producers (or fakes) are already connected. */
  connect?(): Promise<void>;
  send(record: { topic: string; messages: { key: string | null; value: string }[] }): Promise<unknown>;
}

export interface KafkaTransportOptions extends BaseQueueTransportOptions {
  /** Pre-built producer, e.g. for tests, or an already-configured kafkajs `Producer`. Skips the `kafkajs` auto-import entirely. */
  client?: KafkaProducerLike;
  /** Broker addresses passed to `kafkajs`'s `Kafka({ brokers })` when no `client` is injected. Default `["localhost:9092"]`. */
  brokers?: string[];
}

function metaKey(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Publishes batches to a Kafka topic via `kafkajs`. Each message's `key` is
 * set to `meta.runId` (falling back to `meta.traceId`, then `null`), so
 * kafkajs's default partitioner keeps every message from the same agent
 * run/trace on one partition — preserving per-trace ordering, per the
 * message-queue contract in the project spec.
 *
 * `kafkajs` is an optional peer dependency: install it yourself, or inject a
 * `client` (e.g. a fake, or an already-configured `Producer`).
 */
export class KafkaTransport extends BaseQueueTransport {
  private readonly injectedClient: KafkaProducerLike | undefined;
  private readonly brokers: string[];
  private client: KafkaProducerLike | undefined;

  constructor(options: KafkaTransportOptions) {
    super(options);
    this.injectedClient = options.client;
    this.brokers = options.brokers ?? ["localhost:9092"];
  }

  /** Synchronously available producer, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): KafkaProducerLike | undefined {
    return this.injectedClient ?? this.client;
  }

  /**
   * Builds the real `kafkajs` producer and connects it. Connection happens
   * here, once, as part of acquiring the driver — not on every
   * `publishBatch()` call — so an injected `client` (tests, or a caller's
   * own already-connected producer) is trusted to already be ready and is
   * never re-connected.
   */
  private async importClient(): Promise<KafkaProducerLike> {
    let producer: KafkaProducerLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "kafkajs";
      const mod = (await import(moduleName)) as unknown as {
        Kafka: new (config: { brokers: string[] }) => { producer(): KafkaProducerLike };
      };
      producer = new mod.Kafka({ brokers: this.brokers }).producer();
      await producer.connect?.();
    } catch {
      throw new Error(
        "KafkaTransport: install `kafkajs` to use this transport without providing a client — `npm install kafkajs`",
      );
    }

    this.client = producer;
    return producer;
  }

  protected async publishBatch(records: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    await client.send({
      topic: this.topic,
      messages: records.map((record) => ({
        key: metaKey(record.meta, "runId") ?? metaKey(record.meta, "traceId") ?? null,
        value: JSON.stringify(record),
      })),
    });
  }
}
