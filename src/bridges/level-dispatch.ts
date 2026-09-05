import { Level } from "../core/levels.js";
import type { Logger } from "../core/logger.js";

/** Calls the `Logger` method matching `level` — shared by every bridge that maps another library's numeric/string level onto ours. */
export function callAtLevel(
  log: Logger,
  level: Level,
  message: string,
  meta: Record<string, unknown>,
): void {
  switch (level) {
    case Level.TRACE:
      log.trace(message, meta);
      return;
    case Level.DEBUG:
      log.debug(message, meta);
      return;
    case Level.INFO:
      log.info(message, meta);
      return;
    case Level.WARN:
      log.warn(message, meta);
      return;
    case Level.ERROR:
      log.error(message, meta);
      return;
    case Level.FATAL:
      log.fatal(message, meta);
      return;
  }
}
