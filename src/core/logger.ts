import { Level, parseLevel, type LevelInput } from "./levels.js";
import type { Plugin } from "./plugin.js";
import { createRecord, type LogRecord } from "./records.js";
import type { Transport } from "../transports/transport.js";

export interface LoggerOptions {
  level?: LevelInput;
  transports?: Transport[];
  plugins?: Plugin[];
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
    this.plugins = options.plugins ? [...options.plugins] : [];
    this.baseMeta = options.meta ? { ...options.meta } : {};
  }

  get level(): Level {
    return this.currentLevel;
  }

  setLevel(level: LevelInput): void {
    this.currentLevel = parseLevel(level);
  }

  /** Register a plugin. Returns `this` so calls can be chained. */
  use(plugin: Plugin): this {
    this.plugins.push(plugin);
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
      transport.write(transport.format(record), record);
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
}
