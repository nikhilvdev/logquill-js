import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

/**
 * Injects fixed key/value pairs into every record's `meta`.
 * A value already present in a record's own `meta` wins over the fixed context.
 */
export class ContextPlugin implements Plugin {
  readonly context: Record<string, unknown>;

  constructor(context: Record<string, unknown>) {
    this.context = context;
  }

  beforeLog(record: LogRecord): LogRecord {
    return { ...record, meta: { ...this.context, ...record.meta } };
  }
}
