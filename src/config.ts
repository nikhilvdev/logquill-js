import { readFile } from "node:fs/promises";
import { extname, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSONFormatter, type Formatter } from "./core/formatter.js";
import { LogfmtFormatter } from "./core/logfmt-formatter.js";
import type { BackpressurePolicy, DispatchQueueOptions } from "./core/dispatch-queue.js";
import { Logger } from "./core/logger.js";
import type { Plugin } from "./core/plugin.js";
import { TextFormatter } from "./core/text-formatter.js";
import { ContextPlugin } from "./plugins/context-plugin.js";
import { PIIRedactPlugin } from "./plugins/pii-redact-plugin.js";
import { RedactPlugin } from "./plugins/redact-plugin.js";
import { RunPlugin } from "./plugins/run-plugin.js";
import { SamplingPlugin } from "./plugins/sampling-plugin.js";
import { TamperEvidentPlugin } from "./plugins/tamper-evident-plugin.js";
import { TraceContextPlugin } from "./plugins/trace-context-plugin.js";
import { ConsoleTransport } from "./transports/console-transport.js";
import { SyslogTransport } from "./transports/cloud/syslog-transport.js";
import { FileTransport } from "./transports/file-transport.js";
import { HTTPTransport } from "./transports/http-transport.js";
import type { Transport } from "./transports/transport.js";

/** One `transports`/`plugins` entry: a built-in `type`, or a `class` reference. */
export interface ConfigEntry {
  /** A built-in shortcut. Transports: `console`, `file`, `http`, `syslog`. Plugins: `context`, `redact`, `sampling`, `trace_context`, `run`, `pii_redact`, `tamper_evident`. */
  type?: string;
  /** `"<module>#<ExportName>"`, e.g. `"logquill#DatadogTransport"` or `"./my-transport.js#MyTransport"` (relative to the config file), for anything not built in. The class is constructed with `options` as its single argument. */
  class?: string;
  /** Constructor options; snake_case keys are accepted and converted to camelCase. */
  options?: Record<string, unknown>;
}

/** The config shape `loadConfig`/`loggerFromFile` read — the same one `logquill-python` reads. */
export interface LoggerConfig {
  /** Logger name. Defaults to the name passed to the loader (`"app"`). */
  name?: string;
  /** Minimum level, e.g. `"INFO"`. Default `"INFO"`. */
  level?: string;
  /** Transports to build, in order. */
  transports?: ConfigEntry[];
  /** Plugins to build, in order. */
  plugins?: ConfigEntry[];
  /** Max pending records in the dispatch queue (`max_queue_size` also accepted). */
  maxQueueSize?: number;
  /** `dropOldest` | `dropNewest` | `block` (`drop_oldest` etc. also accepted). */
  backpressure?: string;
}

type Options = Record<string, unknown>;

const camel = (text: string): string =>
  text.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

function camelizeKeys(options: Options): Options {
  return Object.fromEntries(Object.entries(options).map(([k, v]) => [camel(k), v]));
}

const FORMATTERS: Record<string, () => Formatter> = {
  json: () => new JSONFormatter(),
  text: () => new TextFormatter(),
  logfmt: () => new LogfmtFormatter(),
};

/** A config file can't hold a formatter instance, so a transport's `formatter` may name a built-in one. */
function resolveFormatter(options: Options): Options {
  const { formatter } = options;
  if (typeof formatter !== "string") return options;
  const make = FORMATTERS[formatter];
  if (!make) {
    throw new Error(
      `Unknown formatter '${formatter}' — built-in formatters are: ${Object.keys(FORMATTERS).join(", ")}.`,
    );
  }
  return { ...options, formatter: make() };
}

function required(options: Options, key: string, type: string): string {
  const value = options[key];
  if (typeof value !== "string") {
    throw new Error(`'${type}' needs options.${key} (a string), got ${JSON.stringify(value)}`);
  }
  return value;
}

function without(options: Options, key: string): Options {
  return Object.fromEntries(Object.entries(options).filter(([k]) => k !== key));
}

const TRANSPORT_TYPES: Record<string, (o: Options) => Transport> = {
  console: (o) => new ConsoleTransport(o),
  file: (o) => new FileTransport(required(o, "path", "file"), without(o, "path")),
  http: (o) => new HTTPTransport(required(o, "url", "http"), without(o, "url")),
  syslog: (o) => new SyslogTransport(o),
};

const PLUGIN_TYPES: Record<string, (o: Options) => Plugin> = {
  context: (o) => new ContextPlugin(o),
  redact: (o) => new RedactPlugin(o),
  sampling: (o) => {
    if (typeof o.rate !== "number") throw new Error("'sampling' needs options.rate (a number)");
    return new SamplingPlugin(o.rate, without(o, "rate"));
  },
  traceContext: (o) => new TraceContextPlugin(o),
  run: (o) => new RunPlugin(o),
  piiRedact: (o) => new PIIRedactPlugin(o),
  tamperEvident: (o) => new TamperEvidentPlugin(o),
};

async function build<T>(
  entries: ConfigEntry[] | undefined,
  registry: Record<string, (o: Options) => T>,
  kind: string,
  baseDir: string,
): Promise<T[]> {
  const built: T[] = [];
  for (const entry of entries ?? []) {
    // `context` fields are user data, not option names, so their casing is left alone.
    const raw = entry.options ?? {};
    const type = entry.type === undefined ? undefined : camel(entry.type);
    if (entry.class !== undefined) {
      const [moduleName, exportName] = entry.class.split("#");
      if (!moduleName || !exportName) {
        throw new Error(
          `'class' must look like "<module>#<ExportName>" (e.g. "logquill#DatadogTransport"), got ${JSON.stringify(entry.class)}`,
        );
      }
      // A relative path means "relative to the config", not to this library's own files.
      const specifier = moduleName.startsWith(".")
        ? pathToFileURL(resolve(baseDir, moduleName)).href
        : moduleName;
      const mod = (await import(specifier)) as Record<string, unknown>;
      const Ctor = mod[exportName] as (new (options: Options) => T) | undefined;
      if (typeof Ctor !== "function") {
        throw new Error(
          `${JSON.stringify(entry.class)}: module '${moduleName}' has no export '${exportName}'`,
        );
      }
      built.push(new Ctor(resolveFormatter(camelizeKeys(raw))));
    } else if (type !== undefined) {
      const make = registry[type];
      if (!make) {
        throw new Error(
          `Unknown ${kind} type '${entry.type ?? ""}' — built-in types are: ${Object.keys(registry).join(", ")}. Use 'class': '<module>#<ExportName>' for anything else.`,
        );
      }
      built.push(make(resolveFormatter(type === "context" ? raw : camelizeKeys(raw))));
    } else {
      throw new Error(
        `Each ${kind} entry needs a 'type' or 'class' key, got ${JSON.stringify(entry)}`,
      );
    }
  }
  return built;
}

/**
 * Builds a `Logger` from an already-parsed config object:
 *
 *     {
 *       "name": "app", "level": "INFO",
 *       "transports": [
 *         { "type": "console", "options": { "formatter": "text" } },
 *         { "type": "file", "options": { "path": "app.log" } }
 *       ],
 *       "plugins": [{ "type": "sampling", "options": { "rate": 0.1 } }],
 *       "max_queue_size": 10000, "backpressure": "drop_oldest"
 *     }
 *
 * `class` entries import and construct arbitrary code (a `./relative` module is
 * resolved against `baseDir`, which `loggerFromFile` sets to the config file's
 * directory), so only load config you trust, as with any deployment config. Python's `async_dispatch` and
 * `flush_at_exit` keys are ignored: dispatch here is always async, and
 * shutdown flushing is opt-in via `installShutdownHandlers(logger)`.
 */
export async function loadConfig(
  data: Record<string, unknown>,
  defaultName = "app",
  baseDir = process.cwd(),
): Promise<Logger> {
  const config = camelizeKeys(data) as LoggerConfig;
  const queue: DispatchQueueOptions = {
    ...(config.maxQueueSize === undefined ? {} : { maxSize: config.maxQueueSize }),
    ...(config.backpressure === undefined
      ? {}
      : { policy: camel(config.backpressure) as BackpressurePolicy }),
  };
  return new Logger(config.name ?? defaultName, {
    level: config.level ?? "INFO",
    transports: await build(config.transports, TRANSPORT_TYPES, "transport", baseDir),
    plugins: await build(config.plugins, PLUGIN_TYPES, "plugin", baseDir),
    queue,
  });
}

/**
 * Loads a `Logger` from a `.json`, `.yaml` or `.yml` file — see
 * {@link loadConfig} for the shape. YAML needs the optional `yaml` package.
 */
export async function loggerFromFile(path: string, name = "app"): Promise<Logger> {
  const text = await readFile(path, "utf8");
  let data: unknown;
  if (extname(path) === ".yaml" || extname(path) === ".yml") {
    const moduleName = "yaml";
    try {
      data = ((await import(moduleName)) as { parse(text: string): unknown }).parse(text);
    } catch (error) {
      throw new Error(
        "loggerFromFile(...) with a .yaml/.yml file requires the optional `yaml` package — install it with `npm install yaml`.",
        { cause: error },
      );
    }
  } else {
    data = JSON.parse(text);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      `${path}: config must be an object with keys like level, transports and plugins`,
    );
  }
  return loadConfig(data as Record<string, unknown>, name, dirname(path));
}

/**
 * Builds a `Logger` from environment variables. `{prefix}CONFIG_FILE`, if set,
 * is loaded via {@link loggerFromFile} first (the full config isn't practical
 * as flat variables); `{prefix}LEVEL`, if set, is applied last and always
 * wins, even over a level in the file.
 */
export async function loggerFromEnv(prefix = "LOGQUILL_", name = "app"): Promise<Logger> {
  const configFile = process.env[`${prefix}CONFIG_FILE`];
  const logger = configFile ? await loggerFromFile(configFile, name) : new Logger(name);
  const level = process.env[`${prefix}LEVEL`];
  if (level) logger.setLevel(level);
  return logger;
}
