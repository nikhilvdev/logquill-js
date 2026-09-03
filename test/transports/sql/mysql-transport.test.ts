import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/index.js";
import { MySQLTransport, type MySQLClientLike } from "../../../src/transports/sql/mysql-transport.js";

function fakeClient(): MySQLClientLike & { executeCalls: { sql: string; values: unknown[] }[] } {
  const executeCalls: { sql: string; values: unknown[] }[] = [];
  return {
    executeCalls,
    execute(sql: string, values: unknown[]) {
      executeCalls.push({ sql, values });
      return Promise.resolve(undefined);
    },
  };
}

describe("MySQLTransport", () => {
  it("batches inserts until maxRecords is reached, as one multi-row INSERT", async () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.executeCalls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.executeCalls).toHaveLength(1);
    expect(client.executeCalls[0]?.sql).toContain("INSERT INTO logs");
    expect(client.executeCalls[0]?.sql).toContain(
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    expect(client.executeCalls[0]?.values).toHaveLength(18);
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1", spanId: "span-1" });
    await logger.flush();
    transport.close();

    expect(client.executeCalls).toHaveLength(1);
    const [timestamp, level, loggerName, message, meta, runId, spanId, parentSpanId, traceId] = client
      .executeCalls[0]?.values as [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    expect(level).toBe("INFO");
    expect(loggerName).toBe("app.test");
    expect(message).toBe("only one");
    expect(JSON.parse(meta)).toEqual({ runId: "run-1", spanId: "span-1" });
    expect(runId).toBe("run-1");
    expect(spanId).toBe("span-1");
    expect(parentSpanId).toBeNull();
    expect(traceId).toBeNull();
    expect(typeof timestamp).toBe("string");
  });

  it("never runs ensureTable unless ensureSchema is set", async () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();

    expect(client.executeCalls.some((call) => call.sql.includes("CREATE TABLE"))).toBe(false);
  });

  it("runs ensureTable exactly once when ensureSchema is true", async () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client, ensureSchema: true, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    logger.info("two");
    await logger.flush();

    const createCalls = client.executeCalls.filter((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS logs"));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.sql).toContain("AUTO_INCREMENT");
    expect(createCalls[0]?.sql).toContain("JSON");
  });

  it("flushes once maxBytes is reached even below maxRecords", async () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    expect(client.executeCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new MySQLTransport({ client });

    transport.close();

    expect(client.executeCalls).toHaveLength(0);
  });

  it("throws an actionable error when mysql2 isn't installed and no client is given", async () => {
    const transport = new MySQLTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    await logger.flush();
    transport.close();
    // The failing dynamic import resolves via real filesystem I/O, not just a
    // microtask, so give it real time rather than a single setImmediate tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `mysql2`");
  });
});
