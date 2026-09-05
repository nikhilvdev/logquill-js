import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

const traceparentStore = new AsyncLocalStorage<string | undefined>();

/**
 * Sets the inbound trace header for the current execution context (e.g.
 * request-scoped HTTP middleware, before the handler runs) — the
 * propagation mechanism framework middleware uses to hand `TraceContextPlugin`
 * an inbound header without threading it through every log call. Backed by
 * `AsyncLocalStorage`, so it's isolated per concurrent request. Returns a
 * function that restores the previous value; call it (typically in a
 * `finally` block) once the request is done.
 */
export function setTraceparent(value: string | undefined): () => void {
  const previous = traceparentStore.getStore();
  traceparentStore.enterWith(value);
  return () => {
    traceparentStore.enterWith(previous);
  };
}

/** The header most recently set via `setTraceparent()` for this execution context. */
export function getTraceparent(): string | undefined {
  return traceparentStore.getStore();
}

/** A fresh 32-hex-char id, matching the shape of an OTel/W3C trace id. */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

// W3C Trace Context: "{version}-{trace-id}-{parent-id}-{trace-flags}",
// https://www.w3.org/TR/trace-context/#traceparent-header
const W3C_TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
// AWS X-Ray: "Root=1-{8 hex}-{24 hex}[;Parent=...;Sampled=...]"
const XRAY_ROOT_RE = /Root=1-([0-9a-f]{8})-([0-9a-f]{24})/;
// GCP Cloud Trace: "{32 hex trace id}/{decimal span id}[;o=TRACE_TRUE]"
const GCP_TRACE_RE = /^([0-9a-f]{32})\/\d+(;o=\d)?$/;

/**
 * Extracts a 32-hex-char trace id from a W3C `traceparent`, AWS X-Ray
 * `X-Amzn-Trace-Id`, or GCP `X-Cloud-Trace-Context` header value. Returns
 * `undefined` if `header` doesn't match any of the three shapes.
 */
export function parseTraceHeader(header: string): string | undefined {
  const trimmed = header.trim();

  const w3c = W3C_TRACEPARENT_RE.exec(trimmed);
  if (w3c?.[1]) {
    return w3c[1];
  }

  const xray = XRAY_ROOT_RE.exec(trimmed);
  if (xray?.[1] && xray[2]) {
    return xray[1] + xray[2];
  }

  const gcp = GCP_TRACE_RE.exec(trimmed);
  if (gcp?.[1]) {
    return gcp[1];
  }

  return undefined;
}

interface OtelSpanContextLike {
  traceId: string;
}
interface OtelSpanLike {
  spanContext(): OtelSpanContextLike;
}
interface OtelTraceApiLike {
  getActiveSpan(): OtelSpanLike | undefined;
  isSpanContextValid(spanContext: OtelSpanContextLike): boolean;
}
interface OtelApiLike {
  trace: OtelTraceApiLike;
}

/**
 * Best-effort, synchronous lookup of the active OpenTelemetry span's trace
 * id via a plain `require("@opentelemetry/api")` — `@opentelemetry/api` is
 * never a declared dependency of this package (matching `logquill-python`'s
 * lazy `import opentelemetry`); this returns `undefined` whenever it isn't
 * installed, or no span is currently active, rather than throwing.
 *
 * A `require()` (via `createRequire`) rather than a dynamic `import()` is
 * deliberate: `Plugin.beforeLog` is synchronous, so this has to be too.
 */
export function defaultResolveActiveOtelTraceId(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const otel = require("@opentelemetry/api") as OtelApiLike;
    const span = otel.trace.getActiveSpan();
    if (!span) {
      return undefined;
    }
    const spanContext = span.spanContext();
    if (!otel.trace.isSpanContextValid(spanContext)) {
      return undefined;
    }
    return spanContext.traceId;
  } catch {
    return undefined;
  }
}

/** Options for {@link TraceContextPlugin}. */
export interface TraceContextPluginOptions {
  /** `meta` key the trace id is written to. Default `"traceId"`. */
  traceKey?: string;
  /** An inbound trace header to resolve on every record, bypassing `setTraceparent()`. */
  traceparent?: string;
  /** Override for testing, or to plug in a non-Node OTel API surface. Defaults to `defaultResolveActiveOtelTraceId`. */
  resolveActiveOtelTraceId?: () => string | undefined;
}

/**
 * Stamps `meta.traceId` for cross-service correlation — distinct from
 * `RunPlugin`'s `runId`: `traceId` follows one request across services,
 * `runId` scopes one agent run.
 *
 * A record that already carries `meta[traceKey]` (e.g. because
 * `SamplingPlugin`'s tail-based elevation, or an upstream plugin, already
 * set one) is left alone. Otherwise resolves a trace id in priority order:
 *
 * 1. An active OpenTelemetry span's trace id, if `@opentelemetry/api` is
 *    installed and a span is current — read directly, not just inbound
 *    headers.
 * 2. The `traceparent` constructor option, if given.
 * 3. Whatever `setTraceparent()` most recently set for the current
 *    execution context.
 * 4. A freshly generated trace id, if none of the above produced one.
 *
 * Header parsing understands W3C `traceparent`, AWS X-Ray
 * `X-Amzn-Trace-Id`, and GCP `X-Cloud-Trace-Context` — see
 * `parseTraceHeader`. A header that doesn't parse is treated the same as no
 * header: falls through to generating a new trace id.
 */
export class TraceContextPlugin implements Plugin {
  /** `meta` key the trace id is written to. */
  readonly traceKey: string;
  private readonly explicitTraceparent: string | undefined;
  private readonly resolveActiveOtelTraceId: () => string | undefined;

  constructor(options: TraceContextPluginOptions = {}) {
    this.traceKey = options.traceKey ?? "traceId";
    this.explicitTraceparent = options.traceparent;
    this.resolveActiveOtelTraceId = options.resolveActiveOtelTraceId ?? defaultResolveActiveOtelTraceId;
  }

  beforeLog(record: LogRecord): LogRecord {
    if (record.meta[this.traceKey] != null) {
      return record;
    }
    record.meta[this.traceKey] = this.resolveTraceId();
    return record;
  }

  private resolveTraceId(): string {
    const fromOtel = this.resolveActiveOtelTraceId();
    if (fromOtel) {
      return fromOtel;
    }

    const header = this.explicitTraceparent ?? getTraceparent();
    if (header) {
      const parsed = parseTraceHeader(header);
      if (parsed) {
        return parsed;
      }
    }

    return generateTraceId();
  }
}
