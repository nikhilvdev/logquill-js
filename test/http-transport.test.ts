import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPTransport, Logger, type Sender } from "../src/index.js";

function fakeSender(): Sender & { calls: [string, readonly string[]][] } {
  const calls: [string, readonly string[]][] = [];
  const sender = (url: string, batch: readonly string[]) => {
    calls.push([url, batch]);
  };
  return Object.assign(sender, { calls });
}

describe("HTTPTransport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("defaults to POSTing newline-delimited JSON via fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    const transport = new HTTPTransport("https://example.com/logs", { batchSize: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/logs");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("hello");
  });

  it("reports a non-ok response from the default sender", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const transport = new HTTPTransport("https://example.com/logs", { batchSize: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "HTTPTransport: failed to send log batch",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });


  it("batches writes until batchSize is reached", () => {
    const sender = fakeSender();
    const transport = new HTTPTransport("https://example.com/logs", { batchSize: 2, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(sender.calls).toHaveLength(0);

    logger.info("two");
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.[1]).toHaveLength(2);
  });

  it("close() flushes a partial batch", () => {
    const sender = fakeSender();
    const transport = new HTTPTransport("https://example.com/logs", { batchSize: 10, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    transport.close();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.[1]).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const sender = fakeSender();
    const transport = new HTTPTransport("https://example.com/logs", { sender });

    transport.close();

    expect(sender.calls).toHaveLength(0);
  });

  it("reports an async sender rejection instead of crashing the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender: Sender = () => Promise.reject(new Error("network down"));
    const transport = new HTTPTransport("https://example.com/logs", { batchSize: 1, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    expect(() => logger.info("one")).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "HTTPTransport: failed to send log batch",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
