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

/** A plain `beforeLog`-style function, as accepted by `Logger.use()` in place of a `Plugin`. */
export type MiddlewareFunc = (record: LogRecord) => LogRecord | null;

/**
 * Wraps a plain `beforeLog`-style function as a `Plugin`. `Logger.use()`
 * builds one of these automatically when given a function instead of a
 * `Plugin` — Express/Koa-style middleware ergonomics, without needing to
 * read the `Plugin` interface first. There's no `next()` chaining: the
 * pipeline already calls hooks in sequence, so this is sugar for a
 * single-method `Plugin`, not a new execution model.
 */
export class FunctionPlugin implements Plugin {
  private readonly func: MiddlewareFunc;

  constructor(func: MiddlewareFunc) {
    this.func = func;
  }

  beforeLog(record: LogRecord): LogRecord | null {
    return this.func(record);
  }
}
