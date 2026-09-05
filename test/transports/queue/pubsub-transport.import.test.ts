import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { PubSubTransport } from "../../../src/transports/queue/pubsub-transport.js";

const publishCalls: { data: Buffer }[] = [];
let constructedProjectId: string | undefined;
let topicName: string | undefined;

vi.mock("@google-cloud/pubsub", () => ({
  PubSub: class {
    constructor(config: { projectId?: string }) {
      constructedProjectId = config.projectId;
    }
    topic(name: string) {
      topicName = name;
      return {
        publishMessage: (message: { data: Buffer }) => {
          publishCalls.push(message);
          return Promise.resolve("message-id");
        },
      };
    }
  },
}));

describe("PubSubTransport (auto-imported `@google-cloud/pubsub` driver)", () => {
  it("builds a real PubSub topic and publishes through it when no client is injected", async () => {
    const transport = new PubSubTransport({ topic: "my-topic", projectId: "my-project" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedProjectId).toBe("my-project");
    expect(topicName).toBe("my-topic");
    expect(publishCalls).toHaveLength(1);
    expect(JSON.parse(publishCalls[0]?.data.toString() ?? "{}")).toMatchObject({
      message: "hello",
    });
  });
});
