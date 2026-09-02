/**
 * Framework tracing adapters for LangChain.js and LangGraph.js — a
 * separate entry point (`import ... from "logquill/langchain"`), not part
 * of the main `logquill` import. `LangChainAdapter` has to `extend`
 * LangChain's own `BaseCallbackHandler`, a hard static import; keeping it
 * out of the main entry point means a plain `import { Logger } from
 * "logquill"` never requires `@langchain/core` to be installed.
 */
export { LogQuillAdapter } from "./adapters/adapter.js";
export { LangChainAdapter } from "./adapters/langchain-adapter.js";
export { LangGraphAdapter } from "./adapters/langgraph-adapter.js";
