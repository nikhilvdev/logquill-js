import { BatchingTransport, type BatchingTransportOptions } from "../batching-transport.js";
import type { LogRecord } from "../../core/records.js";

/** One row of the fixed `logs` table schema shared across every SQL transport. */
export interface SQLLogRow {
  /** `record.timestamp`, as ISO8601. */
  timestamp: string;
  /** `record.level`. */
  level: string;
  /** `record.logger`. */
  logger: string;
  /** `record.message`. */
  message: string;
  /** `record.meta`, JSON-serialized — every SQL dialect can store this as TEXT/JSON/JSONB. */
  meta: string;
  /** `record.meta.run_id`, if present. */
  run_id: string | null;
  /** `record.meta.span_id`, if present. */
  span_id: string | null;
  /** `record.meta.parent_span_id`, if present. */
  parent_span_id: string | null;
  /** `record.meta.trace_id`, if present. */
  trace_id: string | null;
}

/** Options for {@link BaseSQLTransport} and every concrete SQL transport that extends it. */
export interface BaseSQLTransportOptions extends BatchingTransportOptions {
  /** Table to write into. Default `"logs"`. */
  tableName?: string;
  /**
   * Dev/test convenience only: run `createTableSQL()` before the first insert.
   * Production schema/migrations are the caller's responsibility — never
   * auto-create schema unless this is explicitly set. Default `false`.
   */
  ensureSchema?: boolean;
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" ? value : null;
}

/**
 * Abstract base for every SQL transport (`SQLiteTransport`, `PostgresTransport`,
 * `MySQLTransport`, ...). Owns the fixed schema and the record → row mapping;
 * each driver-specific subclass only implements `ensureTable()`/`insertRows()`.
 * Inserts are always batched — never one query per log call.
 */
export abstract class BaseSQLTransport extends BatchingTransport<SQLLogRow> {
  /** Table records are inserted into. */
  readonly tableName: string;
  /** Whether `createTableSQL()` runs before the first insert. Dev/test convenience only. */
  readonly ensureSchema: boolean;
  private schemaEnsured = false;

  constructor(options: BaseSQLTransportOptions = {}) {
    super(options);
    this.tableName = options.tableName ?? "logs";
    this.ensureSchema = options.ensureSchema ?? false;
  }

  protected override toItem(_formatted: string, record: LogRecord): SQLLogRow {
    return {
      timestamp: record.timestamp,
      level: record.level,
      logger: record.logger,
      message: record.message,
      meta: JSON.stringify(record.meta),
      run_id: metaString(record.meta, "run_id"),
      span_id: metaString(record.meta, "span_id"),
      parent_span_id: metaString(record.meta, "parent_span_id"),
      trace_id: metaString(record.meta, "trace_id"),
    };
  }

  protected override sizeOf(row: SQLLogRow): number {
    return row.message.length + row.meta.length + 96;
  }

  /**
   * Minimal, dialect-generic `CREATE TABLE IF NOT EXISTS` for dev/test use via
   * `ensureSchema: true`. Production deployments should manage this table with
   * a real migration instead — override in a subclass for dialect-correct
   * column types (e.g. `JSONB` on Postgres).
   */
  createTableSQL(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.tableName} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  logger TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT NOT NULL,
  run_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  trace_id TEXT
)`;
  }

  protected override async sendBatch(rows: readonly SQLLogRow[]): Promise<void> {
    if (this.ensureSchema && !this.schemaEnsured) {
      // Set before awaiting: a synchronous second flush (e.g. maxRecords: 1)
      // must not re-trigger ensureTable() while the first call is in flight.
      this.schemaEnsured = true;
      await this.ensureTable();
    }
    await this.insertRows(rows);
  }

  /** Only invoked when `ensureSchema: true` was explicitly passed. */
  protected abstract ensureTable(): Promise<void>;

  /** Always-batched insert of every row in `rows` — never one query per row. */
  protected abstract insertRows(rows: readonly SQLLogRow[]): Promise<void>;
}
