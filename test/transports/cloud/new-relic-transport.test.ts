import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/index.js";
import {
  NewRelicTransport,
  type NewRelicSender,
  type NewRelicSenderResult,
} from "../../../src/transports/cloud/new-relic-transport.js";

interface RecordedCall {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

function fakeSender(
  result: NewRelicSenderResult = { ok: true, status: 202, retryAfter: null },
): NewRelicSender & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const sender = (url: string, headers: Readonly<Record<string, string>>, body: Buffer) => {
    calls.push({ url, headers, body });
    return result;
  };
  return Object.assign(sender, { calls });
}

function parseBody(body: Buffer): Record<string, unknown>[] {
  return JSON.parse(gunzipSync(body).toString("utf8")) as Record<string, unknown>[];
}

describe("NewRelicTransport", () => {
  it("defaults to the US region URL", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender });
    expect(transport.url).toBe("https://log-api.newrelic.com/log/v1");
  });

  it("uses the .eu. variant when region is EU", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", region: "EU", sender });
    expect(transport.url).toBe("https://log-api.eu.newrelic.com/log/v1");
  });

  it("sends the license key in the Api-Key header", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "my-license-key", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");

    expect(sender.calls[0]?.headers["Api-Key"]).toBe("my-license-key");
  });

  it("gzips the payload", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");

    expect(sender.calls[0]?.headers["Content-Encoding"]).toBe("gzip");
    const body = parseBody((sender.calls[0] as RecordedCall).body);
    expect(body).toHaveLength(1);
    expect(body[0]?.message).toBe("hello");
  });

  it("strips meta.eventType from the sent payload without mutating the original record", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    const record = logger.info("hello", { eventType: "reserved", other: "kept" });

    expect(record?.meta.eventType).toBe("reserved"); // original record left unmutated
    const sentMeta = parseBody((sender.calls[0] as RecordedCall).body)[0]?.meta as Record<string, unknown>;
    expect(sentMeta.eventType).toBeUndefined();
    expect(sentMeta.other).toBe("kept");
  });

  it("sends the record's ISO8601 timestamp as-is, no conversion", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    const record = logger.info("hello");

    const sent = parseBody((sender.calls[0] as RecordedCall).body)[0];
    expect(sent?.timestamp).toBe(record?.timestamp);
  });

  it("on a 429, pauses sends until Retry-After (seconds) elapses, using the injectable clock", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = 1_000_000;
    const clock = () => now;
    const sender = fakeSender({ ok: false, status: 429, retryAfter: "30" });
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1, clock });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first"); // triggers the 429, arms the pause
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(1);

    logger.info("second"); // still within the pause window — must not call the sender
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(1);

    now += 30_000; // resume time reached
    logger.info("third");
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it("on a 429, pauses sends until Retry-After (HTTP-date) elapses", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => now;
    const retryAfterDate = new Date(now + 45_000).toUTCString();
    const sender = fakeSender({ ok: false, status: 429, retryAfter: retryAfterDate });
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1, clock });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(1);

    now += 44_000;
    logger.info("second");
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(1); // still paused

    now += 2_000;
    logger.info("third");
    await new Promise((resolve) => setImmediate(resolve));
    expect(sender.calls).toHaveLength(2); // past the resume time
    errorSpy.mockRestore();
  });

  it("close() flushes a partial batch", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    transport.close();

    expect(sender.calls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const sender = fakeSender();
    const transport = new NewRelicTransport({ licenseKey: "lk", sender });

    transport.close();

    expect(sender.calls).toHaveLength(0);
  });

  it("reports a non-ok, non-429 response as a failed batch", async () => {
    const errorLog: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorLog.push(args);
    };
    const sender = fakeSender({ ok: false, status: 500, retryAfter: null });
    const transport = new NewRelicTransport({ licenseKey: "lk", sender, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await new Promise((resolve) => setImmediate(resolve));

    console.error = originalError;
    expect(errorLog).toHaveLength(1);
    expect(errorLog[0]?.[0]).toBe("NewRelicTransport: failed to send log batch");
  });
});
