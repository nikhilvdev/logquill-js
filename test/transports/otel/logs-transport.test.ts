import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import {
  Level,
  Logger,
  OTelLogsTransport,
  OTLPTransport,
  RunPlugin,
  type OTelLogsTransportOptions,
} from "../../../src/index.js";
import { spanIdFor, traceIdFor, traceIdFromParent } from "../../../src/otel/ids.js";

function setup(options: OTelLogsTransportOptions = {}, plugins: Logger["plugins"] = []) {
  const exporter = new InMemoryLogRecordExporter();
  const transport = new OTelLogsTransport({
    logExporter: exporter,
    processor: "simple",
    ...options,
  });
  const logger = new Logger("app.svc", {
    level: Level.TRACE,
    transports: [transport],
    plugins,
  });
  return { exporter, transport, logger };
}

describe("OTelLogsTransport", () => {
  it("emits the message as the body, the level as severity, and meta as attributes", async () => {
    const { exporter, logger } = setup();
    logger.warn("disk almost full", { path: "/var", pct: 91.5, urgent: true, tags: ["a", "b"] });
    await logger.flush();

    const [log] = exporter.getFinishedLogRecords();
    expect(log).toMatchObject({
      body: "disk almost full",
      severityText: "WARN",
      severityNumber: 13,
    });
    expect(log?.attributes).toMatchObject({
      path: "/var",
      pct: 91.5,
      urgent: true,
      tags: ["a", "b"],
      "logquill.logger": "app.svc",
      "logquill.schema_version": "2.0",
    });
  });

  it("maps every level to its OTLP severity number", async () => {
    const { exporter, logger } = setup();
    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    await logger.flush();
    expect(exporter.getFinishedLogRecords().map((r) => [r.severityText, r.severityNumber])).toEqual(
      [
        ["TRACE", 1],
        ["DEBUG", 5],
        ["INFO", 9],
        ["WARN", 13],
        ["ERROR", 17],
        ["FATAL", 21],
      ],
    );
  });

  it("turns nested values into JSON strings, a stack into exception.stacktrace, and skips nulls", async () => {
    const { exporter, logger } = setup();
    logger.error("boom", {
      nested: { a: [1, { b: 2 }] },
      mixed: [1, "x"],
      gone: null,
      stack: "Error: x\n at f",
    });
    await logger.flush();
    const attrs = exporter.getFinishedLogRecords()[0]?.attributes;
    expect(attrs?.nested).toBe('{"a":[1,{"b":2}]}');
    expect(attrs?.mixed).toBe('[1,"x"]');
    expect(attrs).not.toHaveProperty("gone");
    expect(attrs).not.toHaveProperty("stack");
    expect(attrs?.["exception.stacktrace"]).toBe("Error: x\n at f");
  });

  it("adds the standard model and token attributes for an llm record", async () => {
    const { exporter, logger } = setup();
    logger.llmCall({ model: "gpt-4o", tokensIn: 7, tokensOut: 3, finishReason: "stop" });
    await logger.flush();
    expect(exporter.getFinishedLogRecords()[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.response.finish_reasons": ["stop"],
    });
  });

  it("carries the same trace and span ids OTLPTransport gives the span, so a collector can join them", async () => {
    const { exporter, logger } = setup({}, [new RunPlugin({ runId: "run-9" })]);
    await logger.span("work", () => undefined);
    await logger.flush();
    const [log] = exporter.getFinishedLogRecords();
    const spanRecordId = log?.attributes.span_id as string;
    expect(log?.spanContext?.traceId).toBe(traceIdFor({ run_id: "run-9" }));
    expect(log?.spanContext?.spanId).toBe(spanIdFor(spanRecordId));
  });

  it("a log line written inside a span carries that span's trace and span id, the ones OTLPTransport exports", async () => {
    const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const logger = new Logger("agent", {
      transports: [
        new OTLPTransport({ spanExporter: spans, processor: "simple" }),
        new OTelLogsTransport({ logExporter: logs, processor: "simple" }),
      ],
      plugins: [new RunPlugin({ runId: "run-3" })],
    });
    await logger.span("step", () => {
      logger.info("inside the step");
      logger.llmCall({ model: "m" });
    });
    logger.info("outside any span");
    await logger.flush();

    const step = spans.getFinishedSpans().find((span) => span.name === "step");
    const byBody = (body: string) => logs.getFinishedLogRecords().find((r) => r.body === body);
    for (const body of ["inside the step", "llm_call", "step"]) {
      expect(byBody(body)?.spanContext?.spanId, body).toBe(step?.spanContext().spanId);
      expect(byBody(body)?.spanContext?.traceId, body).toBe(step?.spanContext().traceId);
    }
    expect(byBody("outside any span")?.spanContext).toBeUndefined();
    expect(byBody("outside any span")?.attributes.run_id).toBe("run-3");
  });

  it("a log line inside a span with no run or trace id still joins it, with the trace derived from the parent", async () => {
    const logs = new InMemoryLogRecordExporter();
    const logger = new Logger("agent", {
      transports: [new OTelLogsTransport({ logExporter: logs, processor: "simple" })],
    });
    logger.info("child", { parent_span_id: "00f067aa0ba902b7" });
    await logger.flush();
    const log = logs.getFinishedLogRecords()[0];
    expect(log?.spanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(log?.spanContext?.traceId).toBe(traceIdFromParent("00f067aa0ba902b7"));
  });

  it("a record with a trace_id but no span_id keeps the trace id as an attribute only", async () => {
    const { exporter, logger } = setup();
    logger.info("no span", { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" });
    await logger.flush();
    const [log] = exporter.getFinishedLogRecords();
    expect(log?.attributes.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(log?.spanContext).toBeUndefined();
  });

  it("uses the legacy attribute names when asked", async () => {
    const { exporter, logger } = setup({ semconvVersion: "legacy" });
    logger.llmCall({ model: "m", tokensIn: 1 });
    await logger.flush();
    expect(exporter.getFinishedLogRecords()[0]?.attributes).toHaveProperty(
      "gen_ai.usage.prompt_tokens",
      1,
    );
  });

  it("flush() exports what the batch processor is holding, and close() shuts down cleanly", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const transport = new OTelLogsTransport({ logExporter: exporter });
    const logger = new Logger("app", { transports: [transport] });
    logger.info("batched");
    await logger.flush();
    await transport.flush();
    expect(exporter.getFinishedLogRecords().map((r) => r.body)).toEqual(["batched"]);
    expect(() => {
      transport.close();
    }).not.toThrow();
  });

  it("rejects an unknown processor at construction", () => {
    expect(
      () =>
        new OTelLogsTransport({
          logExporter: new InMemoryLogRecordExporter(),
          processor: "x" as "batch",
        }),
    ).toThrow(/processor must be 'batch' or 'simple'/);
  });

  it("works next to OTLPTransport on one logger: spans and log lines for the same run", async () => {
    const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const logger = new Logger("agent", {
      transports: [
        new OTLPTransport({ spanExporter: spans, processor: "simple" }),
        new OTelLogsTransport({ logExporter: logs, processor: "simple" }),
      ],
      plugins: [new RunPlugin({ runId: "run-2" })],
    });
    await logger.span("step", () => {
      logger.info("inside");
    });
    await logger.flush();
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(["step"]);
    expect(logs.getFinishedLogRecords().map((r) => r.body)).toEqual(["inside", "step"]);
  });
});
