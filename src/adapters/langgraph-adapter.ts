import { LangChainAdapter } from "./langchain-adapter.js";

/**
 * `LangChainAdapter`, for use with LangGraph.js graphs — exported under its
 * own name for discoverability and parity with `logquill-python`'s
 * `LangGraphAdapter`. LangGraph.js nodes run as ordinary LangChain.js
 * `Runnable`s, so `LangChainAdapter`'s `handleChainStart`/`handleLLMStart`/
 * `handleToolStart`/etc. already fire exactly as they would for a plain
 * chain — no extra mapping needed.
 *
 * Unlike `logquill-python`, this class adds no extra event handling.
 * Python's `LangGraphAdapter` exists specifically to catch LangGraph
 * Python's own checkpoint pause/resume events (`on_interrupt`/`on_resume`),
 * which that ecosystem dispatches only to handlers implementing its own
 * `GraphCallbackHandler` — a plain `BaseCallbackHandler` subclass never
 * receives them there. LangGraph.js has no equivalent: as of `@langchain/
 * langgraph` 1.x it exposes no distinct callback-handler class or
 * `onInterrupt`/`onResume` hook — an `interrupt()` call instead pauses the
 * graph and surfaces in its state/stream output (under `__interrupt__`),
 * not through the callback-handler system at all. There is nothing this
 * class could subscribe to that `LangChainAdapter` doesn't already cover.
 *
 * ```ts
 * import { Logger, RunPlugin } from "logquill";
 * import { LangGraphAdapter } from "logquill/langchain";
 *
 * const handler = new LangGraphAdapter(log.child("agent").use(new RunPlugin()));
 * const graph = builder.compile({ checkpointer });
 * await graph.invoke(input, { callbacks: [handler], configurable: { thread_id: "1" } });
 * ```
 */
export class LangGraphAdapter extends LangChainAdapter {}
