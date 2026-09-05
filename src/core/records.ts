import { levelName, type Level } from "./levels.js";

/** The cross-language record shape shared with logquill-python. */
export interface LogRecord {
  /** ISO8601 UTC timestamp with millisecond precision. */
  timestamp: string;
  /** Level name, e.g. `"INFO"`. */
  level: string;
  /** Name of the `Logger` that created this record. */
  logger: string;
  /** The log message. */
  message: string;
  /** Structured payload — always present, even if empty. */
  meta: Record<string, unknown>;
}

/** ISO8601 UTC timestamp with millisecond precision, matching Python's `utc_timestamp()`. */
export function utcTimestamp(): string {
  return new Date().toISOString();
}

/** Builds a `LogRecord` with the current UTC timestamp. Used internally by `Logger`; exported for transports/plugins that need to construct a record directly. */
export function createRecord(params: {
  level: Level;
  logger: string;
  message: string;
  meta: Record<string, unknown>;
}): LogRecord {
  return {
    timestamp: utcTimestamp(),
    level: levelName(params.level),
    logger: params.logger,
    message: params.message,
    meta: params.meta,
  };
}
