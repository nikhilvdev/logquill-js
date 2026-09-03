import { describe, expect, it } from "vitest";
import { Logger, SQSTransport, type SQSClientLike } from "../../../src/index.js";

function fakeClient(): SQSClientLike & { batchCalls: { queueUrl: string; entries: { id: string; body: string }[] }[] } {
  const batchCalls: { queueUrl: string; entries: { id: string; body: string }[] }[] = [];
  return {
    batchCalls,
    sendMessageBatch(queueUrl, entries) {
      batchCalls.push({ queueUrl, entries });
      return Promise.resolve();
    },
  };
}

describe("SQSTransport", () => {
  it("batches until maxRecords is reached, sending a single sendMessageBatch call", async () => {
    const client = fakeClient();
    const transport = new SQSTransport({ topic: "https://sqs.example/queue", client, maxRecords: 3 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    logger.info("two");
    await logger.flush();
    expect(client.batchCalls).toHaveLength(0);

    logger.info("three");
    await logger.flush();
    expect(client.batchCalls).toHaveLength(1);
    expect(client.batchCalls[0]?.entries).toHaveLength(3);
    expect(client.batchCalls[0]?.queueUrl).toBe("https://sqs.example/queue");
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new SQSTransport({ topic: "https://sqs.example/queue", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(client.batchCalls).toHaveLength(1);
    expect(client.batchCalls[0]?.entries).toHaveLength(1);
  });

  it("chunks a batch of 25 records into three SendMessageBatch calls of 10, 10, and 5", async () => {
    const client = fakeClient();
    const transport = new SQSTransport({ topic: "https://sqs.example/queue", client, maxRecords: 25 });
    const logger = new Logger("app.test", { transports: [transport] });

    for (let i = 0; i < 25; i++) {
      logger.info(`message ${String(i)}`);
    }
    await logger.flush();

    expect(client.batchCalls).toHaveLength(3);
    expect(client.batchCalls[0]?.entries).toHaveLength(10);
    expect(client.batchCalls[1]?.entries).toHaveLength(10);
    expect(client.batchCalls[2]?.entries).toHaveLength(5);
    // Total records across the three sub-batches still equals the full burst.
    const total = client.batchCalls.reduce((sum, call) => sum + call.entries.length, 0);
    expect(total).toBe(25);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new SQSTransport({ topic: "https://sqs.example/queue", client });

    transport.close();

    expect(client.batchCalls).toHaveLength(0);
  });

  it("throws an actionable error when @aws-sdk/client-sqs isn't installed and no client is given", async () => {
    const transport = new SQSTransport({ topic: "https://sqs.example/queue" });
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `@aws-sdk/client-sqs`");
  });
});
