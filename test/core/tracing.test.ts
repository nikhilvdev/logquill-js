import { describe, expect, it } from "vitest";
import { CollectingTransport, Logger } from "../../src/index.js";

describe("agentic convenience methods", () => {
  it.each([
    ["thought", "thought"],
    ["action", "action"],
    ["observation", "observation"],
    ["decision", "decision"],
  ] as const)("%s() stamps meta.kind = %s", (method, kind) => {
    const logger = new Logger("app");
    const record = logger[method]("step", { extra: 1 });

    expect(record?.meta.kind).toBe(kind);
    expect(record?.meta.extra).toBe(1);
  });

  it("a call-site kind overrides the method's default", () => {
    const logger = new Logger("app");
    const record = logger.thought("step", { kind: "custom" });

    expect(record?.meta.kind).toBe("custom");
  });
});

describe("Logger.span()", () => {
  it("emits a record with spanId and durationMs", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("callLlm", () => {});
    await logger.flush();

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(typeof record?.meta.spanId).toBe("string");
    expect(record?.meta.spanId).toBeTruthy();
    expect(typeof record?.meta.durationMs).toBe("number");
  });

  it("has no parentSpanId and kind 'span' at the top level", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("callLlm", () => {});
    await logger.flush();

    const record = sink.records[0];
    expect(record?.meta.parentSpanId).toBeUndefined();
    expect(record?.meta.kind).toBe("span");
  });

  it("returns fn's resolved value", async () => {
    const logger = new Logger("app");
    const result = await logger.span("callLlm", () => 42);
    expect(result).toBe(42);
  });

  it("stamps records logged inside the block with parentSpanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("callLlm", () => {
      logger.action("call tool");
    });
    await logger.flush();

    const [actionRecord, spanRecord] = sink.records;
    expect(actionRecord?.message).toBe("call tool");
    expect(actionRecord?.meta.parentSpanId).toBe(spanRecord?.meta.spanId);
  });

  it("stamps records across an internal await with parentSpanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("callLlm", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      logger.action("call tool after await");
    });
    await logger.flush();

    const [actionRecord, spanRecord] = sink.records;
    expect(actionRecord?.meta.parentSpanId).toBe(spanRecord?.meta.spanId);
  });

  it("nested spans form a parent chain", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("outer", async () => {
      await logger.span("inner", () => {
        logger.action("leaf");
      });
    });
    await logger.flush();

    const [leaf, innerRecord, outerRecord] = sink.records;
    expect(leaf?.meta.parentSpanId).toBe(innerRecord?.meta.spanId);
    expect(innerRecord?.meta.parentSpanId).toBe(outerRecord?.meta.spanId);
    expect(outerRecord?.meta.parentSpanId).toBeUndefined();
  });

  it("still emits its record and rethrows on exception", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await expect(
      logger.span("risky", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await logger.flush();

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(record?.level).toBe("ERROR");
    expect(record?.meta.error).toBe("Error: boom");
  });

  it("accepts explicit spanId and parentSpanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("chain", () => {}, { spanId: "abc123", parentSpanId: "parent456" });
    await logger.flush();

    const record = sink.records[0];
    expect(record?.meta.spanId).toBe("abc123");
    expect(record?.meta.parentSpanId).toBe("parent456");
  });

  it("extra options become meta", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await logger.span("chain", () => {}, { model: "gpt-4" });
    await logger.flush();

    expect(sink.records[0]?.meta.model).toBe("gpt-4");
  });

  it("concurrent spans on the same logger don't leak parentSpanId across each other", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });

    await Promise.all([
      logger.span("first", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        logger.action("inside first");
      }),
      logger.span("second", async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        logger.action("inside second");
      }),
    ]);
    await logger.flush();

    const firstSpanRecord = sink.records.find((r) => r.message === "first");
    const secondSpanRecord = sink.records.find((r) => r.message === "second");
    const insideFirst = sink.records.find((r) => r.message === "inside first");
    const insideSecond = sink.records.find((r) => r.message === "inside second");

    expect(insideFirst?.meta.parentSpanId).toBe(firstSpanRecord?.meta.spanId);
    expect(insideSecond?.meta.parentSpanId).toBe(secondSpanRecord?.meta.spanId);
  });
});
