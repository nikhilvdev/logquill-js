import { describe, expect, it } from "vitest";
import {
  CollectingTransport,
  Level,
  Logger,
  type LogRecord,
  type Plugin,
} from "../../src/index.js";

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

  it("dispatches formatted records to every transport", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { a: 1 });
    await logger.flush();

    expect(transport.records).toHaveLength(1);
    expect(transport.records[0]?.message).toBe("hello");
    expect(transport.formatted[0]).toBe(JSON.stringify(transport.records[0]));
  });

  it("close() closes every attached transport", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    await logger.close();

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

  it("a throwing afterLog hook does not crash logging and is routed to onError", async () => {
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
    await logger.flush();
    expect(errors).toHaveLength(1);
  });

  it("child() inherits level, transports, and plugins, and merges meta", async () => {
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
    await logger.flush();
    expect(transport.records).toHaveLength(1);
  });

  it("meta passed per-call overrides base meta on key collisions", () => {
    const logger = new Logger("app", { meta: { a: 1 } });
    const record = logger.info("x", { a: 2 });
    expect(record?.meta).toEqual({ a: 2 });
  });

  it("use() accepts a plain function and behaves identically to an equivalent Plugin", () => {
    const upperCase = (record: LogRecord) => ({
      ...record,
      message: record.message.toUpperCase(),
    });
    const equivalentPlugin: Plugin = { beforeLog: upperCase };

    const viaFunction = new Logger("app.test").use(upperCase).info("hello");
    const viaPlugin = new Logger("app.test").use(equivalentPlugin).info("hello");

    expect(viaFunction?.message).toBe("HELLO");
    expect(viaFunction?.message).toBe(viaPlugin?.message);
  });

  it("a function passed to use() can drop a record by returning null", () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    logger.use(() => null);

    expect(logger.info("dropped")).toBeNull();
    expect(transport.records).toHaveLength(0);
  });

  it("a function passed via the constructor's plugins array is wrapped the same way", () => {
    const logger = new Logger("app.test", {
      plugins: [(record) => ({ ...record, message: "replaced" })],
    });

    expect(logger.info("original")?.message).toBe("replaced");
  });

  describe("non-blocking dispatch", () => {
    it("info() returns before the write it triggered runs", () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app.test", { transports: [transport] });

      logger.info("hello");

      // The call already returned — the write is still sitting in the queue.
      expect(transport.records).toHaveLength(0);
      expect(logger.queueSize).toBe(1);
    });

    it("a burst under the configured queue limit loses nothing once flushed", async () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app.test", {
        transports: [transport],
        queue: { maxSize: 1000 },
      });

      for (let i = 0; i < 500; i += 1) {
        logger.info(`record ${String(i)}`);
      }
      await logger.flush();

      expect(transport.records).toHaveLength(500);
      expect(logger.queueSize).toBe(0);
    });

    it("a burst above the queue limit applies the configured backpressure policy and stays bounded", async () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app.test", {
        transports: [transport],
        queue: { maxSize: 50, policy: "dropOldest" },
      });

      for (let i = 0; i < 5000; i += 1) {
        logger.info(`record ${String(i)}`);
        expect(logger.queueSize).toBeLessThanOrEqual(50); // never grows past maxSize
      }
      await logger.flush();

      // dropOldest favors the most recent records — the tail end survives.
      expect(transport.records).toHaveLength(50);
      expect(transport.records.at(-1)?.message).toBe("record 4999");
    });

    it("the block policy never drops a record, even above the queue limit", async () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app.test", {
        transports: [transport],
        queue: { maxSize: 5, policy: "block" },
      });

      for (let i = 0; i < 20; i += 1) {
        logger.info(`record ${String(i)}`);
      }
      await logger.flush();

      expect(transport.records).toHaveLength(20);
    });

    it("child() shares the parent's dispatch queue", async () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app", { transports: [transport] });
      const child = logger.child("db");

      logger.info("from parent");
      child.info("from child");
      expect(logger.queueSize).toBe(2);
      expect(child.queueSize).toBe(2);

      await child.flush(); // draining from either logger drains the shared queue
      expect(transport.records).toHaveLength(2);
      expect(logger.queueSize).toBe(0);
    });

    it("close() drains pending writes before closing transports", async () => {
      const transport = new CollectingTransport();
      const logger = new Logger("app.test", { transports: [transport] });

      logger.info("last one out");
      await logger.close();

      expect(transport.records).toHaveLength(1);
      expect(transport.closed).toBe(true);
    });
  });

  describe("meta.err -> meta.stack capture", () => {
    it("replaces an Error in meta.err with a formatted meta.stack", () => {
      const logger = new Logger("app.test");

      const record = logger.error("failed", { err: new Error("boom"), userId: 42 });

      expect(record?.meta.err).toBeUndefined();
      expect(record?.meta.userId).toBe(42);
      expect(record?.meta.stack).toContain("Error: boom");
    });

    it("falls back to a formatted name/message when the Error has no stack", () => {
      const logger = new Logger("app.test");
      const err = new Error("boom");
      delete err.stack;

      const record = logger.error("failed", { err });

      expect(record?.meta.stack).toBe("Error: boom");
    });

    it("leaves a non-Error meta.err untouched", () => {
      const logger = new Logger("app.test");

      const record = logger.error("failed", { err: "just a string" });

      expect(record?.meta.err).toBe("just a string");
      expect(record?.meta.stack).toBeUndefined();
    });

    it("leaves records without meta.err unaffected", () => {
      const logger = new Logger("app.test");

      const record = logger.info("fine");

      expect(record?.meta.stack).toBeUndefined();
    });
  });
});
