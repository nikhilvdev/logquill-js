import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/index.js";
import { CloudWatchTransport, type CloudWatchClientLike, type CloudWatchLogEvent } from "../../../src/transports/cloud/cloudwatch-transport.js";

function fakeClient(): CloudWatchClientLike & {
  calls: { logGroupName: string; logStreamName: string; events: readonly CloudWatchLogEvent[] }[];
} {
  const calls: { logGroupName: string; logStreamName: string; events: readonly CloudWatchLogEvent[] }[] = [];
  return {
    calls,
    putLogEvents(logGroupName, logStreamName, events) {
      calls.push({ logGroupName, logStreamName, events });
      return Promise.resolve(undefined);
    },
  };
}

describe("CloudWatchTransport", () => {
  it("batches writes until maxRecords is reached", async () => {
    const client = fakeClient();
    const transport = new CloudWatchTransport({
      client,
      logGroupName: "my-group",
      logStreamName: "my-stream",
      maxRecords: 2,
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.logGroupName).toBe("my-group");
    expect(client.calls[0]?.logStreamName).toBe("my-stream");
    expect(client.calls[0]?.events).toHaveLength(2);
  });

  it("sorts events by timestamp ascending before sending", async () => {
    const client = fakeClient();
    const transport = new CloudWatchTransport({
      client,
      logGroupName: "g",
      logStreamName: "s",
      maxRecords: 3,
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("c");
    logger.info("b");
    logger.info("a");
    await logger.flush();

    const events = client.calls[0]?.events ?? [];
    expect(events).toHaveLength(3);
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    expect(events).toEqual(sorted);
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new CloudWatchTransport({ client, logGroupName: "g", logStreamName: "s", maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.events[0]?.message).toContain("only one");
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new CloudWatchTransport({ client, logGroupName: "g", logStreamName: "s" });

    transport.close();

    expect(client.calls).toHaveLength(0);
  });

  it("throws an actionable error when the AWS SDK isn't installed and no client is given", async () => {
    const transport = new CloudWatchTransport({ logGroupName: "g", logStreamName: "s" });
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
    expect(String(errorSpy[0]?.[1])).toContain("install `@aws-sdk/client-cloudwatch-logs`");
  });
});
