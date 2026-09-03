import { describe, expect, it, vi, afterEach } from "vitest";
import { Logger } from "../../../src/index.js";
import { DatadogTransport, type DatadogSender } from "../../../src/transports/cloud/datadog-transport.js";

function fakeSender(): DatadogSender & { calls: [string, string, readonly string[]][] } {
  const calls: [string, string, readonly string[]][] = [];
  const sender = (url: string, apiKey: string, batch: readonly string[]) => {
    calls.push([url, apiKey, batch]);
  };
  return Object.assign(sender, { calls });
}

describe("DatadogTransport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the intake URL from the configured site, defaulting to datadoghq.com", () => {
    const sender = fakeSender();
    const transport = new DatadogTransport({ apiKey: "key123", sender });
    expect(transport.url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");

    const euSender = fakeSender();
    const euTransport = new DatadogTransport({ apiKey: "key123", site: "datadoghq.eu", sender: euSender });
    expect(euTransport.url).toBe("https://http-intake.logs.datadoghq.eu/api/v2/logs");
  });

  it("batches writes until maxRecords is reached, passing the API key to the sender", async () => {
    const sender = fakeSender();
    const transport = new DatadogTransport({ apiKey: "key123", sender, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(sender.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(sender.calls).toHaveLength(1);
    const [url, apiKey, batch] = sender.calls[0] as [string, string, readonly string[]];
    expect(url).toBe(transport.url);
    expect(apiKey).toBe("key123");
    expect(batch).toHaveLength(2);
  });

  it("close() flushes a partial batch", async () => {
    const sender = fakeSender();
    const transport = new DatadogTransport({ apiKey: "key123", sender, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.[2]).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const sender = fakeSender();
    const transport = new DatadogTransport({ apiKey: "key123", sender });

    transport.close();

    expect(sender.calls).toHaveLength(0);
  });

  it("defaults to POSTing a JSON array via fetch, with the DD-API-KEY header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    globalThis.fetch = fetchMock;

    const transport = new DatadogTransport({ apiKey: "key123", maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
    expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe("key123");
    const body = JSON.parse(init.body as string) as unknown[];
    expect(body).toHaveLength(1);
  });

  it("reports a non-ok response from the default sender", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));

    const transport = new DatadogTransport({ apiKey: "bad-key", maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "DatadogTransport: failed to send log batch",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
