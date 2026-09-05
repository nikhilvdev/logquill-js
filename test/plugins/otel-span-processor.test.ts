import { context as otelContext, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { CollectingTransport, Logger, OtelSpanProcessor } from "../../src/index.js";

async function withTracer(
  processor: OtelSpanProcessor,
  fn: (tracer: ReturnType<BasicTracerProvider["getTracer"]>) => void,
) {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("test");
  fn(tracer);
  await provider.shutdown();
}

describe("OtelSpanProcessor", () => {
  it("emits an .action() on span start and an .observation() on span end", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    await withTracer(processor, (tracer) => {
      const span = tracer.startSpan("callLlm");
      span.end();
    });
    await logger.flush();

    expect(transport.records).toHaveLength(2);
    expect(transport.records[0]?.message).toBe("callLlm");
    expect(transport.records[0]?.meta.kind).toBe("action");
    expect(transport.records[1]?.message).toBe("callLlm");
    expect(transport.records[1]?.meta.kind).toBe("observation");
    expect(typeof transport.records[1]?.meta.durationMs).toBe("number");
  });

  it("carries the span's own spanId onto both records", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    let spanId = "";
    await withTracer(processor, (tracer) => {
      const span = tracer.startSpan("tool");
      spanId = span.spanContext().spanId;
      span.end();
    });
    await logger.flush();

    expect(transport.records[0]?.meta.spanId).toBe(spanId);
    expect(transport.records[1]?.meta.spanId).toBe(spanId);
  });

  it("stamps parentSpanId from an explicitly nested span", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    let parentId = "";
    let childId = "";
    await withTracer(processor, (tracer) => {
      const parent = tracer.startSpan("parent");
      parentId = parent.spanContext().spanId;
      const parentContext = trace.setSpan(otelContext.active(), parent);
      const child = tracer.startSpan("child", undefined, parentContext);
      childId = child.spanContext().spanId;
      child.end();
      parent.end();
    });
    await logger.flush();

    const childStart = transport.records.find(
      (r) => r.message === "child" && r.meta.kind === "action",
    );
    expect(childStart?.meta.spanId).toBe(childId);
    expect(childStart?.meta.parentSpanId).toBe(parentId);

    const parentStart = transport.records.find(
      (r) => r.message === "parent" && r.meta.kind === "action",
    );
    expect(parentStart?.meta.parentSpanId).toBeUndefined();
  });

  it("emits .error() instead of .observation() when the span ends with an error status", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    await withTracer(processor, (tracer) => {
      const span = tracer.startSpan("failingTool");
      span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
      span.end();
    });
    await logger.flush();

    const endRecord = transport.records[1];
    expect(endRecord?.level).toBe("ERROR");
    expect(endRecord?.meta.kind).toBeUndefined();
    expect(endRecord?.meta.error).toBe("boom");
  });

  it("copies non-empty span attributes onto meta.attributes", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    await withTracer(processor, (tracer) => {
      const span = tracer.startSpan("withAttrs", {
        attributes: { "gen_ai.request.model": "gpt-5" },
      });
      span.end();
    });
    await logger.flush();

    expect(transport.records[0]?.meta.attributes).toEqual({ "gen_ai.request.model": "gpt-5" });
  });

  it("omits meta.attributes entirely when a span has none", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger);

    await withTracer(processor, (tracer) => {
      tracer.startSpan("bare").end();
    });
    await logger.flush();

    expect(transport.records[0]?.meta.attributes).toBeUndefined();
  });

  it("supports a custom attributesKey", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const processor = new OtelSpanProcessor(logger, { attributesKey: "otelAttrs" });

    await withTracer(processor, (tracer) => {
      tracer.startSpan("withAttrs", { attributes: { foo: "bar" } }).end();
    });
    await logger.flush();

    expect(transport.records[0]?.meta.otelAttrs).toEqual({ foo: "bar" });
    expect(transport.records[0]?.meta.attributes).toBeUndefined();
  });

  it("forceFlush() and shutdown() resolve without doing anything to the wrapped Logger", async () => {
    const logger = new Logger("app.test");
    const processor = new OtelSpanProcessor(logger);

    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
