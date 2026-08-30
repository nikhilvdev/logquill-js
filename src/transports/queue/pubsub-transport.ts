import { BaseQueueTransport, type BaseQueueTransportOptions } from "./base-queue-transport.js";
import type { LogRecord } from "../../core/records.js";

/**
 * The subset of a `@google-cloud/pubsub` `Topic` that `PubSubTransport`
 * needs. Inject a fake in tests, or an already-resolved `Topic` instance.
 */
export interface PubSubTopicLike {
  publishMessage(message: { data: Buffer }): Promise<string>;
}

export interface PubSubTransportOptions extends BaseQueueTransportOptions {
  /** Pre-built topic reference, e.g. for tests, or an already-resolved `@google-cloud/pubsub` `Topic`. Skips the `@google-cloud/pubsub` auto-import entirely. */
  client?: PubSubTopicLike;
  /** GCP project ID passed to `@google-cloud/pubsub` when no `client` is injected. */
  projectId?: string;
}

/**
 * Publishes batches to a GCP Pub/Sub topic via `@google-cloud/pubsub`. The
 * real client already does its own internal batching/flow-control underneath
 * `publishMessage()` — this transport doesn't reimplement that. What it does
 * own is LogQuill's own bounded-memory contract: `publishBatch()` only runs
 * once per buffer flush (`maxRecords`/`maxBytes`), so the driver is never
 * invoked once per individual log call.
 *
 * `@google-cloud/pubsub` is an optional peer dependency: install it
 * yourself, or inject a `client` (e.g. a fake, or a resolved `Topic`).
 */
export class PubSubTransport extends BaseQueueTransport {
  private readonly injectedClient: PubSubTopicLike | undefined;
  private readonly projectId: string | undefined;
  private client: PubSubTopicLike | undefined;

  constructor(options: PubSubTransportOptions) {
    super(options);
    this.injectedClient = options.client;
    this.projectId = options.projectId;
  }

  /** Synchronously available topic reference, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): PubSubTopicLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<PubSubTopicLike> {
    let topic: PubSubTopicLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "@google-cloud/pubsub";
      const mod = (await import(moduleName)) as unknown as {
        PubSub: new (config: { projectId?: string | undefined }) => { topic(name: string): PubSubTopicLike };
      };
      topic = new mod.PubSub({ projectId: this.projectId }).topic(this.topic);
    } catch {
      throw new Error(
        "PubSubTransport: install `@google-cloud/pubsub` to use this transport without providing a client — `npm install @google-cloud/pubsub`",
      );
    }

    this.client = topic;
    return topic;
  }

  protected async publishBatch(records: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    // Fire every `publishMessage()` call in the same tick (via `.map`) and
    // await them together, rather than one at a time — the real client
    // already does its own internal batching/flow-control, so a sequential
    // per-record `await` here would only add unnecessary microtask turns.
    await Promise.all(records.map((record) => client.publishMessage({ data: Buffer.from(JSON.stringify(record)) })));
  }
}
