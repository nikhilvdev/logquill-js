/**
 * Browser entry point (`import ... from "logquill/browser"`) — the
 * isomorphic core (`Logger`, levels, `JSONFormatter`, the plugin pipeline)
 * plus the two transports that make sense in a browser: `ConsoleTransport`
 * and `BeaconTransport`. Everything Node-only — `FileTransport`,
 * `HTTPTransport`, every SQL/NoSQL/queue/cloud-native transport, and the
 * LangChain adapters — is simply never imported here, so it's absent from
 * this entry's module graph, not just tree-shaken out of it.
 *
 * The one behavioral difference from `"logquill"`'s `Logger`: `.span()`'s
 * nesting is backed by a plain stack (`core/span-browser.ts`, swapped in
 * for `core/span.ts` via the `alias` in tsup.config.ts) instead of
 * `AsyncLocalStorage`, which browsers don't have. See that file for what
 * that trades away.
 */
export { Level, levelName, parseLevel } from "./core/levels.js";
export type { LevelInput } from "./core/levels.js";

export { createRecord, utcTimestamp } from "./core/records.js";
export type { LogRecord } from "./core/records.js";

export { JSONFormatter } from "./core/formatter.js";
export type { Formatter } from "./core/formatter.js";

export type { Plugin, MiddlewareFunc } from "./core/plugin.js";
export { FunctionPlugin } from "./core/plugin.js";

export { ContextPlugin } from "./plugins/context-plugin.js";

export { DEFAULT_REDACTED_KEYS, RedactPlugin } from "./plugins/redact-plugin.js";
export type { RedactPluginOptions } from "./plugins/redact-plugin.js";

export { DEFAULT_PII_PATTERNS, PIIRedactPlugin } from "./plugins/pii-redact-plugin.js";
export type { PIIRedactPluginOptions } from "./plugins/pii-redact-plugin.js";

export { SamplingPlugin } from "./plugins/sampling-plugin.js";
export type { SamplingPluginOptions } from "./plugins/sampling-plugin.js";

export { CollectingTransport, hasFlush, Transport } from "./transports/transport.js";
export type { FlushableTransport } from "./transports/transport.js";

export { ConsoleTransport } from "./transports/console-transport.js";
export type { ConsoleLike, ConsoleTransportOptions } from "./transports/console-transport.js";

export { BeaconTransport } from "./transports/beacon-transport.js";
export type { BeaconSender, BeaconTransportOptions } from "./transports/beacon-transport.js";

export { Logger } from "./core/logger.js";
export type { LoggerOptions, SpanOptions } from "./core/logger.js";
