import { describe, expect, it } from "vitest";
import {
  BatchingTransport,
  CollectingTransport,
  Logger,
  withAzureFunction,
  withCloudFunction,
  withFlush,
  withLambda,
  type LogRecord,
} from "../../src/index.js";

/** A batching transport that never reaches its own threshold on its own — only close()/flush() sends it. */
class RecordingBatchTransport extends BatchingTransport {
  readonly sent: LogRecord[][] = [];

  constructor() {
    super({ maxRecords: 1_000_000 });
  }

  protected sendBatch(batch: readonly LogRecord[]): void {
    this.sent.push([...batch]);
  }
}

describe("withLambda / withFlush", () => {
  it("awaits logger.flush() before the wrapped handler's return value resolves", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    const handler = withLambda(logger, (event: { id: string }) => {
      logger.info("handling", { id: event.id });
      // the write is still queued at this point — flush hasn't run yet
      return Promise.resolve({ statusCode: 200 });
    });

    const result = await handler({ id: "req-1" });

    expect(result).toEqual({ statusCode: 200 });
    expect(transport.records).toHaveLength(1); // flushed before handler() settled
  });

  it("still flushes when the handler throws, then rethrows", async () => {
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    const handler = withLambda(logger, () => {
      logger.error("about to blow up");
      return Promise.reject(new Error("boom"));
    });

    await expect(handler()).rejects.toThrow("boom");
    expect(transport.records).toHaveLength(1);
  });

  it("forces a batching transport to send its buffer even under its own threshold", async () => {
    const transport = new RecordingBatchTransport();
    const logger = new Logger("app.test", { transports: [transport] });

    const handler = withLambda(logger, () => {
      logger.info("only one — nowhere near maxRecords");
      return Promise.resolve("ok");
    });

    await handler();

    // Without withLambda's extra transport.flush() pass, this would still be
    // sitting in the transport's own buffer, waiting for a threshold that a
    // single-invocation Lambda will never reach on its own.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toHaveLength(1);
  });

  it("withCloudFunction and withAzureFunction are the same wrapper under platform-matching names", () => {
    expect(withCloudFunction).toBe(withFlush);
    expect(withAzureFunction).toBe(withFlush);
    expect(withLambda).toBe(withFlush);
  });

  it("passes arguments through to the wrapped function unchanged", async () => {
    const logger = new Logger("app.test");
    const handler = withLambda(logger, (a: number, b: number) => Promise.resolve(a + b));

    await expect(handler(2, 3)).resolves.toBe(5);
  });
});
