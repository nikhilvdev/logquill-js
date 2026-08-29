import { describe, expect, it } from "vitest";
import { CollectingTransport, Level, Logger, type Plugin } from "../src/index.js";

describe("Logger", () => {
  it("produces a well-formed record", () => {
    const logger = new Logger("app.test");
    const record = logger.info("hello", { user_id: 42 });

    expect(record).not.toBeNull();
    expect(record?.level).toBe("INFO");
    expect(record?.logger).toBe("app.test");
    expect(record?.message).toBe("hello");
    expect(record?.meta).toEqual({ user_id: 42 });
    expect(record?.timestamp.endsWith("Z")).toBe(true);
  });

  it("filters records below the configured level", () => {
    const logger = new Logger("app.test", { level: Level.WARN });

    expect(logger.debug("noisy")).toBeNull();
    expect(logger.info("still noisy")).toBeNull();
    expect(logger.warn("audible")).not.toBeNull();
  });

  it("setLevel changes the threshold", () => {
    const logger = new Logger("app.test", { level: Level.ERROR });
    expect(logger.warn("dropped")).toBeNull();

    logger.setLevel("trace");
    expect(logger.warn("now visible")).not.toBeNull();
  });

  it("level getter reflects the current threshold", () => {
    const logger = new Logger("app.test", { level: "warn" });
    expect(logger.level).toBe(Level.WARN);

    logger.setLevel(Level.DEBUG);
    expect(logger.level).toBe(Level.DEBUG);
  });

  it("every level method produces a matching level name", () => {
    const logger = new Logger("app.test", { level: Level.TRACE });

    expect(logger.trace("x")?.level).toBe("TRACE");
    expect(logger.debug("x")?.level).toBe("DEBUG");
    expect(logger.info("x")?.level).toBe("INFO");
    expect(logger.warn("x")?.level).toBe("WARN");
    expect(logger.error("x")?.level).toBe("ERROR");
    expect(logger.fatal("x")?.level).toBe("FATAL");
  });

  it("dispatches formatted records to every transport", () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { a: 1 });

    expect(transport.records).toHaveLength(1);
    expect(transport.records[0]?.message).toBe("hello");
    expect(transport.formatted[0]).toBe(JSON.stringify(transport.records[0]));
  });

  it("close() closes every attached transport", () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    logger.close();

    expect(transport.closed).toBe(true);
  });

  it("use() registers a plugin and returns the logger for chaining", () => {
    const logger = new Logger("app.test");
    const plugin: Plugin = {};

    expect(logger.use(plugin)).toBe(logger);
    expect(logger.plugins).toContain(plugin);
  });

  it("beforeLog can modify a record", () => {
    const plugin: Plugin = {
      beforeLog(record) {
        return { ...record, message: record.message.toUpperCase() };
      },
    };
    const logger = new Logger("app.test", { plugins: [plugin] });

    expect(logger.info("hello")?.message).toBe("HELLO");
  });

  it("beforeLog returning null drops the record before it reaches transports", () => {
    const transport = new CollectingTransport();
    const plugin: Plugin = { beforeLog: () => null };
    const logger = new Logger("app.test", { transports: [transport], plugins: [plugin] });

    expect(logger.info("dropped")).toBeNull();
    expect(transport.records).toHaveLength(0);
  });

  it("a throwing plugin hook does not crash logging and is routed to onError", () => {
    const errors: unknown[] = [];
    const plugin: Plugin = {
      beforeLog() {
        throw new Error("boom");
      },
      onError(error) {
        errors.push(error);
      },
    };
    const logger = new Logger("app.test", { plugins: [plugin] });

    expect(() => logger.info("still works")).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("a throwing afterLog hook does not crash logging and is routed to onError", () => {
    const errors: unknown[] = [];
    const plugin: Plugin = {
      afterLog() {
        throw new Error("boom");
      },
      onError(error) {
        errors.push(error);
      },
    };
    const logger = new Logger("app.test", { plugins: [plugin] });

    expect(() => logger.info("still works")).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("child() inherits level, transports, and plugins, and merges meta", () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app", {
      level: Level.WARN,
      transports: [transport],
      meta: { service: "api" },
    });

    const child = logger.child("db", { component: "pool" });
    const record = child.info("noisy", { extra: true });
    expect(record).toBeNull(); // inherited WARN threshold

    const warnRecord = child.warn("connection lost");
    expect(warnRecord?.logger).toBe("app.db");
    expect(warnRecord?.meta).toEqual({ service: "api", component: "pool" });
    expect(transport.records).toHaveLength(1);
  });

  it("meta passed per-call overrides base meta on key collisions", () => {
    const logger = new Logger("app", { meta: { a: 1 } });
    const record = logger.info("x", { a: 2 });
    expect(record?.meta).toEqual({ a: 2 });
  });
});
