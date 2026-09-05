import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { KafkaTransport } from "../../../src/transports/queue/kafka-transport.js";

const sendCalls: { topic: string; messages: unknown[] }[] = [];
let constructedBrokers: string[] | undefined;
let connectCalls = 0;

vi.mock("kafkajs", () => ({
  Kafka: class {
    constructor(config: { brokers: string[] }) {
      constructedBrokers = config.brokers;
    }
    producer() {
      return {
        connect: () => {
          connectCalls++;
          return Promise.resolve();
        },
        send: (record: { topic: string; messages: unknown[] }) => {
          sendCalls.push(record);
          return Promise.resolve();
        },
      };
    }
  },
}));

describe("KafkaTransport (auto-imported `kafkajs` driver)", () => {
  it("builds a real Kafka producer, connects it, and sends through it when no client is injected", async () => {
    const transport = new KafkaTransport({ topic: "my-topic", brokers: ["broker-1:9092"] });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { runId: "run-1" });
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedBrokers).toEqual(["broker-1:9092"]);
    expect(connectCalls).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.topic).toBe("my-topic");
    expect(sendCalls[0]?.messages).toHaveLength(1);
  });
});
