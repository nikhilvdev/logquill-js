import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { SQSTransport } from "../../../src/transports/queue/sqs-transport.js";

const sentCommands: unknown[] = [];
let constructedRegion: string | undefined;

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    constructor(config: { region?: string }) {
      constructedRegion = config.region;
    }
    send(command: unknown) {
      sentCommands.push(command);
      return Promise.resolve();
    }
  },
  SendMessageBatchCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe("SQSTransport (auto-imported `@aws-sdk/client-sqs` driver)", () => {
  it("builds a real SQSClient and sends a SendMessageBatchCommand when no client is injected", async () => {
    const transport = new SQSTransport({
      topic: "https://sqs.example/my-queue",
      region: "eu-west-1",
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedRegion).toBe("eu-west-1");
    expect(sentCommands).toHaveLength(1);
    const command = sentCommands[0] as { input: { QueueUrl: string; Entries: unknown[] } };
    expect(command.input.QueueUrl).toBe("https://sqs.example/my-queue");
    expect(command.input.Entries).toHaveLength(1);
  });
});
