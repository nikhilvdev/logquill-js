import { describe, expect, it } from "vitest";
import { Logger, RabbitMQTransport, type AmqpChannelLike } from "../../../src/index.js";

function fakeChannel(): AmqpChannelLike & {
  sentCalls: { queue: string; content: Buffer }[];
} {
  const sentCalls: { queue: string; content: Buffer }[] = [];
  return {
    sentCalls,
    sendToQueue(queue, content) {
      sentCalls.push({ queue, content });
      return true;
    },
  };
}

describe("RabbitMQTransport", () => {
  it("batches at the buffering level but sends one message per record", () => {
    const client = fakeChannel();
    const transport = new RabbitMQTransport({ topic: "app-logs", client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(client.sentCalls).toHaveLength(0);

    logger.info("two");
    expect(client.sentCalls).toHaveLength(2);
    expect(client.sentCalls[0]?.queue).toBe("app-logs");
    expect(JSON.parse(client.sentCalls[0]?.content.toString() ?? "{}")).toMatchObject({ message: "one" });
    expect(JSON.parse(client.sentCalls[1]?.content.toString() ?? "{}")).toMatchObject({ message: "two" });
  });

  it("close() flushes a partial batch", () => {
    const client = fakeChannel();
    const transport = new RabbitMQTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    transport.close();

    expect(client.sentCalls).toHaveLength(1);
  });

  it("handles a burst above maxRecords, sending every record across flushes", () => {
    const client = fakeChannel();
    const transport = new RabbitMQTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    for (let i = 0; i < 25; i++) {
      logger.info(`message ${String(i)}`);
    }
    transport.close();

    expect(client.sentCalls).toHaveLength(25);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeChannel();
    const transport = new RabbitMQTransport({ topic: "app-logs", client });

    transport.close();

    expect(client.sentCalls).toHaveLength(0);
  });

  it("throws an actionable error when amqplib isn't installed and no client is given", async () => {
    const transport = new RabbitMQTransport({ topic: "app-logs" });
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
    expect(String(errorSpy[0]?.[1])).toContain("install `amqplib`");
  });
});
