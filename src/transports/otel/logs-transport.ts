import type { Formatter } from "../../core/formatter.js";
import type { LogRecord } from "../../core/records.js";
import { spanIdFor, traceIdFor, traceIdFromParent } from "../../otel/ids.js";
import {
  epochHr,
  logAttributes,
  resolveConvention,
  type AttributeValue,
  type Convention,
} from "../../otel/semconv.js";
import { Transport } from "../transport.js";
import { loadOtel } from "./load.js";

interface LogEmitter {
  emit(record: {
    timestamp: [number, number];
    observedTimestamp: [number, number];
    severityNumber: number;
    severityText: string;
    body: string;
    attributes: Record<string, AttributeValue>;
    context?: unknown;
  }): void;
}
interface LogProviderLike {
  getLogger(name: string): LogEmitter;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
interface OtelApi {
  ROOT_CONTEXT: unknown;
  trace: {
    setSpan(context: unknown, span: unknown): unknown;
    wrapSpanContext(spanContext: {
      traceId: string;
      spanId: string;
      traceFlags: number;
      isRemote: boolean;
    }): unknown;
  };
  TraceFlags: { SAMPLED: number };
}
interface LogsSdk {
  LoggerProvider: new (config: { resource: unknown; processors: unknown[] }) => LogProviderLike;
  BatchLogRecordProcessor: new (options: { exporter: unknown }) => unknown;
  SimpleLogRecordProcessor: new (options: { exporter: unknown }) => unknown;
}

interface ResourcesModule {
  resourceFromAttributes: (attributes: Record<string, string>) => unknown;
}
type ExporterModule<Name extends string> = Record<
  Name,
  new (config: Record<string, unknown>) => unknown
>;

/** Options for {@link OTelLogsTransport}. */
export interface OTelLogsTransportOptions {
  /** OTLP/HTTP logs URL. Default: the SDK's own (the `OTEL_EXPORTER_OTLP_*` environment variables, else localhost). */
  endpoint?: string;
  /** Headers sent with each export, e.g. an API key. */
  headers?: Record<string, string>;
  /** `service.name` on the exported resource. Default `"logquill"`. */
  serviceName?: string;
  /** Replaces the OTLP exporter with any OpenTelemetry log record exporter. */
  logExporter?: unknown;
  /** `"batch"` (default) exports in the background; `"simple"` exports each record immediately. */
  processor?: "batch" | "simple";
  /** `"latest"` or `"legacy"` GenAI attribute names. Unset, follows `OTEL_SEMCONV_STABILITY_OPT_IN`. */
  semconvVersion?: "latest" | "legacy";
  /** Export timeout in milliseconds for the default OTLP exporter. Default 10000. */
  timeoutMs?: number;
  /** Unused here (the body is the record's message), accepted for symmetry with other transports. */
  formatter?: Formatter;
}

// OpenTelemetry severity numbers: the first of each range.
const SEVERITY_NUMBER: Readonly<Record<string, number>> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

/**
 * An OpenTelemetry attribute value: scalars and homogeneous arrays of them pass
 * through; anything else (a nested object, a mixed array, an object) becomes a
 * JSON string, since attributes can't hold structure.
 */
function attributeValue(value: unknown): AttributeValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const kind = typeof value[0];
    if (
      (kind === "string" || kind === "boolean" || kind === "number") &&
      value.every((item) => typeof item === kind)
    ) {
      return value as string[];
    }
  }
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

/**
 * Sends every LogQuill record to an OpenTelemetry collector as an OTLP *log
 * record*, without going through the span path: for a backend that takes logs,
 * or to ship the records `OTLPTransport` doesn't turn into spans.
 *
 * The message is the body, the level maps to OTLP severity, and `meta` becomes
 * attributes (nested values as JSON strings; a stack in `meta.stack` goes to
 * `exception.stacktrace`). A log line carries the trace and span ids of the span it
 * belongs to, the same ids `OTLPTransport` gives that span, so a collector can join
 * the two: the record `span()` writes belongs to its own span, and any other record
 * to the span it was logged inside (its `parent_span_id`). (OpenTelemetry only
 * attaches ids to a log record when both are known; a record logged outside any
 * span still has `run_id`/`trace_id` as attributes.) An `llm` block adds the standard model and token attributes.
 *
 * Needs the optional OpenTelemetry packages, `@opentelemetry/sdk-logs` 0.220 or newer
 * (earlier releases take the exporter as a bare argument)
 * (`npm install @opentelemetry/api @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http`),
 * loaded when the transport is constructed.
 */
export class OTelLogsTransport extends Transport {
  private readonly api: OtelApi;
  private readonly provider: LogProviderLike;
  private readonly emitter: LogEmitter;
  private readonly convention: Convention;

  constructor(options: OTelLogsTransportOptions = {}) {
    super(options.formatter);
    const processorKind: string = options.processor ?? "batch";
    if (processorKind !== "batch" && processorKind !== "simple") {
      throw new Error(
        `OTelLogsTransport: processor must be 'batch' or 'simple', got ${JSON.stringify(processorKind)}`,
      );
    }
    this.api = loadOtel("OTelLogsTransport", "@opentelemetry/api") as OtelApi;
    const sdk = loadOtel("OTelLogsTransport", "@opentelemetry/sdk-logs") as LogsSdk;
    const { resourceFromAttributes } = loadOtel(
      "OTelLogsTransport",
      "@opentelemetry/resources",
    ) as ResourcesModule;

    let exporter = options.logExporter;
    if (exporter === undefined) {
      const { OTLPLogExporter } = loadOtel(
        "OTelLogsTransport",
        "@opentelemetry/exporter-logs-otlp-http",
      ) as ExporterModule<"OTLPLogExporter">;
      exporter = new OTLPLogExporter({
        ...(options.endpoint === undefined ? {} : { url: options.endpoint }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        timeoutMillis: options.timeoutMs ?? 10_000,
      });
    }

    this.convention = resolveConvention(options.semconvVersion);
    this.provider = new sdk.LoggerProvider({
      resource: resourceFromAttributes({ "service.name": options.serviceName ?? "logquill" }),
      processors: [
        processorKind === "batch"
          ? new sdk.BatchLogRecordProcessor({ exporter })
          : new sdk.SimpleLogRecordProcessor({ exporter }),
      ],
    });
    this.emitter = this.provider.getLogger("logquill");
  }

  /** Emits `record` as an OTLP log record. */
  write(_formatted: string, record: LogRecord): void {
    const { meta } = record;
    const attributes: Record<string, AttributeValue> = {};
    for (const [key, value] of Object.entries(meta)) {
      if (value === null || value === undefined) continue;
      attributes[key === "stack" ? "exception.stacktrace" : key] = attributeValue(value);
    }
    attributes["logquill.logger"] = record.logger;
    attributes["logquill.schema_version"] = record.schema_version;
    Object.assign(attributes, logAttributes(record, this.convention));

    // The span this line belongs to: its own if it is a span record, otherwise the span it
    // was logged inside, which is what an OpenTelemetry log's span id means.
    const own = meta.span_id;
    const parent = meta.parent_span_id;
    const owner =
      typeof own === "string" && own !== ""
        ? own
        : typeof parent === "string" && parent !== ""
          ? parent
          : undefined;
    const traceId =
      traceIdFor(meta) ??
      (typeof parent === "string" && parent !== "" ? traceIdFromParent(parent) : undefined);
    const time = epochHr(record.timestamp);
    const { api } = this;
    this.emitter.emit({
      timestamp: time,
      observedTimestamp: time,
      severityNumber: SEVERITY_NUMBER[record.level] ?? 0,
      severityText: record.level,
      body: record.message,
      attributes,
      ...(traceId !== undefined && owner !== undefined
        ? {
            context: api.trace.setSpan(
              api.ROOT_CONTEXT,
              api.trace.wrapSpanContext({
                traceId,
                spanId: spanIdFor(owner),
                traceFlags: api.TraceFlags.SAMPLED,
                isRemote: false,
              }),
            ),
          }
        : {}),
    });
  }

  /** Exports every log record still waiting in the batch processor. */
  flush(): Promise<void> {
    return this.provider.forceFlush();
  }

  /** Starts flushing and shuts the exporter down. Call `flush()` first (or use `installShutdownHandlers`) when the process is about to exit. */
  override close(): void {
    this.provider.shutdown().catch((error: unknown) => {
      console.error("OTelLogsTransport: failed to shut down cleanly", error);
    });
  }
}
