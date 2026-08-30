import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/index.js";
import { PostgresTransport, type PgClientLike } from "../../../src/transports/sql/postgres-transport.js";

function fakeClient(): PgClientLike & { queryCalls: { text: string; values: unknown[] }[] } {
  const queryCalls: { text: string; values: unknown[] }[] = [];
  return {
    queryCalls,
    query(text: string, values: unknown[]) {
      queryCalls.push({ text, values });
      return Promise.resolve(undefined);
    },
  };
}

describe("PostgresTransport", () => {
  it("batches inserts until maxRecords is reached, as one multi-row INSERT", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(client.queryCalls).toHaveLength(0);

    logger.info("two");
    expect(client.queryCalls).toHaveLength(1);
    expect(client.queryCalls[0]?.text).toContain("INSERT INTO logs");
    expect(client.queryCalls[0]?.text).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18)");
    expect(client.queryCalls[0]?.values).toHaveLength(18);
  });

  it("close() flushes a partial batch", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1", spanId: "span-1" });
    transport.close();

    expect(client.queryCalls).toHaveLength(1);
    const [timestamp, level, loggerName, message, meta, runId, spanId, parentSpanId, traceId] = client.queryCalls[0]
      ?.values as [string, string, string, string, string, string | null, string | null, string | null, string | null];
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

  it("never runs ensureTable unless ensureSchema is set", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    transport.close();

    expect(client.queryCalls.some((call) => call.text.includes("CREATE TABLE"))).toBe(false);
  });

  it("runs ensureTable exactly once when ensureSchema is true", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client, ensureSchema: true, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    logger.info("two");

    const createCalls = client.queryCalls.filter((call) => call.text.includes("CREATE TABLE IF NOT EXISTS logs"));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.text).toContain("SERIAL PRIMARY KEY");
    expect(createCalls[0]?.text).toContain("JSONB");
  });

  it("flushes once maxBytes is reached even below maxRecords", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    expect(client.queryCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new PostgresTransport({ client });

    transport.close();

    expect(client.queryCalls).toHaveLength(0);
  });

  it("throws an actionable error when pg isn't installed and no client is given", async () => {
    const transport = new PostgresTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    transport.close();
    // The failing dynamic import resolves via real filesystem I/O, not just a
    // microtask, so give it real time rather than a single setImmediate tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `pg`");
  });
});
