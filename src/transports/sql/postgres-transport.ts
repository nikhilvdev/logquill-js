import { BaseSQLTransport, type BaseSQLTransportOptions, type SQLLogRow } from "./base-sql-transport.js";

/** The subset of a `pg` `Pool`/`Client` that `PostgresTransport` needs. Inject a fake in tests. */
export interface PgClientLike {
  /** Runs a parameterized query, matching `pg`'s own `Pool`/`Client.query(text, values)`. */
  query(text: string, values: unknown[]): Promise<unknown>;
}

export interface PostgresTransportOptions extends BaseSQLTransportOptions {
  /** Pre-built client/pool, e.g. for tests, or an already-open `pg.Pool`/`pg.Client`. Skips the `pg` auto-import entirely. */
  client?: PgClientLike;
  /** Passed to `pg.Pool` when no `client` is injected, e.g. `"postgres://user:pass@host:5432/db"`. */
  connectionString?: string;
  /** Passed to `pg.Pool` when no `client` is injected and `connectionString` isn't used. */
  connectionConfig?: Record<string, unknown>;
}

/**
 * SQL sink backed by Postgres via `pg`. Builds one parameterized multi-row
 * `INSERT` per batch — never one query per log call — matching the
 * always-batched contract every `BaseSQLTransport` subclass shares.
 *
 * `pg` is an optional peer dependency: install it yourself, or inject a
 * `client` (e.g. a fake, or an already-open `Pool`/`Client` instance).
 */
export class PostgresTransport extends BaseSQLTransport {
  private readonly injectedClient: PgClientLike | undefined;
  private readonly connectionString: string | undefined;
  private readonly connectionConfig: Record<string, unknown> | undefined;
  private client: PgClientLike | undefined;

  constructor(options: PostgresTransportOptions = {}) {
    super(options);
    this.injectedClient = options.client;
    this.connectionString = options.connectionString;
    this.connectionConfig = options.connectionConfig;
  }

  /** Synchronously available client, if one was injected or already imported — avoids an unnecessary microtask hop on the hot path. */
  private resolvedClient(): PgClientLike | undefined {
    return this.injectedClient ?? this.client;
  }

  private async importClient(): Promise<PgClientLike> {
    let PoolCtor: new (config?: Record<string, unknown>) => PgClientLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "pg";
      const mod = (await import(moduleName)) as unknown as {
        default?: { Pool?: new (config?: Record<string, unknown>) => PgClientLike };
        Pool?: new (config?: Record<string, unknown>) => PgClientLike;
      };
      const resolved = mod.default?.Pool ?? mod.Pool;
      if (!resolved) {
        throw new Error("no Pool export found");
      }
      PoolCtor = resolved;
    } catch {
      throw new Error(
        "PostgresTransport: install `pg` to use this transport without providing a client — `npm install pg`",
      );
    }

    const config = this.connectionString
      ? { connectionString: this.connectionString }
      : (this.connectionConfig ?? {});
    this.client = new PoolCtor(config);
    return this.client;
  }

  /** Postgres-correct `CREATE TABLE IF NOT EXISTS`: `SERIAL` primary key, `JSONB` for `meta`. */
  override createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.tableName} (
  id SERIAL PRIMARY KEY,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  logger TEXT NOT NULL,
  message TEXT NOT NULL,
  meta JSONB NOT NULL,
  "runId" TEXT,
  "spanId" TEXT,
  "parentSpanId" TEXT,
  "traceId" TEXT
)`;
  }

  protected async ensureTable(): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    await client.query(this.createTableSQL(), []);
  }

  protected async insertRows(rows: readonly SQLLogRow[]): Promise<void> {
    const client = this.resolvedClient() ?? (await this.importClient());
    const columns = 9;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rows.forEach((row, rowIndex) => {
      const base = rowIndex * columns;
      placeholders.push(
        `(${Array.from({ length: columns }, (_, col) => `$${String(base + col + 1)}`).join(", ")})`,
      );
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
    });

    const sql = `INSERT INTO ${this.tableName} (timestamp, level, logger, message, meta, "runId", "spanId", "parentSpanId", "traceId") VALUES ${placeholders.join(", ")}`;
    await client.query(sql, values);
  }
}
