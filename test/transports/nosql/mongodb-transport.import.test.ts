import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { MongoDBTransport } from "../../../src/transports/nosql/mongodb-transport.js";

const insertManyCalls: unknown[][] = [];
let constructedConnectionString: string | undefined;
let connectCalls = 0;
let dbName: string | undefined;
let collectionName: string | undefined;

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(connectionString: string) {
      constructedConnectionString = connectionString;
    }
    connect() {
      connectCalls++;
      return Promise.resolve();
    }
    db(name: string) {
      dbName = name;
      return {
        collection: (name: string) => {
          collectionName = name;
          return {
            insertMany: (docs: unknown[]) => {
              insertManyCalls.push(docs);
              return Promise.resolve();
            },
          };
        },
      };
    }
  },
}));

describe("MongoDBTransport (auto-imported `mongodb` driver)", () => {
  it("builds a real MongoClient, connects, resolves the collection, and inserts documents when none is injected", async () => {
    const transport = new MongoDBTransport({
      connectionString: "mongodb://example/db",
      database: "custom-db",
      collectionName: "custom-collection",
    });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedConnectionString).toBe("mongodb://example/db");
    expect(connectCalls).toBe(1);
    expect(dbName).toBe("custom-db");
    expect(collectionName).toBe("custom-collection");
    expect(insertManyCalls).toHaveLength(1);
    expect(insertManyCalls[0]).toHaveLength(1);
  });
});
