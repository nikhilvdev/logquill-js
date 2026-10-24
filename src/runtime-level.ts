import { readFileSync } from "node:fs";
import type { Logger } from "./core/logger.js";

/**
 * Changing a `Logger`'s level at runtime, without restarting the process.
 *
 * Three independent mechanisms; pick whichever your deployment has available:
 *
 * - {@link installSignalLevelHandler}: an OS signal re-reads an environment
 *   variable and applies it.
 * - {@link LevelFileWatcher}: polls a file an orchestrator (or you, by hand)
 *   writes a level name into.
 * - {@link LevelEnvWatcher}: polls an environment variable that something
 *   *inside this same process* updates. An environment change made from outside
 *   the process is never visible to code already running in it, so use the file
 *   or the signal for anything triggered externally.
 *
 * An unrecognized or missing value is ignored with a warning in every case;
 * none of these may ever throw out of a signal handler or a timer.
 */

function applyLevel(logger: Logger, raw: string | undefined, source: string): void {
  const value = raw?.trim();
  if (!value) return;
  try {
    logger.setLevel(value);
  } catch {
    console.warn(
      `logquill: ignoring ${source}=${JSON.stringify(raw)} for logger ${JSON.stringify(logger.name)} — not a valid level name (TRACE, DEBUG, INFO, WARN, ERROR, FATAL) or number`,
    );
  }
}

/** Options for {@link installSignalLevelHandler}. */
export interface SignalLevelHandlerOptions {
  /** Signal to listen for. Default `"SIGUSR2"`: Node reserves `SIGUSR1` for the inspector. */
  signal?: NodeJS.Signals;
  /** Environment variable re-read when the signal arrives. Default `"LOGQUILL_LEVEL"`. */
  envVar?: string;
}

/**
 * Registers a handler so sending the signal to this process (default
 * `SIGUSR2`: `kill -USR2 <pid>`) re-reads an environment variable and applies it
 * via `logger.setLevel()`. Returns a function that removes the handler.
 *
 * Note an environment variable changed from outside the process isn't visible
 * to it, so the usual pairing is a config reload that updates `process.env`
 * before the signal arrives; for a level written from outside, use
 * {@link LevelFileWatcher}. Throws on Windows, which has no `SIGUSR2`.
 */
export function installSignalLevelHandler(
  logger: Logger,
  options: SignalLevelHandlerOptions = {},
): () => void {
  if (process.platform === "win32") {
    throw new Error(
      "installSignalLevelHandler(): Windows has no SIGUSR2 — use LevelFileWatcher or LevelEnvWatcher instead, which don't need a POSIX signal",
    );
  }
  const signal = options.signal ?? "SIGUSR2";
  const envVar = options.envVar ?? "LOGQUILL_LEVEL";
  const handler = (): void => {
    applyLevel(logger, process.env[envVar], envVar);
  };
  process.on(signal, handler);
  return () => {
    process.off(signal, handler);
  };
}

/** Options shared by the polling watchers. */
export interface LevelWatcherOptions {
  /** How often to check, in milliseconds. Default 2000. */
  pollIntervalMs?: number;
}

/** Polls a source on a timer and applies it whenever its value changes. */
class PollingLevelWatcher {
  private timer: NodeJS.Timeout | undefined;
  private lastSeen: string | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly sourceName: string,
    private readonly read: () => string | undefined,
    private readonly pollIntervalMs: number,
  ) {}

  /** Checks the source once and applies it if it changed since the last check. Exposed so a test, or a caller on its own schedule, can drive this with no timer. */
  pollOnce(): void {
    const raw = this.read();
    if (raw !== this.lastSeen) {
      this.lastSeen = raw;
      applyLevel(this.logger, raw, this.sourceName);
    }
  }

  /** Starts polling. The timer is unref'd, so it never keeps the process alive. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.pollOnce();
    this.timer = setInterval(() => {
      this.pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  /** Stops polling. Safe to call if never started, or more than once. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Polls a file's content (a bare level name like `DEBUG`, or a number) and
 * applies it via `logger.setLevel()` whenever it changes: for an orchestrator
 * (or you, by hand: `echo DEBUG > /tmp/app.level`) that can write a file but not
 * send a signal. A missing file is not an error, only "no change" until it
 * reappears.
 */
export class LevelFileWatcher extends PollingLevelWatcher {
  constructor(logger: Logger, path: string, options: LevelWatcherOptions = {}) {
    super(
      logger,
      path,
      () => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      },
      options.pollIntervalMs ?? 2000,
    );
  }
}

/**
 * Polls `process.env[envVar]` and applies it via `logger.setLevel()` whenever
 * it changes. Only helps when something inside this same process changes the
 * environment (a config reload, `dotenv` with `override`, your own code): see
 * the note at the top of this module.
 */
export class LevelEnvWatcher extends PollingLevelWatcher {
  constructor(logger: Logger, envVar: string, options: LevelWatcherOptions = {}) {
    super(logger, envVar, () => process.env[envVar], options.pollIntervalMs ?? 2000);
  }
}
