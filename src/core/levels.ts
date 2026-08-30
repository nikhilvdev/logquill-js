/** Log levels, shared by name and numeric weight with the logquill-python contract. */
export enum Level {
  TRACE = 5,
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  FATAL = 50,
}

const NAME_TO_LEVEL: Readonly<Record<string, Level>> = {
  TRACE: Level.TRACE,
  DEBUG: Level.DEBUG,
  INFO: Level.INFO,
  WARN: Level.WARN,
  ERROR: Level.ERROR,
  FATAL: Level.FATAL,
};

/** A level given as a `Level`, a level name (any case), or its numeric weight. */
export type LevelInput = Level | number | string;

/** The level's name, e.g. `levelName(Level.INFO) === "INFO"`. */
export function levelName(level: Level): string {
  return Level[level];
}

/** Normalize a level given as a `Level`, level name, or numeric weight. Throws if unknown. */
export function parseLevel(level: LevelInput): Level {
  if (typeof level === "string") {
    const parsed = NAME_TO_LEVEL[level.toUpperCase()];
    if (parsed === undefined) {
      throw new Error(`Unknown log level: ${level}`);
    }
    return parsed;
  }
  if (Level[level] === undefined) {
    throw new Error(`Unknown log level: ${String(level)}`);
  }
  return level;
}
