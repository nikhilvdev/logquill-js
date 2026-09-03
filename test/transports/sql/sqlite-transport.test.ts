import { describe, expect, it } from "vitest";
import { Logger, SQLiteTransport, type SQLiteClientLike } from "../../../src/index.js";

function fakeClient(): SQLiteClientLike & { execCalls: string[]; runCalls: unknown[][] } {
  const execCalls: string[] = [];
  const runCalls: unknown[][] = [];
  return {
    execCalls,
    runCalls,
    exec(sql: string) {
      execCalls.push(sql);
    },
    prepare() {
      return {
        run(...params: unknown[]) {
          runCalls.push(params);
        },
      };
    },
    transaction<Args extends unknown[]>(fn: (...args: Args) => void) {
      return (...args: Args) => {
        fn(...args);
      };
    },
  };
}

describe("SQLiteTransport", () => {
  it("batches inserts until maxRecords is reached", async () => {
    const client = fakeClient();
    const transport = new SQLiteTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.runCalls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.runCalls).toHaveLength(2);
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new SQLiteTransport({ client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1", spanId: "span-1" });
    await logger.flush();
    transport.close();

    expect(client.runCalls).toHaveLength(1);
    const [timestamp, level, loggerName, message, meta, runId, spanId, parentSpanId, traceId] =
      client.runCalls[0] as [string, string, string, string, string, string | null, string | null, string | null, string | null];
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
    const transport = new SQLiteTransport({ client });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();

    expect(client.execCalls).toHaveLength(0);
  });

  it("runs ensureTable exactly once when ensureSchema is true", async () => {
    const client = fakeClient();
    const transport = new SQLiteTransport({ client, ensureSchema: true, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    logger.info("two");
    await logger.flush();

    expect(client.execCalls).toHaveLength(1);
    expect(client.execCalls[0]).toContain("CREATE TABLE IF NOT EXISTS logs");
  });

  it("flushes once maxBytes is reached even below maxRecords", async () => {
    const client = fakeClient();
    const transport = new SQLiteTransport({ client, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    expect(client.runCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new SQLiteTransport({ client });

    transport.close();

    expect(client.runCalls).toHaveLength(0);
  });

  it("throws an actionable error when better-sqlite3 isn't installed and no client is given", async () => {
    const transport = new SQLiteTransport();
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
    expect(String(errorSpy[0]?.[1])).toContain("install `better-sqlite3`");
  });
});
