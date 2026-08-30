import { describe, expect, it } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { MongoDBTransport, type MongoCollectionLike } from "../../../src/transports/nosql/mongodb-transport.js";

function fakeCollection(): MongoCollectionLike & { insertManyCalls: unknown[][] } {
  const insertManyCalls: unknown[][] = [];
  return {
    insertManyCalls,
    insertMany(docs: readonly unknown[]) {
      insertManyCalls.push([...docs]);
      return Promise.resolve({ insertedCount: docs.length });
    },
  };
}

describe("MongoDBTransport", () => {
  it("batches inserts until maxRecords is reached", () => {
    const collection = fakeCollection();
    const transport = new MongoDBTransport({ collection, maxRecords: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("one");
    expect(collection.insertManyCalls).toHaveLength(0);

    logger.info("two");
    expect(collection.insertManyCalls).toHaveLength(1);
    expect(collection.insertManyCalls[0]).toHaveLength(2);
  });

  it("close() flushes a partial batch, mapping records 1:1 to documents", () => {
    const collection = fakeCollection();
    const transport = new MongoDBTransport({ collection, maxRecords: 10 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("only one", { runId: "run-1" });
    transport.close();

    expect(collection.insertManyCalls).toHaveLength(1);
    const [doc] = collection.insertManyCalls[0] as [Record<string, unknown>];
    expect(doc.message).toBe("only one");
    expect(doc.logger).toBe("app.test");
    expect(doc.level).toBe("INFO");
    expect(doc.meta).toEqual({ runId: "run-1" });
    expect(typeof doc.timestamp).toBe("string");
  });

  it("flushes once maxBytes is reached even below maxRecords", () => {
    const collection = fakeCollection();
    const transport = new MongoDBTransport({ collection, maxRecords: 1000, maxBytes: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    expect(collection.insertManyCalls).toHaveLength(1);
  });

  it("close() on an empty batch sends nothing", () => {
    const collection = fakeCollection();
    const transport = new MongoDBTransport({ collection });

    transport.close();

    expect(collection.insertManyCalls).toHaveLength(0);
  });

  it("throws an actionable error when mongodb isn't installed and no collection is given", async () => {
    const transport = new MongoDBTransport({ connectionString: "mongodb://localhost:27017" });
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    transport.close();
    // The failing dynamic import resolves via real filesystem I/O, not just a
    // microtask, so give it real time rather than a single setImmediate tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("install `mongodb`");
  });

  it("throws an actionable error when neither a collection nor a connectionString is given", async () => {
    const transport = new MongoDBTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    const errorSpy: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    logger.info("hello");
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    console.error = originalError;
    expect(errorSpy).toHaveLength(1);
    expect(String(errorSpy[0]?.[1])).toContain("connectionString");
  });
});
