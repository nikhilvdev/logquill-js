import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** Options for {@link BaseQueueTransport} and every concrete queue transport that extends it. */
export interface BaseQueueTransportOptions extends BatchingTransportOptions {
  /**
   * Destination name on the backend — a Kafka topic, a RabbitMQ queue name,
   * an SQS queue URL, or a GCP Pub/Sub topic. One generic option name so the
   * base class's orchestration stays backend-agnostic; each subclass's own
   * docs use its backend's own vocabulary for what this means.
   */
  topic: string;
}

/**
 * Abstract base for every message-queue transport (`KafkaTransport`,
 * `RabbitMQTransport`, `SQSTransport`, `PubSubTransport`). Owns the "always
 * batch, never publish one message per log call" contract shared across
 * every queue backend — buffering itself is inherited from
 * `BatchingTransport`; each concrete subclass only implements
 * `publishBatch()` against its own driver's publish API.
 */
export abstract class BaseQueueTransport extends BatchingTransport {
  /** Destination name on the backend — a Kafka topic, a RabbitMQ queue name, an SQS queue URL, or a GCP Pub/Sub topic. */
  readonly topic: string;

  constructor(options: BaseQueueTransportOptions) {
    super(options);
    this.topic = options.topic;
  }

  protected override sendBatch(batch: readonly LogRecord[]): Promise<void> {
    return this.publishBatch(batch);
  }

  /** Deliver one batch of records to the queue backend. Always called with a non-empty batch. */
  protected abstract publishBatch(records: readonly LogRecord[]): Promise<void>;
}
