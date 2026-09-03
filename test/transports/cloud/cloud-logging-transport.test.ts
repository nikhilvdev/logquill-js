import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/index.js";
import {
  CloudLoggingTransport,
  type CloudLoggingClientLike,
  type CloudLoggingEntry,
} from "../../../src/transports/cloud/cloud-logging-transport.js";

function fakeClient(): CloudLoggingClientLike & { calls: (readonly CloudLoggingEntry[])[] } {
  const calls: (readonly CloudLoggingEntry[])[] = [];
  return {
    calls,
    writeLogEntries(entries) {
      calls.push(entries);
      return Promise.resolve(undefined);
    },
  };
}

describe("CloudLoggingTransport", () => {
  it("batches writes until maxRecords is reached", async () => {
    const client = fakeClient();
    const transport = new CloudLoggingTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toHaveLength(2);
  });

  it("maps levels onto GCP severities", async () => {
    const client = fakeClient();
    const transport = new CloudLoggingTransport({ client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport], level: "TRACE" });

    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    await logger.flush();

    const severities = client.calls.map((entries) => entries[0]?.severity);
    expect(severities).toEqual(["DEBUG", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
  });

  it("puts the formatted record into jsonPayload", async () => {
    const client = fakeClient();
    const transport = new CloudLoggingTransport({ client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { foo: "bar" });
    await logger.flush();

    const entry = client.calls[0]?.[0];
    expect(entry?.jsonPayload.message).toBe("hello");
    expect((entry?.jsonPayload.meta as { foo: string }).foo).toBe("bar");
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new CloudLoggingTransport({ client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(client.calls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new CloudLoggingTransport({ client });

    transport.close();

    expect(client.calls).toHaveLength(0);
  });

  it("throws an actionable error when the GCP SDK isn't installed and no client is given", async () => {
    const transport = new CloudLoggingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    await logger.flush();
    transport.close();
    // The failing dynamic import resolves via real filesystem I/O, not just a
    // microtask, so give it real time rather than a single setImmediate tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `@google-cloud/logging`");
  });
});
