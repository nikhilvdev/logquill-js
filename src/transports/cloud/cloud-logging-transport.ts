import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import { Level, parseLevel } from "../../core/levels.js";
import type { LogRecord } from "../../core/records.js";

/** One GCP Cloud Logging entry, shaped for `Log#write`. */
export interface CloudLoggingEntry {
  /** Cloud Logging `LogSeverity` value, mapped from the record's level. */
  severity: string;
  /** ISO8601 timestamp. */
  timestamp: string;
  /** The record, JSON-decoded, as Cloud Logging's structured payload. */
  jsonPayload: Record<string, unknown>;
}

/**
 * The subset of the `@google-cloud/logging` client that `CloudLoggingTransport`
 * needs. Deliberately narrower than the SDK's full `Log`/`Entry` object model —
 * `importClient()` builds the real adapter around `logging.log(name).write(entries)`.
 */
export interface CloudLoggingClientLike {
  /** Writes one batch of entries to the configured log. */
  writeLogEntries(entries: readonly CloudLoggingEntry[]): Promise<unknown>;
}

/** Options for {@link CloudLoggingTransport}. */
export interface CloudLoggingTransportOptions extends BatchingTransportOptions {
  /** GCP log name (the last segment of the log resource path). Default `"logquill"`. */
  logName?: string;
  /** GCP project ID. Passed to the real SDK client; ignored when `client` is injected — omit to use Application Default Credentials' project. */
  projectId?: string;
  /** Pre-built client, e.g. for tests. Skips the `@google-cloud/logging` auto-import entirely. */
  client?: CloudLoggingClientLike;
}

interface GCPLogLike {
  write(entries: readonly CloudLoggingEntry[]): Promise<unknown>;
}

interface GCPLoggingLike {
  log(name: string): GCPLogLike;
}

/** Maps LogQuill's level names onto Cloud Logging's `LogSeverity` enum values. */
function gcpSeverity(levelValue: string): string {
  const level = parseLevel(levelValue);
  switch (level) {
    case Level.TRACE:
    case Level.DEBUG:
      return "DEBUG";
    case Level.INFO:
      return "INFO";
    case Level.WARN:
      return "WARNING";
    case Level.ERROR:
      return "ERROR";
    case Level.FATAL:
      return "CRITICAL";
  }
}

/**
 * Ships batched records to Google Cloud Logging via `@google-cloud/logging`.
 * Each record becomes one structured entry (`jsonPayload`), with `level`
 * mapped onto Cloud Logging's `severity` enum.
 *
 * `@google-cloud/logging` is an optional peer dependency: install it
 * yourself, or inject a `client` (e.g. a fake, or an already-configured
 * `Log` wrapped to match `CloudLoggingClientLike`).
 */
export class CloudLoggingTransport extends BatchingTransport {
  /** GCP log name (the last segment of the log resource path). */
  readonly logName: string;
  /** GCP project ID passed to the real SDK client; `undefined` when `client` is injected or Application Default Credentials' project is used. */
  readonly projectId: string | undefined;
  private readonly injectedClient: CloudLoggingClientLike | undefined;
  private client: CloudLoggingClientLike | undefined;

  constructor(options: CloudLoggingTransportOptions = {}) {
    super(options);
    this.logName = options.logName ?? "logquill";
    this.projectId = options.projectId;
    this.injectedClient = options.client;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): CloudLoggingClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<CloudLoggingClientLike> {
    let LoggingCtor: new (options?: { projectId?: string | undefined }) => GCPLoggingLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "@google-cloud/logging";
      const mod = (await import(moduleName)) as unknown as {
        Logging: new (options?: { projectId?: string | undefined }) => GCPLoggingLike;
      };
      LoggingCtor = mod.Logging;
    } catch {
      throw new Error(
        "CloudLoggingTransport: install `@google-cloud/logging` to use this transport without providing a client — `npm install @google-cloud/logging`",
      );
    }

    const logging = new LoggingCtor({ projectId: this.projectId });
    const log = logging.log(this.logName);
    this.client = {
      writeLogEntries: (entries) => log.write(entries),
    };
    return this.client;
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const entries = batch.map((record) => ({
      severity: gcpSeverity(record.level),
      timestamp: record.timestamp,
      jsonPayload: JSON.parse(this.format(record)) as Record<string, unknown>,
    }));
    await client.writeLogEntries(entries);
  }
}
