import pino from "pino";
import { describe, expect, it } from "vitest";
import { CollectingTransport, Logger, LogQuillPinoDestination } from "../../src/index.js";

describe("LogQuillPinoDestination", () => {
  it("forwards a pino .info() call through to the LogQuill logger's transports", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { transports: [sink] });
    const log = pino(new LogQuillPinoDestination(logquill));

    log.info({ userId: 42 }, "still works");
    await logquill.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.level).toBe("INFO");
    expect(sink.records[0]?.message).toBe("still works");
    expect(sink.records[0]?.meta.userId).toBe(42);
  });

  it("maps pino's numeric levels onto LogQuill levels", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { level: "trace", transports: [sink] });
    const log = pino({ level: "trace" }, new LogQuillPinoDestination(logquill));

    log.error("bad");
    log.warn("hmm");
    log.debug("details");
    await logquill.flush();

    expect(sink.records.map((record) => record.level)).toEqual(["ERROR", "WARN", "DEBUG"]);
  });

  it("a LogQuill Logger's own level still filters records that reach it", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { level: "error", transports: [sink] });
    const log = pino(new LogQuillPinoDestination(logquill));

    log.info("filtered out");
    log.error("kept");
    await logquill.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.message).toBe("kept");
  });

  it("skips an unparsable line instead of throwing", () => {
    const logquill = new Logger("app");
    const destination = new LogQuillPinoDestination(logquill);

    expect(() => destination.write("not json\n")).not.toThrow();
  });

  it("handles more than one NDJSON line in a single write() call", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { transports: [sink] });
    const destination = new LogQuillPinoDestination(logquill);

    destination.write('{"level":30,"msg":"one"}\n{"level":30,"msg":"two"}\n');
    await logquill.flush();

    expect(sink.records.map((record) => record.message)).toEqual(["one", "two"]);
  });
});
