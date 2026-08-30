import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** One CloudWatch Logs event: epoch-milliseconds timestamp plus a single log line. */
export interface CloudWatchLogEvent {
  timestamp: number;
  message: string;
}

/**
 * The subset of the AWS SDK v3 CloudWatch Logs client that `CloudWatchTransport`
 * needs. Deliberately narrower than the SDK's full command pattern (build a
 * `PutLogEventsCommand`, `.send()` it, track the deprecated sequence-token
 * dance) — modeling just this one operation keeps the injectable-fake surface
 * small for tests; `importClient()` builds the real adapter around it.
 */
export interface CloudWatchClientLike {
  putLogEvents(
    logGroupName: string,
    logStreamName: string,
    events: readonly CloudWatchLogEvent[],
  ): Promise<unknown>;
}

export interface CloudWatchTransportOptions extends BatchingTransportOptions {
  /** CloudWatch Logs log group to write into. */
  logGroupName: string;
  /** CloudWatch Logs log stream, within `logGroupName`, to write into. */
  logStreamName: string;
  /** AWS region, e.g. `"us-east-1"`. Passed to the real SDK client; ignored when `client` is injected. */
  region?: string;
  /** Pre-built client, e.g. for tests. Skips the `@aws-sdk/client-cloudwatch-logs` auto-import entirely. */
  client?: CloudWatchClientLike;
}

interface AWSCloudWatchLogsClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * Ships batched records to AWS CloudWatch Logs via the AWS SDK v3
 * (`@aws-sdk/client-cloudwatch-logs`). Each buffered record becomes one log
 * event; CloudWatch requires events within a single `PutLogEvents` call to be
 * sorted by timestamp ascending, which `sendBatch()` does before sending.
 *
 * `@aws-sdk/client-cloudwatch-logs` is an optional peer dependency: install
 * it yourself, or inject a `client` (e.g. a fake, or an already-configured
 * `CloudWatchLogsClient` wrapped to match `CloudWatchClientLike`).
 */
export class CloudWatchTransport extends BatchingTransport {
  readonly logGroupName: string;
  readonly logStreamName: string;
  readonly region: string | undefined;
  private readonly injectedClient: CloudWatchClientLike | undefined;
  private client: CloudWatchClientLike | undefined;

  constructor(options: CloudWatchTransportOptions) {
    super(options);
    this.logGroupName = options.logGroupName;
    this.logStreamName = options.logStreamName;
    this.region = options.region;
    this.injectedClient = options.client;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): CloudWatchClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<CloudWatchClientLike> {
    let ClientCtor: new (config: { region?: string | undefined }) => AWSCloudWatchLogsClientLike;
    let PutLogEventsCommandCtor: new (input: unknown) => unknown;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "@aws-sdk/client-cloudwatch-logs";
      const mod = (await import(moduleName)) as unknown as {
        CloudWatchLogsClient: new (config: { region?: string | undefined }) => AWSCloudWatchLogsClientLike;
        PutLogEventsCommand: new (input: unknown) => unknown;
      };
      ClientCtor = mod.CloudWatchLogsClient;
      PutLogEventsCommandCtor = mod.PutLogEventsCommand;
    } catch {
      throw new Error(
        "CloudWatchTransport: install `@aws-sdk/client-cloudwatch-logs` to use this transport without providing a client — `npm install @aws-sdk/client-cloudwatch-logs`",
      );
    }

    const sdkClient = new ClientCtor({ region: this.region });
    this.client = {
      putLogEvents: (logGroupName, logStreamName, events) =>
        sdkClient.send(
          new PutLogEventsCommandCtor({
            logGroupName,
            logStreamName,
            logEvents: events,
          }),
        ),
    };
    return this.client;
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const events = batch
      .map((record) => ({
        timestamp: Date.parse(record.timestamp),
        message: this.format(record),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    await client.putLogEvents(this.logGroupName, this.logStreamName, events);
  }
}
