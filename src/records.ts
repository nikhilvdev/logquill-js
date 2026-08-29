import { levelName, type Level } from "./levels.js";

/** The cross-language record shape shared with logquill-python. */
export interface LogRecord {
  timestamp: string;
  level: string;
  logger: string;
  message: string;
  meta: Record<string, unknown>;
}

/** ISO8601 UTC timestamp with millisecond precision, matching Python's `utc_timestamp()`. */
export function utcTimestamp(): string {
  return new Date().toISOString();
}

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
