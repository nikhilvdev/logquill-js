import type { Formatter } from "../core/formatter.js";
import { Level, parseLevel } from "../core/levels.js";
import type { LogRecord } from "../core/records.js";
import { Transport } from "./transport.js";

const COLORS: Readonly<Record<Level, string>> = {
  [Level.TRACE]: "\x1b[90m", // gray
  [Level.DEBUG]: "\x1b[36m", // cyan
  [Level.INFO]: "\x1b[32m", // green
  [Level.WARN]: "\x1b[33m", // yellow
  [Level.ERROR]: "\x1b[31m", // red
  [Level.FATAL]: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/** The subset of `console` this transport needs — swap in a fake for tests. */
export interface ConsoleLike {
  log(message: string): void;
  error(message: string): void;
}

export interface ConsoleTransportOptions {
  formatter?: Formatter;
  colorize?: boolean;
  console?: ConsoleLike;
}

function defaultColorize(): boolean {
  // Isomorphic guard: `process` doesn't exist in a browser bundle.
  const env: NodeJS.ProcessEnv | undefined = typeof process === "undefined" ? undefined : process.env;
  return env?.NO_COLOR === undefined;
}

/**
 * Writes to `console.log`, routing ERROR/FATAL to `console.error`, colorized by
 * level. Uses the global `console` rather than Node's `process.stdout`/`stderr`
 * so this transport works unmodified in a browser bundle.
 */
export class ConsoleTransport extends Transport {
  colorize: boolean;
  private readonly out: ConsoleLike;

  constructor(options: ConsoleTransportOptions = {}) {
    super(options.formatter);
    this.colorize = options.colorize ?? defaultColorize();
    this.out = options.console ?? console;
  }

  write(formatted: string, record: LogRecord): void {
    const level = parseLevel(record.level);
    const line = this.colorize ? this.applyColor(formatted, level) : formatted;
    if (level >= Level.ERROR) {
      this.out.error(line);
    } else {
      this.out.log(line);
    }
  }

  private applyColor(formatted: string, level: Level): string {
    return `${COLORS[level]}${formatted}${RESET}`;
  }
}
