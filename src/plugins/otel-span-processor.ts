import type { Logger } from "../core/logger.js";

/** The subset of an OTel `SpanContext` this processor reads. */
export interface OtelSpanContextLike {
  /** 16-hex-char span id. */
  spanId: string;
}

/** The subset of an OTel `SpanStatus` this processor reads. */
export interface OtelStatusLike {
  /** Numeric status code — compared against OTel's `SpanStatusCode.ERROR` (`2`). */
  code: number;
  /** Present when the span ended with an error status; used as the `.error()` message. */
  message?: string;
}

/**
 * The subset of an OTel `Span`/`ReadableSpan`'s shape this processor reads,
 * duck-typed so this package never declares a real dependency on
 * `@opentelemetry/api`/`@opentelemetry/sdk-trace-base` — the same approach
 * `TraceContextPlugin` uses for its own OTel lookup. Matches what any
 * standard `@opentelemetry/sdk-trace-base`-backed tracer provider actually
 * passes to a registered `SpanProcessor`.
 */
export interface OtelSpanLike {
  /** Span name — becomes the `.action()`/`.observation()`/`.error()` message. */
  name: string;
  /** Returns this span's own id (and trace id), matching an OTel `Span`'s `spanContext()`. */
  spanContext(): OtelSpanContextLike;
  /** Present on `@opentelemetry/sdk-trace-base` >=1.9's `Span`. */
  parentSpanContext?: OtelSpanContextLike;
  /** Pre-1.9 `@opentelemetry/sdk-trace-base` shape (superseded by `parentSpanContext`) — read as a fallback when that isn't present. */
  parentSpanId?: string;
  /** Span attributes, copied verbatim onto `meta[attributesKey]` when non-empty. */
  attributes: Record<string, unknown>;
  /** This span's OTel status — an error status routes the end record through `.error()` instead of `.observation()`. */
  status: OtelStatusLike;
  /** Wall-clock duration as an OTel `HrTime` tuple, only meaningful once the span has ended. */
  duration: readonly [seconds: number, nanoseconds: number];
}

/** OTel's `SpanStatusCode.ERROR`, duck-typed to avoid a real dependency on `@opentelemetry/api`. */
const OTEL_STATUS_CODE_ERROR = 2;

/** Options for {@link OtelSpanProcessor}. */
export interface OtelSpanProcessorOptions {
  /** `meta` key non-empty span attributes are copied onto. Default `"attributes"`. */
  attributesKey?: string;
}

/**
 * Bridges an OpenTelemetry-native integration — the Vercel AI SDK's
 * `experimental_telemetry` is the main JS example — into LogQuill without
 * forcing it through the callback-handler-object model `LangChainAdapter`
 * uses. Register an instance the same way any other span processor is
 * registered:
 *
 * ```ts
 * import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
 * import { OtelSpanProcessor } from "logquill";
 *
 * const provider = new BasicTracerProvider();
 * provider.addSpanProcessor(new OtelSpanProcessor(log.child("agent")));
 * ```
 *
 * Every span the SDK creates becomes one `.action()` call on start and one
 * `.observation()` (or `.error()`, if the span ended with an error status)
 * call on end — the same two-call shape `LangChainAdapter` uses for
 * `handleToolStart`/`handleToolEnd`. Both carry the span's own `spanId`/
 * `parentSpanId` — OTel span ids are already the same 16-hex-char shape
 * LogQuill's own `spanId` uses, so no translation is needed — and the end
 * call additionally carries `meta.durationMs`. Non-empty span attributes are
 * copied onto `meta[attributesKey]` verbatim, unrenamed — mapping onto the
 * OTel `gen_ai.*` semantic conventions is deliberately out of scope here
 * (see the v2.0 `OTLPTransport`/`gen_ai.*` plan).
 *
 * Never imports `@opentelemetry/api` or `@opentelemetry/sdk-trace-base` —
 * duck-typed against the shape a `Span`/`ReadableSpan` actually has, so
 * `import { Logger } from "logquill"` still never requires either package
 * to be installed.
 */
export class OtelSpanProcessor {
  private readonly log: Logger;
  private readonly attributesKey: string;

  constructor(log: Logger, options: OtelSpanProcessorOptions = {}) {
    this.log = log;
    this.attributesKey = options.attributesKey ?? "attributes";
  }

  /** Called by the tracer provider when a span starts — emits `.action()`. */
  onStart(span: OtelSpanLike): void {
    this.log.action(span.name, this.baseMeta(span));
  }

  /** Called by the tracer provider when a span ends — emits `.observation()`, or `.error()` if the span's status is an error. */
  onEnd(span: OtelSpanLike): void {
    const meta = {
      ...this.baseMeta(span),
      durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
    };
    if (span.status.code === OTEL_STATUS_CODE_ERROR) {
      this.log.error(span.name, {
        ...meta,
        error: span.status.message ?? "span ended with an error status",
      });
      return;
    }
    this.log.observation(span.name, meta);
  }

  /** No internal buffering to flush — every span is forwarded to the `Logger` immediately. */
  async forceFlush(): Promise<void> {}

  /** No resources of its own to release; flush/close the wrapped `Logger` separately. */
  async shutdown(): Promise<void> {}

  private baseMeta(span: OtelSpanLike): Record<string, unknown> {
    const meta: Record<string, unknown> = { spanId: span.spanContext().spanId };
    const parentSpanId = span.parentSpanContext?.spanId ?? span.parentSpanId;
    if (parentSpanId) {
      meta.parentSpanId = parentSpanId;
    }
    if (Object.keys(span.attributes).length > 0) {
      meta[this.attributesKey] = span.attributes;
    }
    return meta;
  }
}
