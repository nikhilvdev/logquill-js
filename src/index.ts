export { Level, levelName, parseLevel } from "./levels.js";
export type { LevelInput } from "./levels.js";

export { createRecord, utcTimestamp } from "./records.js";
export type { LogRecord } from "./records.js";

export { JSONFormatter } from "./formatter.js";
export type { Formatter } from "./formatter.js";

export type { Plugin } from "./plugin.js";

export { CollectingTransport, Transport } from "./transport.js";

export { Logger } from "./logger.js";
export type { LoggerOptions } from "./logger.js";

export const VERSION = "0.1.1";
