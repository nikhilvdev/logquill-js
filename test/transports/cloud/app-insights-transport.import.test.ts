import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { AppInsightsTransport } from "../../../src/transports/cloud/app-insights-transport.js";

const traces: { message: string; severity: number }[] = [];
let flushCalls = 0;
let constructedWith: string | undefined;

vi.mock("applicationinsights", () => ({
  TelemetryClient: class {
    constructor(connectionString?: string) {
      constructedWith = connectionString;
    }
    trackTrace(trace: { message: string; severity: number }) {
      traces.push(trace);
    }
    flush() {
      flushCalls++;
    }
  },
}));

describe("AppInsightsTransport (auto-imported `applicationinsights` driver)", () => {
  it("builds a real TelemetryClient, tracks each trace, and flushes once per batch when no client is injected", async () => {
    const transport = new AppInsightsTransport({ connectionString: "InstrumentationKey=abc" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedWith).toBe("InstrumentationKey=abc");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.message).toContain("hello");
    expect(traces[0]?.severity).toBe(1);
    expect(flushCalls).toBe(1);
  });
});
