import { describe, expect, it } from "vitest";
import { BaseQueueTransport, Logger, type LogRecord } from "../../../src/index.js";

/** Minimal concrete `BaseQueueTransport` for exercising the shared orchestration directly. */
class FakeQueueTransport extends BaseQueueTransport {
  readonly batches: (readonly LogRecord[])[] = [];

  protected publishBatch(records: readonly LogRecord[]): Promise<void> {
    this.batches.push(records);
    return Promise.resolve();
  }
}

describe("BaseQueueTransport", () => {
  it("never calls publishBatch for an empty buffer", () => {
    const transport = new FakeQueueTransport({ topic: "logs" });
    transport.close();
    expect(transport.batches).toHaveLength(0);
  });

  it("batches until maxRecords, never one publish per log call", async () => {
    const transport = new FakeQueueTransport({ topic: "logs", maxRecords: 3 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    logger.info("two");
    await logger.flush();
    expect(transport.batches).toHaveLength(0);

    logger.info("three");
    await logger.flush();
    expect(transport.batches).toHaveLength(1);
    expect(transport.batches[0]).toHaveLength(3);
  });

  it("close() flushes a partial batch", async () => {
    const transport = new FakeQueueTransport({ topic: "logs", maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(transport.batches).toHaveLength(1);
    expect(transport.batches[0]).toHaveLength(1);
  });

  it("exposes the topic option to subclasses", () => {
    const transport = new FakeQueueTransport({ topic: "my-queue" });
    expect(transport.topic).toBe("my-queue");
  });

  it("reports a failed publishBatch via console.error instead of throwing", async () => {
    class ThrowingQueueTransport extends BaseQueueTransport {
      protected publishBatch(): Promise<void> {
        return Promise.reject(new Error("boom"));
      }
    }
    const transport = new ThrowingQueueTransport({ topic: "logs" });
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    expect(() => {
      logger.info("hello");
    }).not.toThrow();

    await logger.flush();
    expect(() => {
      transport.close();
    }).not.toThrow();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        console.error = originalError;
        expect(errorSpy).toHaveLength(1);
        resolve();
      }, 10);
    });
  });
});
