import { afterEach, describe, expect, it, vi } from "vitest";
import { BeaconTransport, Logger, type BeaconSender } from "../../src/index.js";

function fakeSender(): BeaconSender & { calls: [string, readonly string[]][] } {
  const calls: [string, readonly string[]][] = [];
  const sender = (url: string, batch: readonly string[]) => {
    calls.push([url, batch]);
  };
  return Object.assign(sender, { calls });
}

describe("BeaconTransport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("prefers navigator.sendBeacon when available", async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon });

    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await logger.flush();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0] as [string, string];
    expect(url).toBe("https://example.com/logs");
    expect(body).toContain("hello");
  });

  it("falls back to a keepalive fetch without navigator.sendBeacon", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await logger.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/logs");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.body).toContain("hello");
  });

  it("reports a rejected fallback fetch instead of crashing the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith("BeaconTransport: failed to send log batch", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("batches writes until batchSize is reached", async () => {
    const sender = fakeSender();
    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 2, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(sender.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.[1]).toHaveLength(2);
  });

  it("close() flushes a partial batch", async () => {
    const sender = fakeSender();
    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 10, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.[1]).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const sender = fakeSender();
    const transport = new BeaconTransport("https://example.com/logs", { sender });

    transport.close();

    expect(sender.calls).toHaveLength(0);
  });

  it("reports a throwing sender instead of crashing the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sender: BeaconSender = () => {
      throw new Error("boom");
    };
    const transport = new BeaconTransport("https://example.com/logs", { batchSize: 1, sender });
    const logger = new Logger("app.test", { transports: [transport] });

    expect(() => logger.info("one")).not.toThrow();
    await logger.flush();

    expect(errorSpy).toHaveBeenCalledWith("BeaconTransport: failed to send log batch", expect.any(Error));
    errorSpy.mockRestore();
  });
});
