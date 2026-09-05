import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { DynamoDBTransport } from "../../../src/transports/nosql/dynamodb-transport.js";

const sentCommands: unknown[] = [];
let constructedConfig: unknown;

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    constructor(config: unknown) {
      constructedConfig = config;
    }
    send(command: unknown) {
      sentCommands.push(command);
      return Promise.resolve();
    }
  },
  BatchWriteItemCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe("DynamoDBTransport (auto-imported `@aws-sdk/client-dynamodb` driver)", () => {
  it("builds a real DynamoDBClient and sends a BatchWriteItemCommand when no client is injected", async () => {
    const transport = new DynamoDBTransport({ tableName: "my-table", region: "us-west-2" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { runId: "run-1" });
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedConfig).toEqual({ region: "us-west-2" });
    expect(sentCommands).toHaveLength(1);
    const command = sentCommands[0] as { input: { RequestItems: Record<string, unknown[]> } };
    expect(Object.keys(command.input.RequestItems)).toEqual(["my-table"]);
    expect(command.input.RequestItems["my-table"]).toHaveLength(1);
  });

  it("marshals every meta value type onto its correct DynamoDB AttributeValue shape", async () => {
    const transport = new DynamoDBTransport({ tableName: "my-table", region: "us-west-2" });
    const logger = new Logger("app.test2", { transports: [transport] });

    logger.info("hello", {
      runId: "run-2",
      aNull: null,
      aNumber: 42,
      aBool: true,
      anArray: [1, "two", false],
      anObject: { nested: "value" },
      aFunction: () => undefined,
    });
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const command = sentCommands[sentCommands.length - 1] as {
      input: {
        RequestItems: Record<
          string,
          { PutRequest: { Item: { meta: { M: Record<string, unknown> } } } }[]
        >;
      };
    };
    const meta = command.input.RequestItems["my-table"]?.[0]?.PutRequest.Item.meta.M;
    expect(meta?.aNull).toEqual({ NULL: true });
    expect(meta?.aNumber).toEqual({ N: "42" });
    expect(meta?.aBool).toEqual({ BOOL: true });
    expect(meta?.anArray).toEqual({ L: [{ N: "1" }, { S: "two" }, { BOOL: false }] });
    expect(meta?.anObject).toEqual({ M: { nested: { S: "value" } } });
    expect(meta?.aFunction).toEqual({ NULL: true });
  });
});
