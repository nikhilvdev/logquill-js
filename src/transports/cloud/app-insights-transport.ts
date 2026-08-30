import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import { Level, parseLevel } from "../../core/levels.js";
import type { LogRecord } from "../../core/records.js";

/** One Application Insights trace: a message plus its `SeverityLevel`. */
export interface AppInsightsTrace {
  message: string;
  severity: number;
}

/**
 * The subset of Application Insights telemetry that `AppInsightsTransport`
 * needs.
 *
 * `trackTraceBatch` is LogQuill's own batching contract, not a native
 * `applicationinsights` SDK method — the real SDK only exposes a single-record
 * `trackTrace()` plus an async `flush()`. The real-client adapter built by
 * `importClient()` loops `trackTrace()` calls inside `trackTraceBatch` and
 * flushes once at the end, so batching happens at the LogQuill buffering
 * level (bounded by `maxRecords`/`maxBytes`), not as a real network-level
 * batch call — Application Insights doesn't offer one.
 */
export interface AppInsightsClientLike {
  trackTraceBatch(traces: readonly AppInsightsTrace[]): Promise<unknown>;
}

export interface AppInsightsTransportOptions extends BatchingTransportOptions {
  /** Azure Application Insights connection string. Passed to the real SDK client; ignored when `client` is injected. */
  connectionString?: string;
  /** Pre-built client, e.g. for tests. Skips the `applicationinsights` auto-import entirely. */
  client?: AppInsightsClientLike;
}

interface AzureTelemetryClientLike {
  trackTrace(telemetry: AppInsightsTrace): void;
  flush(): void;
}

/** Maps LogQuill's level names onto Application Insights' `SeverityLevel` enum values. */
function appInsightsSeverity(levelValue: string): number {
  const level = parseLevel(levelValue);
  switch (level) {
    case Level.TRACE:
    case Level.DEBUG:
      return 0; // Verbose
    case Level.INFO:
      return 1; // Information
    case Level.WARN:
      return 2; // Warning
    case Level.ERROR:
      return 3; // Error
    case Level.FATAL:
      return 4; // Critical
  }
}

/**
 * Ships batched records to Azure Application Insights via `applicationinsights`,
 * as trace telemetry with `level` mapped onto Application Insights' severity
 * scale. See `AppInsightsClientLike` for why "batch" means LogQuill-side
 * buffering plus a loop of single `trackTrace()` calls, not one network batch
 * request — the underlying SDK has no batch-track API.
 *
 * `applicationinsights` is an optional peer dependency: install it yourself,
 * or inject a `client` (e.g. a fake, or an already-configured `TelemetryClient`
 * wrapped to match `AppInsightsClientLike`).
 */
export class AppInsightsTransport extends BatchingTransport {
  readonly connectionString: string | undefined;
  private readonly injectedClient: AppInsightsClientLike | undefined;
  private client: AppInsightsClientLike | undefined;

  constructor(options: AppInsightsTransportOptions = {}) {
    super(options);
    this.connectionString = options.connectionString;
    this.injectedClient = options.client;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): AppInsightsClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<AppInsightsClientLike> {
    let TelemetryClientCtor: new (connectionString?: string) => AzureTelemetryClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "applicationinsights";
      const mod = (await import(moduleName)) as unknown as {
        TelemetryClient: new (connectionString?: string) => AzureTelemetryClientLike;
      };
      TelemetryClientCtor = mod.TelemetryClient;
    } catch {
      throw new Error(
        "AppInsightsTransport: install `applicationinsights` to use this transport without providing a client — `npm install applicationinsights`",
      );
    }

    const telemetryClient = new TelemetryClientCtor(this.connectionString);
    this.client = {
      trackTraceBatch: (traces) => {
        for (const trace of traces) {
          telemetryClient.trackTrace(trace);
        }
        telemetryClient.flush();
        return Promise.resolve();
      },
    };
    return this.client;
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const traces = batch.map((record) => ({
      message: this.format(record),
      severity: appInsightsSeverity(record.level),
    }));
    await client.trackTraceBatch(traces);
  }
}
