import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { CloudLoggingTransport } from "../../../src/transports/cloud/cloud-logging-transport.js";

const writeCalls: unknown[][] = [];
let constructedProjectId: string | undefined;
let loggedName: string | undefined;

vi.mock("@google-cloud/logging", () => ({
  Logging: class {
    constructor(options?: { projectId?: string }) {
      constructedProjectId = options?.projectId;
    }
    log(name: string) {
      loggedName = name;
      return {
        write: (entries: unknown[]) => {
          writeCalls.push(entries);
          return Promise.resolve();
        },
      };
    }
  },
}));

describe("CloudLoggingTransport (auto-imported `@google-cloud/logging` driver)", () => {
  it("builds a real Logging client, resolves the log by name, and writes entries when no client is injected", async () => {
    const transport = new CloudLoggingTransport({ projectId: "my-project", logName: "custom-log" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedProjectId).toBe("my-project");
    expect(loggedName).toBe("custom-log");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toHaveLength(1);
  });
});
