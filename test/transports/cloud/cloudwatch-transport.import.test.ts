import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { CloudWatchTransport } from "../../../src/transports/cloud/cloudwatch-transport.js";

const sentCommands: unknown[] = [];
let constructedRegion: string | undefined;

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    constructor(config: { region?: string }) {
      constructedRegion = config.region;
    }
    send(command: unknown) {
      sentCommands.push(command);
      return Promise.resolve();
    }
  },
  PutLogEventsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe("CloudWatchTransport (auto-imported `@aws-sdk/client-cloudwatch-logs` driver)", () => {
  it("builds a real CloudWatchLogsClient and sends a PutLogEventsCommand when no client is injected", async () => {
    const transport = new CloudWatchTransport({
      logGroupName: "my-group",
      logStreamName: "my-stream",
      region: "us-east-1",
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedRegion).toBe("us-east-1");
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      input: { logGroupName: "my-group", logStreamName: "my-stream" },
    });
  });
});
