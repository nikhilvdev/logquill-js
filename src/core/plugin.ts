import type { LogRecord } from "./records.js";

/**
 * The plugin pipeline hooks, matching the Python hook names: `beforeLog`,
 * `afterLog`, `onError`. All hooks are optional — implement only what you need.
 * A hook that throws cannot crash logging: the pipeline catches it, routes it
 * to `onError`, and moves on.
 */
export interface Plugin {
  /** Return a (possibly modified) record, or `null` to drop it. */
  beforeLog?(record: LogRecord): LogRecord | null;
  /** Called after the record has been dispatched to every transport. */
  afterLog?(record: LogRecord): void;
  /** Called when one of this plugin's own hooks throws. */
  onError?(error: unknown, record: LogRecord): void;
}
