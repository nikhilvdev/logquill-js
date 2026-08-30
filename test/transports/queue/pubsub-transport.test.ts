import { describe, expect, it } from "vitest";
import { Logger, PubSubTransport, type PubSubTopicLike } from "../../../src/index.js";

function fakeTopic(): PubSubTopicLike & { publishCalls: Buffer[] } {
  const publishCalls: Buffer[] = [];
  return {
    publishCalls,
    publishMessage(message) {
      publishCalls.push(message.data);
      return Promise.resolve("message-id");
    },
  };
}

describe("PubSubTransport", () => {
  it("batches at the buffering level but publishes one message per record", () => {
    const client = fakeTopic();
    const transport = new PubSubTransport({ topic: "app-logs", client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(client.publishCalls).toHaveLength(0);

    logger.info("two");
    expect(client.publishCalls).toHaveLength(2);
    expect(JSON.parse(client.publishCalls[0]?.toString() ?? "{}")).toMatchObject({ message: "one" });
    expect(JSON.parse(client.publishCalls[1]?.toString() ?? "{}")).toMatchObject({ message: "two" });
  });

  it("close() flushes a partial batch", () => {
    const client = fakeTopic();
    const transport = new PubSubTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    transport.close();

    expect(client.publishCalls).toHaveLength(1);
  });

  it("handles a burst above maxRecords, publishing every record across flushes", () => {
    const client = fakeTopic();
    const transport = new PubSubTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    for (let i = 0; i < 25; i++) {
      logger.info(`message ${String(i)}`);
    }
    transport.close();

    expect(client.publishCalls).toHaveLength(25);
  });

  it("flushes once maxBytes is reached even below maxRecords", () => {
    const client = fakeTopic();
    const transport = new PubSubTransport({ topic: "app-logs", client, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    expect(client.publishCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeTopic();
    const transport = new PubSubTransport({ topic: "app-logs", client });

    transport.close();

    expect(client.publishCalls).toHaveLength(0);
  });

  it("throws an actionable error when @google-cloud/pubsub isn't installed and no client is given", async () => {
    const transport = new PubSubTransport({ topic: "app-logs" });
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `@google-cloud/pubsub`");
  });
});
