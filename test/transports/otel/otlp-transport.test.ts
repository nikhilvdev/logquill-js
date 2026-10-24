import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  CollectingTransport,
  Logger,
  OTLPTransport,
  RunPlugin,
  type OTLPTransportOptions,
} from "../../../src/index.js";
import { traceIdFor, traceIdFromParent } from "../../../src/otel/ids.js";
import { loadOtel } from "../../../src/transports/otel/load.js";

function setup(
  options: OTLPTransportOptions = {},
  loggerOptions: { contentPolicy?: "full" | "off" } = {},
) {
  const exporter = new InMemorySpanExporter();
  const otlp = new OTLPTransport({ spanExporter: exporter, processor: "simple", ...options });
  const sink = new CollectingTransport();
  const logger = new Logger("agent", {
    transports: [sink, otlp],
    plugins: [new RunPlugin({ runId: "run-1" })],
    contentPolicy: loggerOptions.contentPolicy ?? "off",
  });
  return { exporter, otlp, sink, logger };
}

const byName = (spans: readonly ReadableSpan[], name: string): ReadableSpan => {
  const found = spans.find((span) => span.name === name);
  if (!found) throw new Error(`no span named ${name}; have ${spans.map((s) => s.name).join(", ")}`);
  return found;
};

const hrToMs = (time: [number, number]): number => time[0] * 1000 + time[1] / 1e6;

describe("OTLPTransport", () => {
  it("exports a recorded agent run as the exact span tree, with gen_ai.usage.* attributes", async () => {
    const { exporter, sink, logger } = setup();

    await logger.span(
      "run",
      async () => {
        await logger.span("plan", () => {
          logger.thought("thinking"); // not a span: ignored here
        });
        logger.llmCall({
          model: "gpt-4o",
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.001,
          latencyMs: 40,
          finishReason: "stop",
        });
        logger.action("call the tool", { tool: "search", tool_call_id: "c1", duration_ms: 3 });
      },
      { operation: "invoke_agent", agent_name: "planner" },
    );
    await logger.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual([
      "plan",
      "chat gpt-4o",
      "execute_tool search",
      "invoke_agent planner",
    ]);

    // One trace for the whole run, derived from run_id.
    const traceId = traceIdFor({ run_id: "run-1" });
    for (const span of spans) expect(span.spanContext().traceId).toBe(traceId);

    // The tree is exactly the logged tree: each child points at the span record that enclosed it.
    const run = byName(spans, "invoke_agent planner");
    const runRecord = sink.records.find((r) => r.message === "run");
    expect(run.spanContext().spanId).toBe(runRecord?.meta.span_id);
    expect(run.parentSpanContext).toBeUndefined();
    for (const child of ["plan", "chat gpt-4o", "execute_tool search"]) {
      expect(byName(spans, child).parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    }

    // GenAI attributes and kinds.
    const chat = byName(spans, "chat gpt-4o");
    expect(chat.kind).toBe(SpanKind.CLIENT);
    expect(chat.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "unknown",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.response.finish_reasons": ["stop"],
      "logquill.cost_usd": 0.001,
      "logquill.run_id": "run-1",
    });
    expect(byName(spans, "execute_tool search").kind).toBe(SpanKind.INTERNAL);
    expect(byName(spans, "execute_tool search").attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "gen_ai.tool.call.id": "c1",
    });
    expect(run.kind).toBe(SpanKind.CLIENT);
    expect(run.attributes["gen_ai.agent.name"]).toBe("planner");
    expect(byName(spans, "plan").attributes).not.toHaveProperty("gen_ai.operation.name");

    // Timing comes from the record: end is the record's time, start is end minus the duration.
    expect(hrToMs(chat.endTime) - hrToMs(chat.startTime)).toBeCloseTo(40, 3);
    const tool = byName(spans, "execute_tool search");
    expect(hrToMs(tool.endTime) - hrToMs(tool.startTime)).toBeCloseTo(3, 3);
  });

  it("ignores records that describe no work: thoughts, plain logs, observations", async () => {
    const { exporter, logger } = setup();
    logger.info("plain");
    logger.thought("hmm");
    logger.observation("saw it", { tool: "search" });
    logger.action("no tool named");
    await logger.flush();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("marks a failed span as an error with the message, and keeps the exception propagating", async () => {
    const { exporter, logger } = setup();
    await expect(
      logger.span("risky", () => {
        throw new TypeError("bad input");
      }),
    ).rejects.toThrow("bad input");
    await logger.flush();
    const span = byName(exporter.getFinishedSpans(), "risky");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("TypeError: bad input");
    expect(span.attributes["error.type"]).toBe("TypeError");
  });

  it("carries a span's state_diff as an event", async () => {
    const { exporter, logger } = setup({}, { contentPolicy: "full" });
    const state = { n: 0 };
    await logger.span(
      "work",
      () => {
        state.n = 1;
      },
      { captureState: () => state },
    );
    await logger.flush();
    const span = byName(exporter.getFinishedSpans(), "work");
    expect(span.events).toHaveLength(1);
    expect(span.events[0]?.name).toBe("logquill.state_diff");
    expect(JSON.parse(String(span.events[0]?.attributes?.["logquill.state"]))).toEqual({
      before: { n: 0 },
      after: { n: 1 },
    });
  });

  it("uses the legacy attribute names when asked, and never both", async () => {
    const { exporter, logger } = setup({ semconvVersion: "legacy", defaultProvider: "openai" });
    logger.llmCall({ model: "m", tokensIn: 1, tokensOut: 2 });
    await logger.flush();
    const attrs = byName(exporter.getFinishedSpans(), "chat m").attributes;
    expect(attrs).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.usage.prompt_tokens": 1,
      "gen_ai.usage.completion_tokens": 2,
    });
    expect(attrs).not.toHaveProperty("gen_ai.usage.input_tokens");
    expect(attrs).not.toHaveProperty("gen_ai.provider.name");
  });

  it("never exports prompt text unless captureContent is on (and the logger's contentPolicy lets it through)", async () => {
    const messages = [{ role: "user", content: "hello" }];
    const exportWith = async (
      options: OTLPTransportOptions,
      contentPolicy: "full" | "off",
    ): Promise<ReadableSpan["attributes"]> => {
      const { exporter, logger } = setup(options, { contentPolicy });
      logger.llmCall({ model: "m" }, { input_messages: messages });
      await logger.flush();
      return byName(exporter.getFinishedSpans(), "chat m").attributes;
    };

    expect(await exportWith({}, "full")).not.toHaveProperty("gen_ai.input.messages");
    expect(await exportWith({ captureContent: true }, "full")).toHaveProperty(
      "gen_ai.input.messages",
      JSON.stringify(messages),
    );
    // contentPolicy still wins: with it off, the span gets the placeholder, never the prompt.
    const guarded = await exportWith({ captureContent: true }, "off");
    expect(String(guarded["gen_ai.input.messages"])).toMatch(/content capture is off/);
    expect(JSON.stringify(guarded)).not.toContain("hello");
  });

  it("spans that name a parent but no run share a trace derived from the parent", async () => {
    const exporter = new InMemorySpanExporter();
    const otlp = new OTLPTransport({ spanExporter: exporter, processor: "simple" });
    const logger = new Logger("agent", { transports: [otlp] });
    await logger.span("a", () => undefined, { parentSpanId: "shared-parent" });
    await logger.span("b", () => undefined, { parentSpanId: "shared-parent" });
    await logger.flush();
    const [a, b] = exporter.getFinishedSpans();
    expect(a?.spanContext().traceId).toBe(traceIdFromParent("shared-parent"));
    expect(b?.spanContext().traceId).toBe(a?.spanContext().traceId);
  });

  it("flush() sends what the batch processor is holding, and close() shuts down cleanly", async () => {
    const exporter = new InMemorySpanExporter();
    const otlp = new OTLPTransport({ spanExporter: exporter });
    const logger = new Logger("agent", { transports: [otlp] });
    await logger.span("batched", () => undefined);
    await logger.flush();
    await otlp.flush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["batched"]);
    expect(() => {
      otlp.close();
    }).not.toThrow();
  });

  it("rejects an unknown processor at construction", () => {
    expect(
      () =>
        new OTLPTransport({ spanExporter: new InMemorySpanExporter(), processor: "x" as "batch" }),
    ).toThrow(/processor must be 'batch' or 'simple'/);
  });

  it("says which package to install when an OpenTelemetry package is missing", () => {
    expect(() => loadOtel("OTLPTransport", "@opentelemetry/not-installed")).toThrow(
      /OTLPTransport requires @opentelemetry\/not-installed: install the OpenTelemetry packages/,
    );
  });

  it("never throws into the caller for an odd record", async () => {
    const { logger } = setup();
    expect(() =>
      logger.llmCall(
        { model: "m" },
        { span_id: 42, parent_span_id: {}, trace_id: [], run_id: null },
      ),
    ).not.toThrow();
    await logger.flush();
  });
});
