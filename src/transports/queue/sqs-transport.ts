import { BaseQueueTransport, type BaseQueueTransportOptions } from "./base-queue-transport.js";
import type { LogRecord } from "../../core/records.js";

/** AWS's own cap on a single `SendMessageBatch` request. Never exceed it. */
const SQS_BATCH_LIMIT = 10;

/**
 * The subset of AWS SDK v3's SQS client that `SQSTransport` needs, narrowed
 * to a plain `sendMessageBatch(queueUrl, entries)` method rather than
 * modeling the full `@aws-sdk/client-sqs` command/client pattern — simpler
 * to fake in tests, and the only shape this transport actually calls. Inject
 * a fake in tests, or wrap a real `SQSClient` to match this shape.
 */
export interface SQSClientLike {
  sendMessageBatch(queueUrl: string, entries: { id: string; body: string }[]): Promise<unknown>;
}

export interface SQSTransportOptions extends BaseQueueTransportOptions {
  /** Pre-built client, e.g. for tests, or a thin wrapper around `@aws-sdk/client-sqs`'s `SQSClient`. Skips the `@aws-sdk/client-sqs` auto-import entirely. */
  client?: SQSClientLike;
  /** AWS region passed to `@aws-sdk/client-sqs` when no `client` is injected. */
  region?: string;
}

/**
 * Publishes batches to an SQS queue via `@aws-sdk/client-sqs`'s
 * `SendMessageBatch`. That API caps a single request at 10 messages, so
 * `publishBatch()` chunks any larger batch into sub-batches of 10 —
 * LogQuill's own `maxRecords`/`maxBytes` buffering can flush more than 10
 * records at once; this transport is responsible for respecting SQS's own
 * limit underneath, per the message-queue contract in the project spec.
 *
 * `@aws-sdk/client-sqs` is an optional peer dependency: install it
 * yourself, or inject a `client` (e.g. a fake, or a wrapped `SQSClient`).
 */
export class SQSTransport extends BaseQueueTransport {
  private readonly injectedClient: SQSClientLike | undefined;
  private readonly region: string | undefined;
  private client: SQSClientLike | undefined;

  constructor(options: SQSTransportOptions) {
    super(options);
    this.injectedClient = options.client;
    this.region = options.region;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): SQSClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<SQSClientLike> {
    let client: SQSClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "@aws-sdk/client-sqs";
      const mod = (await import(moduleName)) as unknown as {
        SQSClient: new (config: { region?: string | undefined }) => { send(command: unknown): Promise<unknown> };
        SendMessageBatchCommand: new (input: {
          QueueUrl: string;
          Entries: { Id: string; MessageBody: string }[];
        }) => unknown;
      };
      const sdkClient = new mod.SQSClient({ region: this.region });
      const CommandCtor = mod.SendMessageBatchCommand;
      client = {
        sendMessageBatch: (queueUrl, entries) =>
          sdkClient.send(
            new CommandCtor({
              QueueUrl: queueUrl,
              Entries: entries.map((entry) => ({ Id: entry.id, MessageBody: entry.body })),
            }),
          ),
      };
    } catch {
      throw new Error(
        "SQSTransport: install `@aws-sdk/client-sqs` to use this transport without providing a client — `npm install @aws-sdk/client-sqs`",
      );
    }

    this.client = client;
    return client;
  }

  protected async publishBatch(records: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const chunks: (readonly LogRecord[])[] = [];
    for (let start = 0; start < records.length; start += SQS_BATCH_LIMIT) {
      chunks.push(records.slice(start, start + SQS_BATCH_LIMIT));
    }
    // Fire every sub-batch's request in the same tick (via `.map`) and await
    // them together, rather than one at a time — an `await` per iteration of
    // a sequential loop would otherwise force each sub-batch onto its own
    // microtask turn for no benefit, since the requests don't depend on
    // each other.
    await Promise.all(
      chunks.map((chunk) =>
        client.sendMessageBatch(
          this.topic,
          chunk.map((record, index) => ({ id: String(index), body: JSON.stringify(record) })),
        ),
      ),
    );
  }
}
