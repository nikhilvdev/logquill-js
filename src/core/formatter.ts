import type { LogRecord } from "./records.js";

/** `format(record) -> string`, per the transport contract shared with logquill-python. */
export interface Formatter {
  /** Turns a `LogRecord` into the string a `Transport` writes. */
  format(record: LogRecord): string;
}

/** Serializes a record to the canonical JSON line shape. */
export class JSONFormatter implements Formatter {
  /** Returns `JSON.stringify(record)`. */
  format(record: LogRecord): string {
    return JSON.stringify(record);
  }
}
