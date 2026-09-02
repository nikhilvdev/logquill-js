import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { ChainValues } from "@langchain/core/utils/types";
import type { Logger } from "../core/logger.js";

function spanIds(runId: string, parentRunId: string | undefined): Record<string, unknown> {
  const ids: Record<string, unknown> = { spanId: runId };
  if (parentRunId !== undefined) {
    ids.parentSpanId = parentRunId;
  }
  return ids;
}

/**
 * Prefers `serialized.name`, which most `Serialized` variants carry — but
 * a bare `RunnableLambda` (and other constructless runnables), verified
 * against `@langchain/core` 1.2.9, omits it. `id` (e.g.
 * `["langchain_core", "runnables", "RunnableLambda"]`) is present on
 * every `Serialized` variant, so its last segment — the class name — is a
 * more useful fallback than the generic `fallback` string.
 */
function serializedName(serialized: Serialized | undefined, fallback: string): string {
  const name = (serialized as { name?: unknown } | undefined)?.name;
  if (typeof name === "string" && name) {
    return name;
  }
  const lastIdSegment = serialized?.id.at(-1);
  return typeof lastIdSegment === "string" && lastIdSegment ? lastIdSegment : fallback;
}

// LangChain's `handle*Error` callbacks type their `error` parameter as
// `Error` (really `any` in the base class — see `type Error = any` in
// `@langchain/core`'s own `callbacks/base.d.ts`), but nothing enforces that
// at the actual throw site: a tool's `_call`, an LLM provider, or any
// chain step can `throw` a bare string or plain object just as validly.
// Trusting `Error` here would crash this adapter's own error handler on
// exactly the input it exists to report.
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Maps LangChain.js's `BaseCallbackHandler` events onto LogQuill calls —
 * LangGraph.js is covered for free (see `LangGraphAdapter`), since it
 * shares LangChain.js's callback system.
 *
 * Pass an instance into a chain/agent invocation's `callbacks: [...]`, the
 * same way any other LangChain tracing handler (LangSmith, Langfuse, ...)
 * is wired in — no other instrumentation needed:
 *
 * ```ts
 * import { Logger, RunPlugin } from "logquill";
 * import { LangChainAdapter } from "logquill/langchain";
 *
 * const handler = new LangChainAdapter(log.child("agent").use(new RunPlugin()));
 * const llm = new ChatOpenAI({ callbacks: [handler] });
 * ```
 *
 * Event mapping:
 *
 * | LangChain.js callback | LogQuill call |
 * |---|---|
 * | `handleChainStart` / `handleChainEnd` | one `span()`-shaped record on end/error |
 * | `handleLLMStart` / `handleLLMEnd` | `.action()` / `.observation()` with `durationMs` |
 * | `handleAgentAction` | `.action()` |
 * | `handleAgentEnd` | `.decision()` |
 * | `handleToolStart` / `handleToolEnd` / `handleToolError` | `.action()` / `.observation()` / `.error()` |
 *
 * LangChain's own `runId`/`parentRunId` are written directly onto
 * `meta.spanId`/`meta.parentSpanId` on every event — the shapes already
 * match, so this is field renaming, not translation. Chain start/end is
 * stamped manually (rather than via `Logger.span()`, which wraps a single
 * callback) into the same `{ kind: "span", spanId, parentSpanId,
 * durationMs }` shape `Logger.span()` itself produces, since LangChain
 * opens and closes a chain run from two separate, independently-scheduled
 * callback invocations — there's no single function to wrap.
 *
 * `handleAgentAction`/`handleAgentEnd` carry the *enclosing* chain's own
 * `runId` (LangChain doesn't mint a fresh one for these events), so it's
 * written as this record's `parentSpanId`, not `spanId` — using it as
 * `spanId` would make the record indistinguishable from the chain's own
 * span-closing record.
 */
export class LangChainAdapter extends BaseCallbackHandler {
  name = "logquill";

  private readonly log: Logger;
  private readonly callStarts = new Map<string, number>();
  private readonly chainNames = new Map<string, string>();

  constructor(agentLog: Logger) {
    super();
    this.log = agentLog;
  }

  private takeDurationMs(runId: string): number | undefined {
    const start = this.callStarts.get(runId);
    if (start === undefined) {
      return undefined;
    }
    this.callStarts.delete(runId);
    return Math.round((performance.now() - start) * 1000) / 1000;
  }

  // -- chains: one span()-shaped record on end/error --------------------
  // `handleChainEnd`/`handleChainError` don't receive the chain's
  // `Serialized` descriptor (only `handleChainStart` does), so the name is
  // captured at start and looked up again at end/error.

  handleChainStart(chain: Serialized, _inputs: ChainValues, runId: string): void {
    this.callStarts.set(runId, performance.now());
    this.chainNames.set(runId, serializedName(chain, "chain"));
  }

  handleChainEnd(_outputs: ChainValues, runId: string, parentRunId: string | undefined): void {
    const name = this.chainNames.get(runId) ?? "chain";
    this.chainNames.delete(runId);
    this.log.info(name, { kind: "span", ...spanIds(runId, parentRunId), durationMs: this.takeDurationMs(runId) });
  }

  handleChainError(err: unknown, runId: string, parentRunId: string | undefined): void {
    const name = this.chainNames.get(runId) ?? "chain";
    this.chainNames.delete(runId);
    this.log.error(name, {
      kind: "span",
      ...spanIds(runId, parentRunId),
      durationMs: this.takeDurationMs(runId),
      error: formatError(err),
    });
  }

  // -- LLM calls: action (start) / observation (end) ---------------------

  handleLLMStart(
    serialized: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
  ): void {
    this.callStarts.set(runId, performance.now());
    this.log.action(serializedName(serialized, "llm_start"), spanIds(runId, parentRunId));
  }

  handleLLMEnd(_output: LLMResult, runId: string, parentRunId: string | undefined): void {
    this.log.observation("llm_end", { ...spanIds(runId, parentRunId), durationMs: this.takeDurationMs(runId) });
  }

  handleLLMError(err: unknown, runId: string, parentRunId: string | undefined): void {
    this.takeDurationMs(runId);
    this.log.error("llm_error", { error: formatError(err), ...spanIds(runId, parentRunId) });
  }

  // -- agent-level events --------------------------------------------------

  handleAgentAction(action: AgentAction, runId: string): void {
    this.log.action(action.tool || "agent_action", { parentSpanId: runId });
  }

  handleAgentEnd(_action: AgentFinish, runId: string): void {
    this.log.decision("agent_finish", { parentSpanId: runId });
  }

  // -- tools: action (start) / observation (end) / error -------------------

  handleToolStart(
    serialized: Serialized,
    _input: string,
    runId: string,
    parentRunId?: string,
  ): void {
    this.callStarts.set(runId, performance.now());
    this.log.action(serializedName(serialized, "tool"), spanIds(runId, parentRunId));
  }

  handleToolEnd(_output: unknown, runId: string, parentRunId: string | undefined): void {
    this.log.observation("tool_end", { ...spanIds(runId, parentRunId), durationMs: this.takeDurationMs(runId) });
  }

  handleToolError(err: unknown, runId: string, parentRunId: string | undefined): void {
    this.takeDurationMs(runId);
    this.log.error("tool_error", { error: formatError(err), ...spanIds(runId, parentRunId) });
  }
}
