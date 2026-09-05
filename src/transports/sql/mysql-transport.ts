import { BaseSQLTransport, type BaseSQLTransportOptions, type SQLLogRow } from "./base-sql-transport.js";

/** The subset of a `mysql2/promise` connection/pool that `MySQLTransport` needs. Inject a fake in tests. */
export interface MySQLClientLike {
  /** Runs a parameterized query, matching `mysql2`'s own `Connection`/`Pool.execute(sql, values)`. */
  execute(sql: string, values: unknown[]): Promise<unknown>;
}

export interface MySQLTransportOptions extends BaseSQLTransportOptions {
  /** Pre-built client/pool, e.g. for tests, or an already-open `mysql2/promise` `Pool`/`Connection`. Skips the `mysql2` auto-import entirely. */
  client?: MySQLClientLike;
  /** Passed to `mysql2/promise`'s `createPool` when no `client` is injected, e.g. `"mysql://user:pass@host:3306/db"`. */
  connectionString?: string;
  /** Passed to `mysql2/promise`'s `createPool` when no `client` is injected and `connectionString` isn't used. */
  connectionConfig?: Record<string, unknown>;
}

/**
 * SQL sink backed by MySQL via `mysql2`. Builds one parameterized multi-row
 * `INSERT` per batch — never one query per log call — matching the
 * always-batched contract every `BaseSQLTransport` subclass shares.
 *
 * `mysql2` is an optional peer dependency: install it yourself, or inject a
 * `client` (e.g. a fake, or an already-open pool/connection from
 * `mysql2/promise`).
 */
export class MySQLTransport extends BaseSQLTransport {
  private readonly injectedClient: MySQLClientLike | undefined;
  private readonly connectionString: string | undefined;
  private readonly connectionConfig: Record<string, unknown> | undefined;
  private client: MySQLClientLike | undefined;

  constructor(options: MySQLTransportOptions = {}) {
    super(options);
    this.injectedClient = options.client;
    this.connectionString = options.connectionString;
    this.connectionConfig = options.connectionConfig;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): MySQLClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<MySQLClientLike> {
    let createPool: (target: string | Record<string, unknown>) => MySQLClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "mysql2/promise";
      const mod = (await import(moduleName)) as unknown as {
        default?: { createPool?: (target: string | Record<string, unknown>) => MySQLClientLike };
        createPool?: (target: string | Record<string, unknown>) => MySQLClientLike;
      };
      const resolved = mod.default?.createPool ?? mod.createPool;
      if (!resolved) {
        throw new Error("no createPool export found");
      }
      createPool = resolved;
    } catch {
      throw new Error(
        "MySQLTransport: install `mysql2` to use this transport without providing a client — `npm install mysql2`",
      );
    }

    const target = this.connectionString ?? this.connectionConfig ?? {};
    this.client = createPool(target);
    return this.client;
  }

  /** MySQL-correct `CREATE TABLE IF NOT EXISTS`: `AUTO_INCREMENT` primary key, `JSON` column type for `meta`. */
  override createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.tableName} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  timestamp VARCHAR(64) NOT NULL,
  level VARCHAR(16) NOT NULL,
  logger VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  meta JSON NOT NULL,
  runId VARCHAR(255),
  spanId VARCHAR(255),
  parentSpanId VARCHAR(255),
  traceId VARCHAR(255)
)`;
  }

  protected async ensureTable(): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    await client.execute(this.createTableSQL(), []);
  }

  protected async insertRows(rows: readonly SQLLogRow[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const columns = 9;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const row of rows) {
      placeholders.push(`(${Array.from({ length: columns }, () => "?").join(", ")})`);
      values.push(
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

    const sql = `INSERT INTO ${this.tableName} (timestamp, level, logger, message, meta, runId, spanId, parentSpanId, traceId) VALUES ${placeholders.join(", ")}`;
    await client.execute(sql, values);
  }
}
