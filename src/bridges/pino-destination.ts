import { Level } from "../core/levels.js";
import type { Logger } from "../core/logger.js";
import { callAtLevel } from "./level-dispatch.js";

/** Maps a pino numeric level to a LogQuill level. */
export type PinoLevelMap = Readonly<Record<number, Level>>;

/** pino's default numeric levels (`trace`=10 … `fatal`=60), mapped onto the matching LogQuill level. */
export const DEFAULT_PINO_LEVEL_MAP: PinoLevelMap = {
  10: Level.TRACE,
  20: Level.DEBUG,
  30: Level.INFO,
  40: Level.WARN,
  50: Level.ERROR,
  60: Level.FATAL,
};

/** Options for {@link LogQuillPinoDestination}. */
export interface LogQuillPinoDestinationOptions {
  /** Overrides `DEFAULT_PINO_LEVEL_MAP` — useful for a pino instance configured with custom levels. An unmapped level falls back to `INFO`. */
  levelMap?: PinoLevelMap;
}

/**
 * A pino `destination` — pass an instance directly as `pino(destination)`
 * to have pino's own NDJSON output parsed back into LogQuill calls, so an
 * existing `pino()` call site keeps working exactly as it does today while
 * its records also flow through every LogQuill `Transport`/`Plugin`
 * attached to the given `Logger` — handy for migrating incrementally
 * rather than in one PR.
 *
 * ```ts
 * import pino from "pino";
 * import { Logger, LogQuillPinoDestination } from "logquill";
 *
 * const logquill = new Logger("app");
 * const log = pino(new LogQuillPinoDestination(logquill));
 *
 * log.info({ userId: 42 }, "still works exactly as before");
 * ```
 *
 * No `pino` import needed here — a destination only has to be duck-type
 * compatible with a Node `Writable`'s `.write(chunk)`, so unlike the
 * `winston-transport`-based bridge, this needs no dependency on `pino`
 * itself and ships from the main entry point.
 *
 * pino batches writes over a fast, buffered stream, so a single `write()`
 * call can carry more than one NDJSON line; each complete line is parsed
 * and dispatched independently, and a line that fails to parse as JSON is
 * skipped rather than crashing the destination.
 */
export class LogQuillPinoDestination {
  /**
   * Pino only recognizes a bare object passed as its sole argument
   * (`pino(destination)`, without a separate options argument) as a
   * destination stream, rather than an options object, if it looks
   * stream-like — checking for `.writable`/`._writableState`, the same
   * duck-typing `stream.Writable` itself satisfies. Without this, `pino()`
   * would silently fall back to writing to `process.stdout` instead.
   */
  readonly writable = true;

  private readonly target: Logger;
  private readonly levelMap: PinoLevelMap;

  constructor(logquillLogger: Logger, options: LogQuillPinoDestinationOptions = {}) {
    this.target = logquillLogger;
    this.levelMap = options.levelMap ?? DEFAULT_PINO_LEVEL_MAP;
  }

  /** Node `Writable`-compatible write hook — splits `chunk` into NDJSON lines and dispatches each as a `Logger` call. */
  write(chunk: string): boolean {
    for (const line of chunk.split("\n")) {
      if (line.trim()) {
        this.writeLine(line);
      }
    }
    return true;
  }

  private writeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const entry = parsed as Record<string, unknown>;
    const pinoLevel = typeof entry.level === "number" ? entry.level : 30;
    const message = typeof entry.msg === "string" ? entry.msg : "";

    const meta: Record<string, unknown> = {};
    for (const key of Object.keys(entry)) {
      if (key !== "level" && key !== "msg") {
        meta[key] = entry[key];
      }
    }

    callAtLevel(this.target, this.levelMap[pinoLevel] ?? Level.INFO, message, meta);
  }
}
