import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** The subset of a `mongodb` `Collection` that `MongoDBTransport` needs. Inject a fake in tests. */
export interface MongoCollectionLike {
  insertMany(docs: readonly unknown[]): Promise<unknown>;
}

/** The subset of a `mongodb` `MongoClient` that `MongoDBTransport` needs to lazily connect. */
export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name: string): { collection(name: string): MongoCollectionLike };
}

export interface MongoDBTransportOptions extends BatchingTransportOptions {
  /** Pre-built collection, e.g. for tests, or an already-connected app. Skips the `mongodb` auto-import entirely. */
  collection?: MongoCollectionLike;
  /** `mongodb` connection string, used when no `collection` is injected. Required in that case. */
  connectionString?: string;
  /** Database to write into when connecting via `connectionString`. Default `"logquill"`. */
  database?: string;
  /** Collection to write into when connecting via `connectionString`. Default `"logs"`. */
  collectionName?: string;
}

/**
 * Sink for MongoDB. Records map 1:1 to documents — no JSON-in-a-column
 * workaround needed, unlike the SQL transports.
 *
 * `mongodb` is an optional peer dependency: install it yourself, or inject a
 * `collection` (e.g. a fake, or a `Collection` from a client your app already
 * manages).
 */
export class MongoDBTransport extends BatchingTransport {
  private readonly injectedCollection: MongoCollectionLike | undefined;
  private readonly connectionString: string | undefined;
  private readonly database: string;
  private readonly collectionName: string;
  private collection: MongoCollectionLike | undefined;

  constructor(options: MongoDBTransportOptions = {}) {
    super(options);
    this.injectedCollection = options.collection;
    this.connectionString = options.connectionString;
    this.database = options.database ?? "logquill";
    this.collectionName = options.collectionName ?? "logs";
  }

  /** Synchronously available collection, if one was injected or already connected — avoids an unnecessary microtask hop on the hot path. */
  private resolvedCollection(): MongoCollectionLike | undefined {
    return this.injectedCollection ?? this.collection;
  }

  private async importCollection(): Promise<MongoCollectionLike> {
    if (!this.connectionString) {
      throw new Error(
        "MongoDBTransport: provide either a `collection` or a `connectionString` to connect with — neither was given",
      );
    }

    let MongoClientCtor: new (connectionString: string) => MongoClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "mongodb";
      const mod = (await import(moduleName)) as unknown as {
        MongoClient: new (connectionString: string) => MongoClientLike;
      };
      MongoClientCtor = mod.MongoClient;
    } catch {
      throw new Error(
        "MongoDBTransport: install `mongodb` to use this transport without providing a client — `npm install mongodb`",
      );
    }

    const client = new MongoClientCtor(this.connectionString);
    await client.connect();
    this.collection = client.db(this.database).collection(this.collectionName);
    return this.collection;
  }

  protected override async sendBatch(batch: readonly LogRecord[]): Promise<void> {
    const collection = this.resolvedCollection() ?? (await this.importCollection());
    // Records already match the cross-language JSON record shape, so each one
    // becomes a document as-is — spread to give Mongo a fresh plain object per doc.
    await collection.insertMany(batch.map((record) => ({ ...record })));
  }
}
