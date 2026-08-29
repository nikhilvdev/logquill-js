import type { LogRecord } from "./records.js";

/** `format(record) -> string`, per the transport contract shared with logquill-python. */
export interface Formatter {
  format(record: LogRecord): string;
}

/** Serializes a record to the canonical JSON line shape. */
export class JSONFormatter implements Formatter {
  format(record: LogRecord): string {
    return JSON.stringify(record);
  }
}
