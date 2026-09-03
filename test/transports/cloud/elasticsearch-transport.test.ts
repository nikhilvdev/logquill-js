import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/index.js";
import { ElasticsearchTransport, type ElasticsearchSender } from "../../../src/transports/cloud/elasticsearch-transport.js";

function fakeSender(): ElasticsearchSender & {
  calls: [string, Readonly<Record<string, string>>, string][];
} {
  const calls: [string, Readonly<Record<string, string>>, string][] = [];
  const sender = (url: string, headers: Readonly<Record<string, string>>, body: string) => {
    calls.push([url, headers, body]);
  };
  return Object.assign(sender, { calls });
}

describe("ElasticsearchTransport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the bulk URL from node, trimming a trailing slash", () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({ node: "https://localhost:9200/", sender });
    expect(transport.url).toBe("https://localhost:9200/_bulk");
  });

  it("batches writes until maxRecords is reached, as NDJSON action+source pairs", async () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", sender, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(sender.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(sender.calls).toHaveLength(1);
    const [url, , body] = sender.calls[0] as [string, Readonly<Record<string, string>>, string];
    expect(url).toBe(transport.url);
    const lines = body.trimEnd().split("\n") as [string, string, string, string];
    expect(lines).toHaveLength(4); // 2 action lines + 2 source lines
    expect(JSON.parse(lines[0])).toEqual({ index: { _index: "logs" } });
    expect(JSON.parse(lines[1])).toMatchObject({ message: "one" });
    expect(JSON.parse(lines[2])).toEqual({ index: { _index: "logs" } });
    expect(JSON.parse(lines[3])).toMatchObject({ message: "two" });
  });

  it("uses a custom index and sets the ApiKey Authorization header when apiKey is given", async () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({
      node: "https://localhost:9200",
      index: "custom-logs",
      apiKey: "abc123",
      sender,
      maxRecords: 1,
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();

    const [, headers, body] = sender.calls[0] as [string, Readonly<Record<string, string>>, string];
    expect(headers.Authorization).toBe("ApiKey abc123");
    expect(body).toContain('"custom-logs"');
  });

  it("omits the Authorization header when no apiKey is given", async () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();

    expect(sender.calls[0]?.[1].Authorization).toBeUndefined();
  });

  it("close() flushes a partial batch", async () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", sender, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(sender.calls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const sender = fakeSender();
    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", sender });

    transport.close();

    expect(sender.calls).toHaveLength(0);
  });

  it("defaults to POSTing NDJSON via fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://localhost:9200/_bulk");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-ndjson");
  });

  it("reports a non-ok response from the default sender", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const transport = new ElasticsearchTransport({ node: "https://localhost:9200", maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "ElasticsearchTransport: failed to send log batch",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
