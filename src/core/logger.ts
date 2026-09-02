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

export interface LoggerOptions {
  level?: LevelInput;
  transports?: Transport[];
  plugins?: (Plugin | MiddlewareFunc)[];
  meta?: Record<string, unknown>;
}

export class Logger {
  readonly name: string;
  readonly transports: Transport[];
  readonly plugins: Plugin[];
  private currentLevel: Level;
  private readonly baseMeta: Record<string, unknown>;

  constructor(name: string, options: LoggerOptions = {}) {
    this.name = name;
    this.currentLevel = parseLevel(options.level ?? Level.INFO);
    this.transports = options.transports ? [...options.transports] : [];
    this.plugins = [];
    for (const plugin of options.plugins ?? []) {
      this.use(plugin);
    }
    this.baseMeta = options.meta ? { ...options.meta } : {};
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

  /** Close every attached transport. Call on shutdown to flush buffered writes. */
  close(): void {
    for (const transport of this.transports) {
      transport.close();
    }
  }

  /** A logger scoped under this one, inheriting its level, transports, and plugins. */
  child(name: string, meta: Record<string, unknown> = {}): Logger {
    return new Logger(`${this.name}.${name}`, {
      level: this.currentLevel,
      transports: this.transports,
      plugins: this.plugins,
      meta: { ...this.baseMeta, ...meta },
    });
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
      meta: { ...this.baseMeta, ...meta },
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

    return record;
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
