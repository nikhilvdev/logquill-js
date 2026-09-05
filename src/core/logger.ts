import { currentContext } from "./context.js";
import { DispatchQueue, type DispatchQueueOptions } from "./dispatch-queue.js";
import { Level, parseLevel, type LevelInput } from "./levels.js";
import { FunctionPlugin, type MiddlewareFunc, type Plugin } from "./plugin.js";
import { createRecord, type LogRecord } from "./records.js";
import { currentSpanId, newSpanId, runInSpan } from "./span.js";
import type { Transport } from "../transports/transport.js";

/** Options for `Logger.span()`. Any extra keys become the span's own `meta`. */
export interface SpanOptions extends Record<string, unknown> {
  /** Adopt an id handed in from elsewhere (e.g. a framework's own run id) instead of generating one. */
  spanId?: string;
  /** Adopt a parent id explicitly, overriding auto-nesting from an enclosing `span()` block. */
  parentSpanId?: string;
}

function formatSpanError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * If `meta.err` is an `Error`, replaces it with a formatted `meta.stack`
 * (the JS analogue of `logquill-python`'s `exc_info` kwarg, which pops
 * `exc_info` and populates `meta["stack"]` the same way). Left as-is
 * otherwise — a non-`Error` `meta.err` is passed through unchanged rather
 * than rejected, so a call site can't crash logging by getting this wrong.
 */
function withStackFromErr(meta: Record<string, unknown>): Record<string, unknown> {
  const err = meta.err;
  if (!(err instanceof Error)) {
    return meta;
  }
  const next = { ...meta };
  delete next.err;
  next.stack = err.stack ?? `${err.name}: ${err.message}`;
  return next;
}

export interface LoggerOptions {
  level?: LevelInput;
  transports?: Transport[];
  plugins?: (Plugin | MiddlewareFunc)[];
  meta?: Record<string, unknown>;
  /** Bounds and backpressure policy for the internal async dispatch queue. See `DispatchQueueOptions`. */
  queue?: DispatchQueueOptions;
}

export class Logger {
  readonly name: string;
  readonly transports: Transport[];
  readonly plugins: Plugin[];
  private currentLevel: Level;
  private readonly baseMeta: Record<string, unknown>;
  private dispatchQueue: DispatchQueue;

  constructor(name: string, options: LoggerOptions = {}) {
    this.name = name;
    this.currentLevel = parseLevel(options.level ?? Level.INFO);
    this.transports = options.transports ? [...options.transports] : [];
    this.plugins = [];
    for (const plugin of options.plugins ?? []) {
      this.use(plugin);
    }
    this.baseMeta = options.meta ? { ...options.meta } : {};
    this.dispatchQueue = new DispatchQueue(options.queue);
  }

  get level(): Level {
    return this.currentLevel;
  }

  setLevel(level: LevelInput): void {
    this.currentLevel = parseLevel(level);
  }

  /**
   * Register a plugin, or a plain `beforeLog`-style function. A function is
   * wrapped internally as an anonymous `Plugin` (`FunctionPlugin`) — the
   * same middleware ergonomics as Express/Koa, without needing to read the
   * `Plugin` interface first. Returns `this` so calls can be chained.
   */
  use(plugin: Plugin | MiddlewareFunc): this {
    this.plugins.push(typeof plugin === "function" ? new FunctionPlugin(plugin) : plugin);
    return this;
  }

  /** Number of dispatched records not yet written to their transports. Bounded by the `queue` option. */
  get queueSize(): number {
    return this.dispatchQueue.size;
  }

  /**
   * Waits for every record dispatched so far to reach its transports'
   * `write()` (and any plugin `afterLog` hooks). Note this does *not* force
   * a batching transport (SQL, a queue, `HTTPTransport`, ...) to send a
   * batch still under its own `maxRecords`/`maxBytes` threshold early — it
   * only guarantees the record has been handed to that transport, the same
   * contract `write()` always had. Before a process may pause or exit
   * (a serverless freeze, a shutdown signal), prefer `withLambda`/
   * `installShutdownHandlers`, which additionally force every batching
   * transport to send its current buffer regardless of threshold.
   */
  async flush(): Promise<void> {
    await this.dispatchQueue.flush();
  }

  /** Flush every pending record, then close every attached transport. Call once, on shutdown. */
  async close(): Promise<void> {
    await this.flush();
    for (const transport of this.transports) {
      transport.close();
    }
  }

  /** A logger scoped under this one, inheriting its level, transports, plugins, and dispatch queue. */
  child(name: string, meta: Record<string, unknown> = {}): Logger {
    const child = new Logger(`${this.name}.${name}`, {
      level: this.currentLevel,
      transports: this.transports,
      plugins: this.plugins,
      meta: { ...this.baseMeta, ...meta },
    });
    child.dispatchQueue = this.dispatchQueue;
    return child;
  }

  private notifyError(plugin: Plugin, error: unknown, record: LogRecord): void {
    // a broken error handler must not crash logging either
    try {
      plugin.onError?.(error, record);
    } catch {
      /* swallowed */
    }
  }

  private dispatch(level: Level, message: string, meta: Record<string, unknown>): LogRecord | null {
    if (level < this.currentLevel) {
      return null;
    }

    let record = createRecord({
      level,
      logger: this.name,
      message,
      meta: { ...this.baseMeta, ...currentContext(), ...withStackFromErr(meta) },
    });

    const parentSpanId = currentSpanId();
    if (parentSpanId !== undefined) {
      record.meta.parentSpanId ??= parentSpanId;
    }

    for (const plugin of this.plugins) {
      let result: LogRecord | null;
      try {
        result = plugin.beforeLog ? plugin.beforeLog(record) : record;
      } catch (error) {
        this.notifyError(plugin, error, record);
        continue;
      }
      if (result === null) {
        return null;
      }
      record = result;
    }

    // The write itself (I/O) and afterLog are deferred onto the dispatch
    // queue so this call returns before either runs — see DispatchQueue.
    // They're bundled into one task to preserve the existing contract that
    // afterLog fires only once the record has reached every transport.
    this.dispatchQueue.enqueue(() => {
      this.writeAndNotify(record);
    });

    return record;
  }

  private writeAndNotify(record: LogRecord): void {
    for (const transport of this.transports) {
      try {
        transport.write(transport.format(record), record);
      } catch (error) {
        // a transport that can't format or write this particular record
        // (e.g. a circular reference in `meta`) must not crash the caller
        console.error(`${transport.constructor.name}: failed to write a log record`, error);
      }
    }

    for (const plugin of this.plugins) {
      try {
        plugin.afterLog?.(record);
      } catch (error) {
        this.notifyError(plugin, error, record);
      }
    }
  }

  trace(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.TRACE, message, meta);
  }

  debug(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.DEBUG, message, meta);
  }

  info(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, meta);
  }

  warn(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.WARN, message, meta);
  }

  error(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.ERROR, message, meta);
  }

  fatal(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.FATAL, message, meta);
  }

  /** `.info()` tagged `meta.kind = "thought"` — an agent's internal reasoning step, for harness/agentic tracing. */
  thought(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, { kind: "thought", ...meta });
  }

  /** `.info()` tagged `meta.kind = "action"` — an agent taking an action (a tool call, an LLM request), for harness/agentic tracing. */
  action(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, { kind: "action", ...meta });
  }

  /** `.info()` tagged `meta.kind = "observation"` — the result an agent observed from an action, for harness/agentic tracing. */
  observation(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, { kind: "observation", ...meta });
  }

  /** `.info()` tagged `meta.kind = "decision"` — an agent's concluding decision for a step or run, for harness/agentic tracing. */
  decision(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, { kind: "decision", ...meta });
  }

  /**
   * `await logger.span("callLlm", async () => {...})` — runs `fn`, and on
   * settling (success or throw) emits one record for the span itself
   * carrying `meta.spanId` and `meta.durationMs`. Every record logged
   * inside `fn` — through any method, and through any further `await` —
   * is automatically stamped with `meta.parentSpanId` pointing at this
   * span, so nested/sub-agent calls reconstruct their exact nesting when
   * sorted by `spanId`/`parentSpanId`.
   *
   * Still emits its record — at `ERROR`, with `meta.error` set — if `fn`
   * throws; the error itself propagates unchanged to the caller.
   *
   * `spanId`/`parentSpanId` normally auto-generate/auto-nest; pass them in
   * `options` to adopt an id handed in from elsewhere (e.g. a framework
   * adapter translating an id it already received).
   */
  async span<T>(name: string, fn: () => T | Promise<T>, options: SpanOptions = {}): Promise<T> {
    const { spanId: explicitSpanId, parentSpanId: explicitParentSpanId, ...meta } = options;
    const spanId = explicitSpanId ?? newSpanId();
    const start = performance.now();

    try {
      const result = await runInSpan(spanId, () => fn());
      this.finishSpan(name, spanId, explicitParentSpanId, performance.now() - start, meta);
      return result;
    } catch (error) {
      this.finishSpan(name, spanId, explicitParentSpanId, performance.now() - start, meta, error);
      throw error;
    }
  }

  private finishSpan(
    name: string,
    spanId: string,
    explicitParentSpanId: string | undefined,
    durationMs: number,
    meta: Record<string, unknown>,
    error?: unknown,
  ): void {
    const fullMeta: Record<string, unknown> = {
      spanId,
      durationMs: Math.round(durationMs * 1000) / 1000,
      ...meta,
    };
    if (explicitParentSpanId !== undefined) {
      fullMeta.parentSpanId = explicitParentSpanId;
    }
    fullMeta.kind ??= "span";
    if (error !== undefined) {
      fullMeta.error = formatSpanError(error);
    }
    this.dispatch(error !== undefined ? Level.ERROR : Level.INFO, name, fullMeta);
  }
}
