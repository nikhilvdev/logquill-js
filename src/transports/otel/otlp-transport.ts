import type { Formatter } from "../../core/formatter.js";
import type { LogRecord } from "../../core/records.js";
import { spanIdFor, traceIdFor, traceIdFromParent } from "../../otel/ids.js";
import {
  captureContentEnabled,
  epochHr,
  hrMinusMs,
  isLlmRecord,
  isSpanRecord,
  isToolRecord,
  llmSpec,
  resolveConvention,
  spanSpec,
  toolSpec,
  UNKNOWN_PROVIDER,
  type AttributeValue,
  type Convention,
  type HrTime,
  type SpanSpec,
} from "../../otel/semconv.js";
import { Transport } from "../transport.js";
import { loadOtel } from "./load.js";

// Just the parts of the OpenTelemetry API this transport touches, so the public
// types don't depend on packages a consumer may not have installed.
interface SpanLike {
  addEvent(name: string, attributes: Record<string, AttributeValue>, time: HrTime): void;
  setStatus(status: { code: number; message?: string }): void;
  end(time: HrTime): void;
}
interface TracerLike {
  startSpan(
    name: string,
    options: { kind: number; attributes: Record<string, AttributeValue>; startTime: HrTime },
    context: unknown,
  ): SpanLike;
}
interface ProviderLike {
  getTracer(name: string): TracerLike;
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
  SpanKind: { CLIENT: number; INTERNAL: number };
  SpanStatusCode: { ERROR: number };
}
interface TraceSdk {
  // `BasicTracerProvider` in `sdk-trace-base` 2.x; the same class is named `TracerProvider` in `sdk-trace` 3.x.
  BasicTracerProvider?: TracerProviderConstructor;
  TracerProvider?: TracerProviderConstructor;
  BatchSpanProcessor: new (exporter: unknown) => unknown;
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
  RandomIdGenerator: new () => { generateTraceId(): string; generateSpanId(): string };
}
type TracerProviderConstructor = new (config: {
  resource: unknown;
  idGenerator: { generateTraceId(): string; generateSpanId(): string };
  spanProcessors: unknown[];
}) => ProviderLike;

/**
 * Loads the tracing SDK. `@opentelemetry/sdk-trace-base` (the 2.x line) first, then
 * `@opentelemetry/sdk-trace` (the package the 3.x line ships it in), so either works.
 */
function loadTraceSdk(): {
  sdk: TraceSdk;
  Provider: TracerProviderConstructor;
  fromSdkTrace: boolean;
} {
  let sdk: TraceSdk;
  let fromSdkTrace = false;
  try {
    sdk = loadOtel("OTLPTransport", "@opentelemetry/sdk-trace-base") as TraceSdk;
  } catch (baseError) {
    try {
      sdk = loadOtel("OTLPTransport", "@opentelemetry/sdk-trace") as TraceSdk;
      fromSdkTrace = true;
    } catch {
      throw baseError; // names @opentelemetry/sdk-trace-base and how to install it
    }
  }
  const Provider = sdk.BasicTracerProvider ?? sdk.TracerProvider;
  if (!Provider) {
    throw new Error(
      "OTLPTransport: the installed OpenTelemetry tracing SDK has neither BasicTracerProvider nor TracerProvider — install @opentelemetry/sdk-trace-base 2.x or @opentelemetry/sdk-trace 3.x",
    );
  }
  return { sdk, Provider, fromSdkTrace };
}

/**
 * Builds a span processor. `sdk-trace-base` (2.x) takes the exporter directly; `sdk-trace`
 * 3.x takes `{ exporter }`. If the options form was not understood (a stray `sdk-trace`
 * 2.x, which stores the object it was given as the exporter), fall back to the bare form.
 */
function makeProcessor(
  Processor: new (arg: unknown) => unknown,
  exporter: unknown,
  fromSdkTrace: boolean,
): unknown {
  if (!fromSdkTrace) return new Processor(exporter);
  const processor = new Processor({ exporter });
  return (processor as { _exporter?: unknown })._exporter === exporter
    ? processor
    : new Processor(exporter);
}

interface ResourcesModule {
  resourceFromAttributes: (attributes: Record<string, string>) => unknown;
}
type ExporterModule<Name extends string> = Record<
  Name,
  new (config: Record<string, unknown>) => unknown
>;

/** Options for {@link OTLPTransport}. */
export interface OTLPTransportOptions {
  /** OTLP/HTTP traces URL. Default: the SDK's own (the `OTEL_EXPORTER_OTLP_*` environment variables, else localhost). */
  endpoint?: string;
  /** Headers sent with each export, e.g. an API key. */
  headers?: Record<string, string>;
  /** `service.name` on the exported resource. Default `"logquill"`. */
  serviceName?: string;
  /** Replaces the OTLP exporter with any OpenTelemetry `SpanExporter`: for tests, or a different protocol. */
  spanExporter?: unknown;
  /** `"batch"` (default) exports in the background; `"simple"` exports each span immediately. */
  processor?: "batch" | "simple";
  /** `"latest"` or `"legacy"` GenAI attribute names. Unset, follows `OTEL_SEMCONV_STABILITY_OPT_IN`. */
  semconvVersion?: "latest" | "legacy";
  /** `gen_ai.provider.name` for records without `meta.provider`. Default `"unknown"`. */
  defaultProvider?: string;
  /** Export prompt and completion text. Default: the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` environment variable, else off. */
  captureContent?: boolean;
  /** Export timeout in milliseconds for the default OTLP exporter. Default 10000. */
  timeoutMs?: number;
  /** Unused here (spans are built from the record's structure), accepted for symmetry with other transports. */
  formatter?: Formatter;
}

/**
 * Exports LogQuill's agent tracing as real OpenTelemetry spans.
 *
 * A log line and a span are different things, so this doesn't format text: it
 * reads each record's structure and, for the records that describe work with a
 * beginning and an end, creates an OpenTelemetry span through the SDK, so it goes
 * through the usual processors and exporters to any OTLP collector (Jaeger,
 * Tempo, Honeycomb, Datadog, Grafana, ...):
 *
 * - a `Logger.span()` block becomes a span. One that marks itself as an agent
 *   run (`logger.span("run", fn, { operation: "invoke_agent", agent_name: "planner" })`)
 *   is `invoke_agent planner`; any other keeps its own name.
 * - an `.action()` naming its tool in `meta.tool` becomes `execute_tool {tool}`.
 * - a record with an `llm` block (`Logger.llmCall()`) becomes `chat {model}`
 *   with the model, token counts and finish reason as the standard GenAI
 *   attributes.
 *
 * Every other record is ignored here; send those to a collector too with
 * `OTelLogsTransport`. The span's real ids, start and end are taken from the
 * record (`span_id`, `parent_span_id`, `duration_ms`, the timestamp), so the tree
 * a collector shows is exactly the tree that was logged. Spans of one run share a
 * trace when the records carry a `run_id` or `trace_id`.
 *
 * Attribute names come from `semconv`, pinned to one release of the (still
 * experimental) GenAI conventions. Prompt and completion text is never exported
 * unless you turn on `captureContent`.
 *
 * Needs the optional OpenTelemetry packages
 * (`npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http`),
 * loaded when the transport is constructed. Export is batched and happens off the
 * caller's path; `flush()` and `close()` send what's pending.
 */
export class OTLPTransport extends Transport {
  private readonly api: OtelApi;
  private readonly provider: ProviderLike;
  private readonly tracer: TracerLike;
  private readonly convention: Convention;
  private readonly defaultProvider: string;
  private readonly captureContent: boolean;
  // The ids the record being exported names, read by the id generator below
  // while `startSpan` runs. Synchronous, so a plain field is safe in a single thread.
  private pending: { traceId?: string | undefined; spanId?: string | undefined } = {};

  constructor(options: OTLPTransportOptions = {}) {
    super(options.formatter);
    const processorKind: string = options.processor ?? "batch";
    if (processorKind !== "batch" && processorKind !== "simple") {
      throw new Error(
        `OTLPTransport: processor must be 'batch' or 'simple', got ${JSON.stringify(processorKind)}`,
      );
    }
    this.api = loadOtel("OTLPTransport", "@opentelemetry/api") as OtelApi;
    const { sdk, Provider, fromSdkTrace } = loadTraceSdk();
    const { resourceFromAttributes } = loadOtel(
      "OTLPTransport",
      "@opentelemetry/resources",
    ) as ResourcesModule;

    this.convention = resolveConvention(options.semconvVersion);
    this.defaultProvider = options.defaultProvider ?? UNKNOWN_PROVIDER;
    this.captureContent = options.captureContent ?? captureContentEnabled();

    let exporter = options.spanExporter;
    if (exporter === undefined) {
      const { OTLPTraceExporter } = loadOtel(
        "OTLPTransport",
        "@opentelemetry/exporter-trace-otlp-http",
      ) as ExporterModule<"OTLPTraceExporter">;
      exporter = new OTLPTraceExporter({
        ...(options.endpoint === undefined ? {} : { url: options.endpoint }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        timeoutMillis: options.timeoutMs ?? 10_000,
      });
    }

    const random = new sdk.RandomIdGenerator();
    this.provider = new Provider({
      resource: resourceFromAttributes({ "service.name": options.serviceName ?? "logquill" }),
      idGenerator: {
        generateTraceId: () => this.pending.traceId ?? random.generateTraceId(),
        generateSpanId: () => this.pending.spanId ?? random.generateSpanId(),
      },
      spanProcessors: [
        makeProcessor(
          processorKind === "batch" ? sdk.BatchSpanProcessor : sdk.SimpleSpanProcessor,
          exporter,
          fromSdkTrace,
        ),
      ],
    });
    this.tracer = this.provider.getTracer("logquill");
  }

  private specFor(record: LogRecord): SpanSpec | undefined {
    if (isLlmRecord(record)) {
      return llmSpec(record, this.convention, {
        defaultProvider: this.defaultProvider,
        captureContent: this.captureContent,
      });
    }
    if (isToolRecord(record)) return toolSpec(record, this.convention);
    if (isSpanRecord(record)) {
      return spanSpec(record, this.convention, { defaultProvider: this.defaultProvider });
    }
    return undefined;
  }

  /** Creates and ends the span this record describes, if it describes one (see the class doc); ignores the record otherwise. */
  write(_formatted: string, record: LogRecord): void {
    const spec = this.specFor(record);
    if (!spec) return;

    const { api } = this;
    const { meta } = record;
    const endTime = epochHr(record.timestamp);
    const startTime = spec.durationMs ? hrMinusMs(endTime, spec.durationMs) : endTime;

    const own = meta.span_id;
    const parent = meta.parent_span_id;
    let traceId = traceIdFor(meta);
    // An explicit root, never whatever span the host application happens to have active.
    let parentContext = api.ROOT_CONTEXT;
    if (typeof parent === "string" && parent !== "") {
      traceId ??= traceIdFromParent(parent);
      parentContext = api.trace.setSpan(
        api.ROOT_CONTEXT,
        api.trace.wrapSpanContext({
          traceId,
          spanId: spanIdFor(parent),
          traceFlags: api.TraceFlags.SAMPLED,
          isRemote: true,
        }),
      );
    }

    this.pending = {
      traceId,
      spanId: typeof own === "string" && own !== "" ? spanIdFor(own) : undefined,
    };
    let span: SpanLike;
    try {
      span = this.tracer.startSpan(
        spec.name,
        {
          kind: spec.kind === "client" ? api.SpanKind.CLIENT : api.SpanKind.INTERNAL,
          attributes: spec.attributes,
          startTime,
        },
        parentContext,
      );
    } finally {
      this.pending = {};
    }
    for (const [name, attributes] of spec.events) span.addEvent(name, attributes, endTime);
    if (spec.isError) {
      const description = meta.error;
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        ...(typeof description === "string" ? { message: description } : {}),
      });
    }
    span.end(endTime);
  }

  /** Exports every span still waiting in the batch processor. */
  flush(): Promise<void> {
    return this.provider.forceFlush();
  }

  /** Starts flushing and shuts the exporter down. Call `flush()` first (or use `installShutdownHandlers`) when the process is about to exit. */
  override close(): void {
    this.provider.shutdown().catch((error: unknown) => {
      console.error("OTLPTransport: failed to shut down cleanly", error);
    });
  }
}
