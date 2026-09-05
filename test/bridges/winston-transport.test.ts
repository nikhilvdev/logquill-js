import { describe, expect, it } from "vitest";
import winston from "winston";
import { CollectingTransport, Logger } from "../../src/index.js";
import { LogQuillWinstonTransport } from "../../src/winston.js";

function waitForLogged(bridge: LogQuillWinstonTransport, count: number): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    bridge.on("logged", () => {
      seen += 1;
      if (seen >= count) {
        resolve();
      }
    });
  });
}

describe("LogQuillWinstonTransport", () => {
  it("forwards a winston .info() call through to the LogQuill logger's transports", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { transports: [sink] });
    const bridge = new LogQuillWinstonTransport(logquill);
    const winstonLogger = winston.createLogger({ transports: [bridge] });

    const done = waitForLogged(bridge, 1);
    winstonLogger.info("still works", { userId: 42 });
    await done;
    await logquill.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.level).toBe("INFO");
    expect(sink.records[0]?.message).toBe("still works");
    expect(sink.records[0]?.meta.userId).toBe(42);
  });

  it("maps winston levels onto LogQuill levels via DEFAULT_WINSTON_LEVEL_MAP", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { level: "trace", transports: [sink] });
    const bridge = new LogQuillWinstonTransport(logquill);
    const winstonLogger = winston.createLogger({ level: "silly", transports: [bridge] });

    const done = waitForLogged(bridge, 3);
    winstonLogger.error("bad");
    winstonLogger.warn("hmm");
    winstonLogger.debug("details");
    await done;
    await logquill.flush();

    expect(sink.records.map((record) => record.level)).toEqual(["ERROR", "WARN", "DEBUG"]);
  });

  it("a LogQuill Logger's own level still filters records that reach it", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { level: "error", transports: [sink] });
    const bridge = new LogQuillWinstonTransport(logquill);
    const winstonLogger = winston.createLogger({ transports: [bridge] });

    const done = waitForLogged(bridge, 2);
    winstonLogger.info("filtered out");
    winstonLogger.error("kept");
    await done;
    await logquill.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.message).toBe("kept");
  });

  it("an unmapped custom level falls back to INFO", async () => {
    const sink = new CollectingTransport();
    const logquill = new Logger("app", { transports: [sink] });
    const bridge = new LogQuillWinstonTransport(logquill);
    const winstonLogger = winston.createLogger({
      levels: { custom: 0 },
      level: "custom",
      transports: [bridge],
    });

    const done = waitForLogged(bridge, 1);
    winstonLogger.log("custom", "unmapped level");
    await done;
    await logquill.flush();

    expect(sink.records[0]?.level).toBe("INFO");
  });
});
