import { describe, expect, it } from "vitest";
import { CollectingTransport, Logger, SamplingPlugin } from "../../src/index.js";

describe("SamplingPlugin", () => {
  it("rate 0 drops everything", () => {
    const logger = new Logger("app.test", { plugins: [new SamplingPlugin(0)] });

    expect(logger.info("hello")).toBeNull();
  });

  it("rate 1 keeps everything", () => {
    const logger = new Logger("app.test", { plugins: [new SamplingPlugin(1)] });

    expect(logger.info("hello")).not.toBeNull();
  });

  it("throws on an invalid rate", () => {
    expect(() => new SamplingPlugin(1.5)).toThrow(/rate must be between 0 and 1/);
    expect(() => new SamplingPlugin(-0.1)).toThrow(/rate must be between 0 and 1/);
  });

  it("a custom rng controls keep or drop", () => {
    const keep = new SamplingPlugin(0.5, { rng: () => 0.1 });
    const drop = new SamplingPlugin(0.5, { rng: () => 0.9 });

    const loggerKeep = new Logger("app.test", { plugins: [keep] });
    const loggerDrop = new Logger("app.test", { plugins: [drop] });

    expect(loggerKeep.info("hello")).not.toBeNull();
    expect(loggerDrop.info("hello")).toBeNull();
  });

  it("without transports, a traceId does not enable tail-based elevation", () => {
    // Backward-compatible: no `transports` given means plain rate sampling —
    // level is irrelevant, even for a record that carries a trace id and
    // would otherwise trigger elevation.
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9 });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    expect(logger.info("step 1", { traceId: "t1" })).toBeNull();
    expect(logger.error("step 2", { traceId: "t1" })).toBeNull();
    expect(sink.records).toHaveLength(0);
  });

  it("tail-based elevation flushes buffered records from the same trace", async () => {
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9, transports: [sink] });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    expect(logger.info("step 1", { traceId: "t1" })).toBeNull();
    expect(logger.info("step 2", { traceId: "t1" })).toBeNull();
    expect(sink.records).toHaveLength(0);

    const record = logger.error("step 3", { traceId: "t1" });
    await logger.flush();

    expect(record).not.toBeNull();
    expect(sink.records.map((r) => r.message)).toEqual(["step 1", "step 2", "step 3"]);
  });

  it("elevation only affects the matching trace", async () => {
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9, transports: [sink] });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    expect(logger.info("other trace", { traceId: "t2" })).toBeNull();
    expect(logger.info("step 1", { traceId: "t1" })).toBeNull();
    logger.error("step 2", { traceId: "t1" });
    await logger.flush();

    const messages = sink.records.map((r) => r.message);
    expect(messages).not.toContain("other trace");
    expect(messages).toEqual(["step 1", "step 2"]);
  });

  it("records after elevation ship unconditionally", async () => {
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9, transports: [sink] });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    logger.error("triggers elevation", { traceId: "t1" });
    const record = logger.info("after elevation", { traceId: "t1" });
    await logger.flush();

    expect(record).not.toBeNull();
    expect(sink.records.at(-1)?.message).toBe("after elevation");
  });

  it("the buffer is bounded by maxTraces", async () => {
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9, transports: [sink], maxTraces: 1 });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    logger.info("trace one", { traceId: "t1" });
    logger.info("trace two", { traceId: "t2" }); // evicts t1's buffer (maxTraces: 1)
    logger.error("elevates t1", { traceId: "t1" });
    await logger.flush();

    // t1's earlier buffered record was evicted, so only the elevating record ships
    const messages = sink.records.map((r) => r.message);
    expect(messages).not.toContain("trace one");
    expect(messages).toContain("elevates t1");
  });

  it("the buffer is bounded by maxBufferedRecords", async () => {
    const sink = new CollectingTransport();
    const sampling = new SamplingPlugin(0, { rng: () => 0.9, transports: [sink], maxBufferedRecords: 1 });
    const logger = new Logger("app.test", { transports: [sink], plugins: [sampling] });

    logger.info("trace one, record one", { traceId: "t1" });
    // second buffered record (still t1) exceeds maxBufferedRecords: 1,
    // evicting the whole oldest trace's buffer (t1's first record)
    logger.info("trace one, record two", { traceId: "t1" });
    logger.error("elevates t1", { traceId: "t1" });
    await logger.flush();

    const messages = sink.records.map((r) => r.message);
    expect(messages).not.toContain("trace one, record one");
    expect(messages).toContain("elevates t1");
  });
});
