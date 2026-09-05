import Transport from "winston-transport";
import { Level, parseLevel, type LevelInput } from "../core/levels.js";
import type { Logger } from "../core/logger.js";
import { callAtLevel } from "./level-dispatch.js";

/** Maps a winston level name to a LogQuill level. */
export type WinstonLevelMap = Readonly<Record<string, LevelInput>>;

/** winston's built-in `npm` levels (its default), mapped onto the closest LogQuill level. */
export const DEFAULT_WINSTON_LEVEL_MAP: WinstonLevelMap = {
  error: Level.ERROR,
  warn: Level.WARN,
  info: Level.INFO,
  http: Level.INFO,
  verbose: Level.DEBUG,
  debug: Level.DEBUG,
  silly: Level.TRACE,
};

/** Options for {@link LogQuillWinstonTransport}, extending winston-transport's own `TransportStreamOptions` (`level`, etc.). */
export interface LogQuillWinstonTransportOptions extends Transport.TransportStreamOptions {
  /** Overrides `DEFAULT_WINSTON_LEVEL_MAP` — useful for a winston logger configured with custom levels. An unmapped level falls back to `INFO`. */
  levelMap?: WinstonLevelMap;
}

/**
 * A `winston-transport` `Transport`, so an existing `winston.createLogger()`
 * app can add a LogQuill `Logger` as one more destination with no call-site
 * changes: every `.info()/.warn()/...` call already going through winston
 * keeps working exactly as it does today, and now also flows through this
 * transport into every LogQuill `Transport`/`Plugin` attached to the given
 * `Logger` — handy for migrating incrementally rather than in one PR.
 *
 * ```ts
 * import winston from "winston";
 * import { Logger } from "logquill";
 * import { LogQuillWinstonTransport } from "logquill/winston";
 *
 * const logquill = new Logger("app");
 * const winstonLogger = winston.createLogger({
 *   transports: [new LogQuillWinstonTransport(logquill)],
 * });
 *
 * winstonLogger.info("still works exactly as before", { userId: 42 });
 * ```
 *
 * winston's own level filtering (its logger's configured `level`, and this
 * transport's own `level` option) runs first, same as any other winston
 * transport; whatever reaches this transport is then mapped onto a LogQuill
 * level via `levelMap` and re-filtered by the LogQuill `Logger`'s own
 * `level` — the stricter of the two wins.
 *
 * Ships from a **separate entry point**, `import ... from "logquill/winston"`
 * — not the main `"logquill"` import — for the same reason `LangChainAdapter`
 * does: it has to `extends Transport`, `winston-transport`'s own class, a
 * hard static import. Keeping it out of the main entry point means a plain
 * `import { Logger } from "logquill"` never requires `winston-transport` to
 * be installed. `winston-transport` is an optional peer dependency.
 */
export class LogQuillWinstonTransport extends Transport {
  private readonly target: Logger;
  private readonly levelMap: WinstonLevelMap;

  constructor(logquillLogger: Logger, options: LogQuillWinstonTransportOptions = {}) {
    const { levelMap, ...transportOptions } = options;
    super(transportOptions);
    this.target = logquillLogger;
    this.levelMap = levelMap ?? DEFAULT_WINSTON_LEVEL_MAP;
  }

  /** winston-transport's own write hook — called by winston for every entry that reaches this transport. */
  log(info: unknown, callback: () => void): void {
    setImmediate(() => {
      this.emit("logged", info);
    });

    const entry = info as Record<string, unknown>;
    const winstonLevel = typeof entry.level === "string" ? entry.level : "info";
    const message = typeof entry.message === "string" ? entry.message : String(entry.message);

    const meta: Record<string, unknown> = {};
    for (const key of Object.keys(entry)) {
      if (key !== "level" && key !== "message") {
        meta[key] = entry[key];
      }
    }

    callAtLevel(this.target, parseLevel(this.levelMap[winstonLevel] ?? Level.INFO), message, meta);
    callback();
  }
}
