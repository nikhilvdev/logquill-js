import { describe, expect, it } from "vitest";
import {
  Logger,
  parseTraceHeader,
  setTraceparent,
  TraceContextPlugin,
} from "../../src/index.js";

describe("TraceContextPlugin", () => {
  it("generates a traceId when nothing is available", () => {
    const logger = new Logger("app.test", { plugins: [new TraceContextPlugin()] });

    const record = logger.info("step");
    const traceId = record?.meta.traceId;

    expect(typeof traceId).toBe("string");
    expect((traceId as string).length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(traceId as string)).toBe(true);
  });

  it("does not override an existing traceId", () => {
    const logger = new Logger("app.test", { plugins: [new TraceContextPlugin()] });

    const record = logger.info("step", { traceId: "already-set" });

    expect(record?.meta.traceId).toBe("already-set");
  });

  it("supports a custom traceKey", () => {
    const logger = new Logger("app.test", {
      plugins: [new TraceContextPlugin({ traceKey: "correlationId" })],
    });

    const record = logger.info("step");

    expect(record?.meta.correlationId).toBeDefined();
    expect(record?.meta.traceId).toBeUndefined();
  });

  it("parses an explicit traceparent constructor option", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const logger = new Logger("app.test", {
      plugins: [new TraceContextPlugin({ traceparent: header })],
    });

    expect(logger.info("step")?.meta.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("setTraceparent propagates via AsyncLocalStorage, and reset restores generation", () => {
    const logger = new Logger("app.test", { plugins: [new TraceContextPlugin()] });
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const reset = setTraceparent(header);
    const record = logger.info("step");
    reset();

    expect(record?.meta.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

    const recordAfter = logger.info("step 2");
    expect(recordAfter?.meta.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("an active OTel span wins over a header, via an injected resolver", () => {
    const header = "00-11111111111111111111111111111111-00f067aa0ba902b7-01";
    const logger = new Logger("app.test", {
      plugins: [
        new TraceContextPlugin({
          traceparent: header,
          resolveActiveOtelTraceId: () => "4bf92f3577b34da6a3ce929d0e0e4736",
        }),
      ],
    });

    expect(logger.info("step")?.meta.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("falls back gracefully when @opentelemetry/api is not installed", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const logger = new Logger("app.test", {
      plugins: [new TraceContextPlugin({ traceparent: header })],
    });

    expect(logger.info("step")?.meta.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("parseTraceHeader", () => {
  it("parses a W3C traceparent header", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceHeader(header)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("parses an AWS X-Ray header", () => {
    const header = "Root=1-5e1b4151-5ac6c9df6a1c0c8e5c1e1e1e;Parent=53995c3f42cd8ad8;Sampled=1";
    expect(parseTraceHeader(header)).toBe("5e1b41515ac6c9df6a1c0c8e5c1e1e1e");
  });

  it("parses a GCP Cloud Trace header", () => {
    const header = "105445aa7843bc8bf206b12000100000/1;o=1";
    expect(parseTraceHeader(header)).toBe("105445aa7843bc8bf206b12000100000");
  });

  it("returns undefined for an unrecognized header", () => {
    expect(parseTraceHeader("not-a-trace-header")).toBeUndefined();
  });
});
