import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/index.js";
import {
  AppInsightsTransport,
  type AppInsightsClientLike,
  type AppInsightsTrace,
} from "../../../src/transports/cloud/app-insights-transport.js";

function fakeClient(): AppInsightsClientLike & { calls: (readonly AppInsightsTrace[])[] } {
  const calls: (readonly AppInsightsTrace[])[] = [];
  return {
    calls,
    trackTraceBatch(traces) {
      calls.push(traces);
      return Promise.resolve(undefined);
    },
  };
}

describe("AppInsightsTransport", () => {
  it("batches writes until maxRecords is reached", async () => {
    const client = fakeClient();
    const transport = new AppInsightsTransport({ client, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    await logger.flush();
    expect(client.calls).toHaveLength(0);

    logger.info("two");
    await logger.flush();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toHaveLength(2);
  });

  it("loops one trace per record within a single sendBatch call, mapped to SeverityLevel", async () => {
    const client = fakeClient();
    const transport = new AppInsightsTransport({ client, maxRecords: 1 });
    const logger = new Logger("app.test", { transports: [transport], level: "TRACE" });

    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    await logger.flush();

    const severities = client.calls.map((traces) => traces[0]?.severity);
    expect(severities).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it("close() flushes a partial batch", async () => {
    const client = fakeClient();
    const transport = new AppInsightsTransport({ client, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one");
    await logger.flush();
    transport.close();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.[0]?.message).toContain("only one");
  });

  it("close() on an empty batch sends nothing", () => {
    const client = fakeClient();
    const transport = new AppInsightsTransport({ client });

    transport.close();

    expect(client.calls).toHaveLength(0);
  });

  it("throws an actionable error when the Application Insights SDK isn't installed and no client is given", async () => {
    const transport = new AppInsightsTransport();
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
    expect(String(errorSpy[0]?.[1])).toContain("install `applicationinsights`");
  });
});
