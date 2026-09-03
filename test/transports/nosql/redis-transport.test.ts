import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { RedisTransport, type RedisClientLike } from "../../../src/transports/nosql/redis-transport.js";

function fakeClient(): RedisClientLike & { xAddCalls: [string, string, Record<string, string>][] } {
  const xAddCalls: [string, string, Record<string, string>][] = [];
  return {
    xAddCalls,
    xAdd(stream: string, id: string, fields: Record<string, string>) {
      xAddCalls.push([stream, id, fields]);
      return Promise.resolve(`${String(xAddCalls.length)}-0`);
    },
  };
}

describe("RedisTransport", () => {
  it("batches until maxRecords is reached, then issues one XADD per record", async () => {
    const client = fakeClient();
    const transport = new RedisTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.xAddCalls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.xAddCalls).toHaveLength(2);
  });

  it("close() flushes a partial batch to the configured stream with '*' as the entry id", async () => {
    const client = fakeClient();
    const transport = new RedisTransport({ client, stream: "custom-stream", maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1" });
    await logger.flush();
    transport.close();

    expect(client.xAddCalls).toHaveLength(1);
    const [stream, id, fields] = client.xAddCalls[0] as [string, string, Record<string, string>];
    expect(stream).toBe("custom-stream");
    expect(id).toBe("*");
    expect(fields.message).toBe("only one");
    expect(fields.logger).toBe("app.test");
    expect(fields.level).toBe("INFO");
    expect(JSON.parse(fields.meta as string)).toEqual({ runId: "run-1" });
    expect(typeof fields.timestamp).toBe("string");
  });

  it("flushes once maxBytes is reached even below maxRecords", async () => {
    const client = fakeClient();
    const transport = new RedisTransport({ client, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    expect(client.xAddCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new RedisTransport({ client });

    transport.close();

    expect(client.xAddCalls).toHaveLength(0);
  });

  it("throws an actionable error when redis isn't installed and no client is given", async () => {
    const transport = new RedisTransport();
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
    expect(String(errorSpy[0]?.[1])).toContain("install `redis`");
  });
});
