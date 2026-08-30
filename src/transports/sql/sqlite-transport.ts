import { BaseSQLTransport, type BaseSQLTransportOptions, type SQLLogRow } from "./base-sql-transport.js";

/** The subset of a `better-sqlite3` prepared statement that `SQLiteTransport` needs. */
export interface SQLiteStatementLike {
  run(...params: unknown[]): unknown;
}

/** The subset of a `better-sqlite3` `Database` that `SQLiteTransport` needs. Inject a fake in tests. */
export interface SQLiteClientLike {
  exec(sql: string): unknown;
  prepare(sql: string): SQLiteStatementLike;
  transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void;
}

export interface SQLiteTransportOptions extends BaseSQLTransportOptions {
  /** Pre-built client, e.g. for tests. Skips the `better-sqlite3` auto-import entirely. */
  client?: SQLiteClientLike;
  /** Passed to `better-sqlite3` when no `client` is injected. Default `":memory:"`. */
  filename?: string;
}

/**
 * Zero-setup SQL sink — no server process, just a local (or in-memory) file
 * via `better-sqlite3`. Useful for local dev and pairs with the CLI trace
 * viewer (v2.0), which can read this file directly.
 *
 * `better-sqlite3` is an optional peer dependency: install it yourself, or
 * inject a `client` (e.g. a fake, or an already-open `Database` instance).
 */
export class SQLiteTransport extends BaseSQLTransport {
  private readonly injectedClient: SQLiteClientLike | undefined;
  private readonly filename: string;
  private client: SQLiteClientLike | undefined;

  constructor(options: SQLiteTransportOptions = {}) {
    super(options);
    this.injectedClient = options.client;
    this.filename = options.filename ?? ":memory:";
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): SQLiteClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<SQLiteClientLike> {
    let DatabaseCtor: new (filename: string) => SQLiteClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "better-sqlite3";
      const mod = (await import(moduleName)) as unknown as {
        default: new (filename: string) => SQLiteClientLike;
      };
      DatabaseCtor = mod.default;
    } catch {
      throw new Error(
        "SQLiteTransport: install `better-sqlite3` to use this transport without providing a client — `npm install better-sqlite3`",
      );
    }

    this.client = new DatabaseCtor(this.filename);
    return this.client;
  }

  protected async ensureTable(): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    client.exec(this.createTableSQL());
  }

  protected async insertRows(rows: readonly SQLLogRow[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const stmt = client.prepare(
      `INSERT INTO ${this.tableName} (timestamp, level, logger, message, meta, runId, spanId, parentSpanId, traceId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = client.transaction((batch: readonly SQLLogRow[]) => {
      for (const row of batch) {
        stmt.run(
          row.timestamp,
          row.level,
          row.logger,
          row.message,
          row.meta,
          row.runId,
          row.spanId,
          row.parentSpanId,
          row.traceId,
        );
      }
    });
    insertMany(rows);
  }
}
