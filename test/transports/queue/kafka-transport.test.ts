import { describe, expect, it } from "vitest";
import { KafkaTransport, Logger, type KafkaProducerLike } from "../../../src/index.js";

function fakeProducer(): KafkaProducerLike & {
  sendCalls: { topic: string; messages: { key: string | null; value: string }[] }[];
} {
  const sendCalls: { topic: string; messages: { key: string | null; value: string }[] }[] = [];
  return {
    sendCalls,
    send(record) {
      sendCalls.push(record);
      return Promise.resolve();
    },
  };
}

describe("KafkaTransport", () => {
  it("batches messages until maxRecords is reached", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(client.sendCalls).toHaveLength(0);

    logger.info("two");
    expect(client.sendCalls).toHaveLength(1);
    expect(client.sendCalls[0]?.topic).toBe("app-logs");
    expect(client.sendCalls[0]?.messages).toHaveLength(2);
  });

  it("keys messages by meta.runId so same-run messages land on one partition", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("step", { runId: "run-42", traceId: "trace-99" });

    expect(client.sendCalls[0]?.messages[0]?.key).toBe("run-42");
  });

  it("falls back to meta.traceId when meta.runId is absent", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("step", { traceId: "trace-99" });

    expect(client.sendCalls[0]?.messages[0]?.key).toBe("trace-99");
  });

  it("keys with null when neither runId nor traceId is present", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("step");

    expect(client.sendCalls[0]?.messages[0]?.key).toBeNull();
  });

  it("close() flushes a partial batch", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    transport.close();

    expect(client.sendCalls).toHaveLength(1);
    expect(client.sendCalls[0]?.messages).toHaveLength(1);
  });

  it("handles a burst above maxRecords in multiple correctly-sized batches", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    for (let i = 0; i < 25; i++) {
      logger.info(`message ${String(i)}`);
    }
    transport.close();

    expect(client.sendCalls).toHaveLength(3);
    expect(client.sendCalls[0]?.messages).toHaveLength(10);
    expect(client.sendCalls[1]?.messages).toHaveLength(10);
    expect(client.sendCalls[2]?.messages).toHaveLength(5);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeProducer();
    const transport = new KafkaTransport({ topic: "app-logs", client });

    transport.close();

    expect(client.sendCalls).toHaveLength(0);
  });

  it("throws an actionable error when kafkajs isn't installed and no client is given", async () => {
    const transport = new KafkaTransport({ topic: "app-logs" });
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
    expect(String(errorSpy[0]?.[1])).toContain("install `kafkajs`");
  });
});
