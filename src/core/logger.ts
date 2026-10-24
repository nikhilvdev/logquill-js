import { currentContext } from "#context";
import { DispatchQueue, type DispatchQueueOptions } from "./dispatch-queue.js";
import { Level, parseLevel, type LevelInput } from "./levels.js";
import { FunctionPlugin, type MiddlewareFunc, type Plugin } from "./plugin.js";
import { callerInfo, OptLogger, resolveLazy, type DispatchOptions } from "./opt.js";
import { applyContentPolicy, parseContentPolicy, type ContentCapturePolicy } from "./privacy.js";
import { buildLlmBlock, createRecord, type LlmCallOptions, type LogRecord } from "./records.js";
import { RetryTracker } from "./retry.js";
import { snapshot, stateDiff, UNCAPTURED } from "./state-diff.js";
import { isEnabled } from "./toggle.js";
import { currentSpanId, newSpanId, runInSpan } from "#span";
import { hasFlush, type Transport } from "../transports/transport.js";

/** Options for `Logger.span()`. Any extra keys become the span's own `meta`. */
export interface SpanOptions extends Record<string, unknown> {
  /** Adopt an id handed in from elsewhere (e.g. a framework's own run id) instead of generating one. */
  spanId?: string;
  /** Adopt a parent id explicitly, overriding auto-nesting from an enclosing `span()` block. */
  parentSpanId?: string;
  /**
   * Called on entering and on leaving the block; what changed between the two
   * is recorded as `meta.state_diff` (`{ before, after }`, only the keys that
   * changed when both are plain objects; omitted if nothing did). Values are
   * deep-copied, so an in-place mutation is seen. A state that can't be copied,
   * or a callback that throws, just means no `state_diff`. It is a content
   * field, so the logger's `contentPolicy` applies to it.
   */
  captureState?: () => unknown;
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

// Shared, so a plain log call (no `opt()`) allocates no options object.
const NO_OPTIONS: DispatchOptions = Object.freeze({});

/** `meta` with `state_diff` added when the span's captured state changed between entering and leaving it. */
function withStateDiff(
  meta: Record<string, unknown>,
  captureState: (() => unknown) | undefined,
  before: unknown,
): Record<string, unknown> {
  if (!captureState || before === UNCAPTURED) return meta;
  const after = snapshot(captureState);
  if (after === UNCAPTURED) return meta;
  const diff = stateDiff(before, after);
  return diff && !("state_diff" in meta) ? { ...meta, state_diff: diff } : meta;
}

/** Options for the {@link Logger} constructor. */
export interface LoggerOptions {
  /** Minimum level that reaches a transport; records below it are dropped before any plugin runs. Default `INFO`. */
  level?: LevelInput;
  /** Sinks every record that passes the level filter and plugin pipeline is written to. */
  transports?: Transport[];
  /** Registered via `.use()` in order — a plain function is wrapped as an anonymous `Plugin`. */
  plugins?: (Plugin | MiddlewareFunc)[];
  /** Merged into every record's `meta`, before a call-site `meta` value (which always wins on collision). */
  meta?: Record<string, unknown>;
  /** Bounds and backpressure policy for the internal async dispatch queue. See `DispatchQueueOptions`. */
  queue?: DispatchQueueOptions;
  /**
   * What happens to the content fields — an LLM call's prompt and completion, a
   * tool call's arguments and result, a span's captured state — before any
   * plugin or transport sees them. **`"off"` by default**: they are replaced with
   * a placeholder. `"hash"` replaces each with a stable `sha256:` digest,
   * `"truncate"` keeps its first 200 characters, `"full"` passes it through.
   */
  contentPolicy?: ContentCapturePolicy;
}

/**
 * The core logger: leveled, structured logging over a pluggable transport
 * and plugin pipeline. Every log call returns the finished `LogRecord` (or
 * `null` if it was filtered by level or dropped by a plugin) synchronously —
 * the actual transport writes are dispatched onto an internal queue so the
 * call returns before any I/O runs; see `flush()`/`close()`.
 */
export class Logger {
  /** This logger's name, as passed to the constructor (or derived via `.child()`). Appears on every record as `logger`. */
  readonly name: string;
  /** Every transport a written record is sent to. */
  readonly transports: Transport[];
  /** Every plugin registered via `.use()`, in registration order. */
  readonly plugins: Plugin[];
  /** What happens to content fields on their way to a transport. See `LoggerOptions.contentPolicy`. */
  readonly contentPolicy: ContentCapturePolicy;
  private currentLevel: Level;
  private readonly baseMeta: Record<string, unknown>;
  private readonly retries = new RetryTracker();
  private readonly optCache = new Map<string, OptLogger>();
  private dispatchQueue: DispatchQueue;

  constructor(name: string, options: LoggerOptions = {}) {
    this.name = name;
    this.currentLevel = parseLevel(options.level ?? Level.INFO);
    this.contentPolicy = parseContentPolicy(options.contentPolicy ?? "off");
    this.transports = options.transports ? [...options.transports] : [];
    this.plugins = [];
    for (const plugin of options.plugins ?? []) {
      this.use(plugin);
    }
    this.baseMeta = options.meta ? { ...options.meta } : {};
    this.dispatchQueue = new DispatchQueue(options.queue);
  }

  /** This logger's current minimum level — records below it are filtered before any plugin runs. */
  get level(): Level {
    return this.currentLevel;
  }

  /** Changes the minimum level records must meet to reach a transport. Accepts a `Level`, its numeric weight, or its name. */
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

  /**
   * Flush every pending record, force every batching transport to send what it
   * is holding (and wait for it), then close every attached transport. Call once,
   * on shutdown. Waiting matters: `installShutdownHandlers` may exit the process
   * right after this resolves, and a transport's own `close()` only starts its
   * last send.
   */
  async close(): Promise<void> {
    await this.flush();
    for (const transport of this.transports) {
      if (!hasFlush(transport)) continue;
      try {
        await transport.flush();
      } catch (error) {
        console.error(`${transport.constructor.name}: failed to flush`, error);
      }
    }
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
      contentPolicy: this.contentPolicy,
    });
    child.dispatchQueue = this.dispatchQueue;
    return child;
  }

  /**
   * Stamps `retry_count` on a tool `.action()` that reopens a call which hasn't
   * succeeded yet, and ends the chain on a successful `.observation()` for it.
   * Only records naming their tool in `meta.tool` take part. Returns `meta`
   * unchanged, or a copy with `retry_count` added (the caller's object is never
   * mutated).
   */
  private trackRetries(level: Level, meta: Record<string, unknown>): Record<string, unknown> {
    const { tool, tool_call_id: callId, kind } = meta;
    if (typeof tool !== "string" || tool === "") return meta;
    const id = typeof callId === "string" ? callId : undefined;
    if (kind === "action") {
      const count = this.retries.opened(currentSpanId(), tool, id);
      return count > 0 && !("retry_count" in meta) ? { ...meta, retry_count: count } : meta;
    }
    if (kind === "observation" && level < Level.ERROR && !("error" in meta)) {
      this.retries.succeeded(currentSpanId(), tool, id);
    }
    return meta;
  }

  private notifyError(plugin: Plugin, error: unknown, record: LogRecord): void {
    // a broken error handler must not crash logging either
    try {
      plugin.onError?.(error, record);
    } catch {
      /* swallowed */
    }
  }

  /**
   * @internal Builds and dispatches one record. Public only so `OptLogger` can
   * reach it; call `info()` and friends instead.
   */
  dispatch(
    level: Level,
    message: string,
    callMeta: Record<string, unknown>,
    options: DispatchOptions = NO_OPTIONS,
  ): LogRecord | null {
    if (level < this.currentLevel || !isEnabled(this.name)) {
      return null;
    }

    let meta = options.lazy ? resolveLazy(callMeta) : callMeta;
    meta = this.trackRetries(level, meta);
    if (options.depth !== undefined && !("caller" in meta)) {
      const caller = callerInfo(options.depth);
      if (caller) meta = { ...meta, caller };
    }

    let record = createRecord({
      level,
      logger: this.name,
      message,
      meta: { ...this.baseMeta, ...currentContext(), ...withStackFromErr(meta) },
      llm: options.llm,
    });

    const parentSpanId = currentSpanId();
    if (parentSpanId !== undefined) {
      record.meta.parent_span_id ??= parentSpanId;
    }

    // Before any plugin, so none (not even a custom one) can see raw content.
    applyContentPolicy(record.meta, this.contentPolicy);

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

  /** Logs at `TRACE` — the lowest level, for fine-grained diagnostic detail. Returns the record, or `null` if filtered/dropped. */
  trace(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.TRACE, message, meta);
  }

  /** Logs at `DEBUG`. Returns the record, or `null` if filtered/dropped. */
  debug(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.DEBUG, message, meta);
  }

  /** Logs at `INFO`. Returns the record, or `null` if filtered/dropped. */
  info(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.INFO, message, meta);
  }

  /** Logs at `WARN`. Returns the record, or `null` if filtered/dropped. */
  warn(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.WARN, message, meta);
  }

  /** Logs at `ERROR`. Returns the record, or `null` if filtered/dropped. */
  error(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.dispatch(Level.ERROR, message, meta);
  }

  /** Logs at `FATAL` — the highest level, for errors that precede an unrecoverable failure. Returns the record, or `null` if filtered/dropped. */
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
   * Logs one LLM call as an `.action()` carrying the record's first-class `llm`
   * block (`model`, `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms`,
   * `finish_reason`) — the fields cost and latency dashboards read. Any you leave
   * out are simply absent; one of the wrong type is dropped with a warning
   * rather than thrown. Extra call-site `meta` goes in the second argument.
   * Don't put prompt or completion text in `meta` unless you mean every
   * transport to receive it; use `meta.input_messages`/`output_messages` and let
   * `contentPolicy` govern them.
   */
  llmCall(options: LlmCallOptions, meta: Record<string, unknown> = {}): LogRecord | null {
    const { message = "llm_call", ...fields } = options;
    const llm = buildLlmBlock(fields);
    return this.dispatch(Level.INFO, message, { kind: "action", ...meta }, llm ? { llm } : {});
  }

  /**
   * A view of this logger with per-call options: `lazy: true` defers
   * function-valued `meta` entries until the record is really going to be
   * emitted, `depth: N` adds `meta.caller` naming the code `N` frames above the
   * direct caller. The view is cached per combination, so calling this inline on
   * every log call costs no allocation. See {@link OptLogger}.
   */
  opt(options: { lazy?: boolean; depth?: number } = {}): OptLogger {
    const lazy = options.lazy ?? false;
    const key = `${String(lazy)}:${String(options.depth ?? "")}`;
    const cached = this.optCache.get(key);
    if (cached) return cached;
    const view = new OptLogger(this, { lazy, depth: options.depth });
    // shortcut: at most 32 cached views so a dynamically computed `depth` can't grow this without bound; past that, a fresh uncached view per call
    if (this.optCache.size < 32) this.optCache.set(key, view);
    return view;
  }

  /**
   * `await logger.span("callLlm", async () => {...})` — runs `fn`, and on
   * settling (success or throw) emits one record for the span itself
   * carrying `meta.span_id` and `meta.duration_ms`. Every record logged
   * inside `fn` — through any method, and through any further `await` —
   * is automatically stamped with `meta.parent_span_id` pointing at this
   * span, so nested/sub-agent calls reconstruct their exact nesting when
   * sorted by `span_id`/`parent_span_id`.
   *
   * Still emits its record — at `ERROR`, with `meta.error` set — if `fn`
   * throws; the error itself propagates unchanged to the caller.
   *
   * `spanId`/`parentSpanId` normally auto-generate/auto-nest; pass them in
   * `options` to adopt an id handed in from elsewhere (e.g. a framework
   * adapter translating an id it already received).
   */
  async span<T>(name: string, fn: () => T | Promise<T>, options: SpanOptions = {}): Promise<T> {
    const {
      spanId: explicitSpanId,
      parentSpanId: explicitParentSpanId,
      captureState,
      ...meta
    } = options;
    const spanId = explicitSpanId ?? newSpanId();
    const stateBefore = captureState ? snapshot(captureState) : UNCAPTURED;
    const start = performance.now();

    try {
      const result = await runInSpan(spanId, () => fn());
      const duration = performance.now() - start;
      this.finishSpan(
        name,
        spanId,
        explicitParentSpanId,
        duration,
        withStateDiff(meta, captureState, stateBefore),
      );
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.finishSpan(
        name,
        spanId,
        explicitParentSpanId,
        duration,
        withStateDiff(meta, captureState, stateBefore),
        error,
      );
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
      span_id: spanId,
      duration_ms: Math.round(durationMs * 1000) / 1000,
      ...meta,
    };
    if (explicitParentSpanId !== undefined) {
      fullMeta.parent_span_id = explicitParentSpanId;
    }
    fullMeta.kind ??= "span";
    if (error !== undefined) {
      fullMeta.error = formatSpanError(error);
    }
    this.dispatch(error !== undefined ? Level.ERROR : Level.INFO, name, fullMeta);
  }
}
