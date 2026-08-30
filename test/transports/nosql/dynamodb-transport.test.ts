import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { DynamoDBTransport, type DynamoClientLike, type DynamoLogItem } from "../../../src/transports/nosql/dynamodb-transport.js";

function fakeClient(): DynamoClientLike & { calls: { tableName: string; items: readonly DynamoLogItem[] }[] } {
  const calls: { tableName: string; items: readonly DynamoLogItem[] }[] = [];
  return {
    calls,
    batchWriteItems(tableName: string, items: readonly DynamoLogItem[]) {
      calls.push({ tableName, items });
      return Promise.resolve({ UnprocessedItems: {} });
    },
  };
}

describe("DynamoDBTransport", () => {
  it("batches writes until maxRecords is reached", () => {
    const client = fakeClient();
    const transport = new DynamoDBTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(client.calls).toHaveLength(0);

    logger.info("two");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.items).toHaveLength(2);
  });

  it("close() flushes a partial batch, writing to the configured table with timestamp as sort key", () => {
    const client = fakeClient();
    const transport = new DynamoDBTransport({ client, tableName: "custom-logs", maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1", spanId: "span-1" });
    transport.close();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.tableName).toBe("custom-logs");
    const [item] = client.calls[0]?.items as [DynamoLogItem];
    expect(item.runId).toBe("run-1");
    expect(item.spanId).toBe("span-1");
    expect(item.message).toBe("only one");
    expect(item.logger).toBe("app.test");
    expect(typeof item.timestamp).toBe("string");
  });

  it("falls back to traceId, then the logger name, for the partition key when runId is absent", () => {
    const client = fakeClient();
    const transport = new DynamoDBTransport({ client });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("has trace only", { traceId: "trace-1" });
    logger.info("has neither");
    transport.close();

    const items = client.calls[0]?.items as DynamoLogItem[];
    expect(items[0]?.runId).toBe("trace-1");
    expect(items[1]?.runId).toBe("app.test");
  });

  it("chunks a batch of 30 records into two BatchWriteItem-equivalent calls of 25 and 5", () => {
    const client = fakeClient();
    const transport = new DynamoDBTransport({ client, maxRecords: 1000 });
    const logger = new Logger("app.test", { transports: [transport] });

    for (let i = 0; i < 30; i++) {
      logger.info(`record ${String(i)}`);
    }
    transport.close();

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.items).toHaveLength(25);
    expect(client.calls[1]?.items).toHaveLength(5);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new DynamoDBTransport({ client });

    transport.close();

    expect(client.calls).toHaveLength(0);
  });

  it("throws an actionable error when @aws-sdk/client-dynamodb isn't installed and no client is given", async () => {
    const transport = new DynamoDBTransport();
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
    expect(String(errorSpy[0]?.[1])).toContain("install `@aws-sdk/client-dynamodb`");
  });
});
