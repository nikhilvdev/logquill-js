import { Level } from "./levels.js";
import { buildLlmBlock, type LLMBlock, type LlmCallOptions, type LogRecord } from "./records.js";

/** Per-call options `Logger.opt()` hands to the logger's dispatch. */
export interface DispatchOptions {
  /** Call every function-valued `meta` entry, but only once the record is really going to be emitted. */
  lazy?: boolean;
  /** Add `meta.caller` naming the code that logged, this many frames above the direct caller. */
  depth?: number;
  /** The record's first-class LLM-call block. */
  llm?: LLMBlock;
}

/** What `OptLogger` needs from the logger it wraps. */
export interface OptTarget {
  /** @internal Dispatches one record with per-call options. */
  dispatch(
    level: Level,
    message: string,
    meta: Record<string, unknown>,
    options?: DispatchOptions,
  ): LogRecord | null;
}

/** Where a record was logged from, as `meta.caller` reports it. */
export interface CallerInfo {
  /** The function name, or `"<anonymous>"`. */
  function: string;
  /** The file path or URL the code was loaded from. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/**
 * Replaces every function value in `meta` with what it returns. A function that
 * throws must not crash the caller that is only trying to log, so it becomes a
 * placeholder naming the error instead.
 */
export function resolveLazy(meta: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "function") {
      try {
        resolved[key] = (value as () => unknown)();
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        resolved[key] = `<lazy value raised ${reason}>`;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

const V8_FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;
const GECKO_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/;

function parseFrame(line: string): CallerInfo | undefined {
  const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
  if (!match) return undefined;
  const [, name, file, row, column] = match;
  return {
    function: name || "<anonymous>",
    file: file ?? "",
    line: Number(row),
    column: Number(column),
  };
}

// Stack frames from inside `callerInfo`: [0] the "Error" header, [1] callerInfo,
// [2] Logger.dispatch, [3] the OptLogger method, [4] the code that logged (depth 0).
// So every OptLogger method must call `dispatch` directly for this count to hold.
const FRAMES_BEFORE_CALLER = 4;

/**
 * Where the code that logged is, `depth` frames further up the stack.
 * Returns `undefined` if the stack isn't that deep or can't be parsed.
 */
export function callerInfo(depth: number): CallerInfo | undefined {
  const frames = new Error().stack?.split("\n");
  const line = frames?.[FRAMES_BEFORE_CALLER + depth];
  return line === undefined ? undefined : parseFrame(line);
}

/**
 * A view of a `Logger` with per-call options applied, from `Logger.opt(...)`.
 * It has the same logging methods, and writes through the logger it came from:
 * same level, plugins and transports.
 *
 * - `lazy: true`: function-valued `meta` entries are called only if the record
 *   is actually going to be emitted, so an expensive value costs nothing when
 *   the logger's level filters the call out:
 *   `logger.opt({ lazy: true }).debug("state", { dump: () => expensiveDump() })`.
 * - `depth: N`: adds `meta.caller` (`function`, `file`, `line`, `column`) naming
 *   the code that logged, `N` frames up from the direct caller, for use inside a
 *   wrapper so the record points at the wrapper's caller.
 */
export class OptLogger {
  constructor(
    private readonly logger: OptTarget,
    private readonly options: { lazy: boolean; depth: number | undefined },
  ) {
    const { depth } = options;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
      throw new Error(`opt({ depth }) must be a non-negative integer, got ${String(depth)}`);
    }
  }

  private get dispatchOptions(): DispatchOptions {
    return {
      lazy: this.options.lazy,
      ...(this.options.depth === undefined ? {} : { depth: this.options.depth }),
    };
  }

  /** `Logger.trace` with this view's options. */
  trace(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.TRACE, message, meta, this.dispatchOptions);
  }

  /** `Logger.debug` with this view's options. */
  debug(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.DEBUG, message, meta, this.dispatchOptions);
  }

  /** `Logger.info` with this view's options. */
  info(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.INFO, message, meta, this.dispatchOptions);
  }

  /** `Logger.warn` with this view's options. */
  warn(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.WARN, message, meta, this.dispatchOptions);
  }

  /** `Logger.error` with this view's options. */
  error(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.ERROR, message, meta, this.dispatchOptions);
  }

  /** `Logger.fatal` with this view's options. */
  fatal(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(Level.FATAL, message, meta, this.dispatchOptions);
  }

  /** `Logger.thought` with this view's options. */
  thought(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(
      Level.INFO,
      message,
      { kind: "thought", ...meta },
      this.dispatchOptions,
    );
  }

  /** `Logger.action` with this view's options. */
  action(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(
      Level.INFO,
      message,
      { kind: "action", ...meta },
      this.dispatchOptions,
    );
  }

  /** `Logger.observation` with this view's options. */
  observation(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(
      Level.INFO,
      message,
      { kind: "observation", ...meta },
      this.dispatchOptions,
    );
  }

  /** `Logger.decision` with this view's options. */
  decision(message: string, meta: Record<string, unknown> = {}): LogRecord | null {
    return this.logger.dispatch(
      Level.INFO,
      message,
      { kind: "decision", ...meta },
      this.dispatchOptions,
    );
  }

  /** `Logger.llmCall` with this view's options. */
  llmCall(options: LlmCallOptions, meta: Record<string, unknown> = {}): LogRecord | null {
    const { message = "llm_call", ...fields } = options;
    const llm = buildLlmBlock(fields);
    return this.logger.dispatch(
      Level.INFO,
      message,
      { kind: "action", ...meta },
      { ...this.dispatchOptions, ...(llm === undefined ? {} : { llm }) },
    );
  }
}
