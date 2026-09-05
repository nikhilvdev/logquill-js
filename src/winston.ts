/**
 * A `winston-transport`-based bridge — a separate entry point
 * (`import ... from "logquill/winston"`), not part of the main `logquill`
 * import. `LogQuillWinstonTransport` has to `extend` `winston-transport`'s
 * own `Transport` class, a hard static import; keeping it out of the main
 * entry point means a plain `import { Logger } from "logquill"` never
 * requires `winston-transport` to be installed.
 */
export {
  DEFAULT_WINSTON_LEVEL_MAP,
  LogQuillWinstonTransport,
} from "./bridges/winston-transport.js";
export type {
  LogQuillWinstonTransportOptions,
  WinstonLevelMap,
} from "./bridges/winston-transport.js";
