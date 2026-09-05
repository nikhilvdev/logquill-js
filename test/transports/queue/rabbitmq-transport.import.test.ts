import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { RabbitMQTransport } from "../../../src/transports/queue/rabbitmq-transport.js";

const sendToQueueCalls: { queue: string; content: Buffer }[] = [];
const assertQueueCalls: string[] = [];
let connectedUrl: string | undefined;

vi.mock("amqplib", () => ({
  connect: (url: string) => {
    connectedUrl = url;
    return Promise.resolve({
      createChannel: () =>
        Promise.resolve({
          assertQueue: (queue: string) => {
            assertQueueCalls.push(queue);
            return Promise.resolve();
          },
          sendToQueue: (queue: string, content: Buffer) => {
            sendToQueueCalls.push({ queue, content });
            return true;
          },
        }),
    });
  },
}));

describe("RabbitMQTransport (auto-imported `amqplib` driver)", () => {
  it("connects, opens a channel, asserts the queue, and sends through it when no client is injected", async () => {
    const transport = new RabbitMQTransport({ topic: "my-queue", url: "amqp://example" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connectedUrl).toBe("amqp://example");
    expect(assertQueueCalls).toEqual(["my-queue"]);
    expect(sendToQueueCalls).toHaveLength(1);
    expect(sendToQueueCalls[0]?.queue).toBe("my-queue");
    expect(JSON.parse(sendToQueueCalls[0]?.content.toString() ?? "{}")).toMatchObject({
      message: "hello",
    });
  });
});
