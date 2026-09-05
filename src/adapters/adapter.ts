import type { Logger } from "../core/logger.js";

/**
 * Base for framework tracing adapters. A concrete adapter holds a
 * reference to the `Logger` to forward events onto (`this.log`) and
 * overrides only the events its framework actually emits — translating
 * them into `.thought()/.action()/.observation()/.decision()` calls and
 * `span()`-shaped records. Always a thin mapping from the framework's
 * native event shape onto LogQuill's, never a reimplementation of tracing
 * logic per framework.
 *
 * `LangChainAdapter` doesn't literally extend this: it has to extend
 * LangChain's own `BaseCallbackHandler` instead (JS classes support only
 * single inheritance), so it holds the same `log` reference itself rather
 * than inheriting it. This base is for adapters that don't need to
 * subclass a framework SDK class.
 */
export abstract class LogQuillAdapter {
  /**
   * @param log The `Logger` every translated event is forwarded onto.
   */
  constructor(protected readonly log: Logger) {}
}
