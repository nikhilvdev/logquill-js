import type { Serialized } from "@langchain/core/load/serializable";
import { describe, expect, it } from "vitest";
import { LangChainAdapter } from "../../src/adapters/langchain-adapter.js";
import { CollectingTransport, Logger, RunPlugin } from "../../src/index.js";

function serialized(name: string): Serialized {
  return { name } as unknown as Serialized;
}

describe("LangChainAdapter", () => {
  it("reconstructs a full run's span tree from a mix of events", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", {
      transports: [sink],
      plugins: [new RunPlugin({ runId: "run-1" })],
    });
    const handler = new LangChainAdapter(logger);

    handler.handleChainStart(serialized("agent_chain"), {}, "chain-1");
    handler.handleLLMStart(serialized("llm"), ["hi"], "llm-1", "chain-1");
    handler.handleLLMEnd({ generations: [] }, "llm-1", "chain-1");
    handler.handleToolStart(serialized("search"), "query", "tool-1", "chain-1");
    handler.handleToolEnd("result", "tool-1", "chain-1");
    handler.handleAgentEnd({ returnValues: {}, log: "" }, "chain-1");
    handler.handleChainEnd({}, "chain-1", undefined);
    await logger.flush();

    const kinds = sink.records.map((r) => r.meta.kind);
    expect(kinds).toEqual(["action", "observation", "action", "observation", "decision", "span"]);

    const [llmStart, llmEnd, toolStart, toolEnd, finish, chainClose] = sink.records;

    expect(llmStart?.meta.spanId).toBe("llm-1");
    expect(llmStart?.meta.parentSpanId).toBe("chain-1");
    expect(llmEnd?.meta.spanId).toBe("llm-1");
    expect(typeof llmEnd?.meta.durationMs).toBe("number");

    expect(toolStart?.meta.spanId).toBe("tool-1");
    expect(toolStart?.meta.parentSpanId).toBe("chain-1");
    expect(typeof toolEnd?.meta.durationMs).toBe("number");

    // handleAgentEnd shares the chain's own runId rather than minting a
    // fresh one, so it's linked via parentSpanId, not given a spanId of its own.
    expect(finish?.meta.spanId).toBeUndefined();
    expect(finish?.meta.parentSpanId).toBe("chain-1");

    expect(chainClose?.meta.spanId).toBe("chain-1");
    expect(chainClose?.meta.parentSpanId).toBeUndefined();
    expect(typeof chainClose?.meta.durationMs).toBe("number");
    expect(chainClose?.message).toBe("agent_chain");

    // every record shares the runId RunPlugin attached to the logger
    expect(new Set(sink.records.map((r) => r.meta.runId))).toEqual(new Set(["run-1"]));
  });

  it("nested chains link via parentSpanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleChainStart(serialized("outer"), {}, "outer-1");
    // `handleChainStart` doesn't consume `parentRunId` (only start time and
    // the chain's own name), so nesting is exercised entirely through
    // `handleChainEnd`'s `parentRunId` argument below.
    handler.handleChainStart(serialized("inner"), {}, "inner-1");
    handler.handleChainEnd({}, "inner-1", "outer-1");
    handler.handleChainEnd({}, "outer-1", undefined);
    await logger.flush();

    const [innerClose, outerClose] = sink.records;
    expect(innerClose?.meta.spanId).toBe("inner-1");
    expect(innerClose?.meta.parentSpanId).toBe("outer-1");
    expect(outerClose?.meta.spanId).toBe("outer-1");
    expect(outerClose?.meta.parentSpanId).toBeUndefined();
  });

  it("a chain error closes the span at ERROR level", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleChainStart(serialized("chain"), {}, "chain-1");
    handler.handleChainError(new Error("boom"), "chain-1", undefined);
    await logger.flush();

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(record?.level).toBe("ERROR");
    expect(record?.meta.error).toContain("boom");
    expect(record?.meta.kind).toBe("span");
  });

  it("a tool error logs at ERROR level with the tool's spanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleToolStart(serialized("search"), "query", "tool-1");
    handler.handleToolError(new Error("tool broke"), "tool-1", undefined);
    await logger.flush();

    expect(sink.records).toHaveLength(2);
    const errorRecord = sink.records[1];
    expect(errorRecord?.level).toBe("ERROR");
    expect(errorRecord?.meta.error).toBe("Error: tool broke");
    expect(errorRecord?.meta.spanId).toBe("tool-1");
  });

  it("a non-Error throw (a tool's _call can legally throw anything) doesn't corrupt or crash", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleToolStart(serialized("search"), "query", "tool-1");
    handler.handleToolStart(serialized("search"), "query", "tool-2");

    // a bare string: doesn't throw either way, but naively reading
    // `.name`/`.message` off it silently produces "undefined: undefined"
    expect(() => {
      handler.handleToolError("tool broke", "tool-1", undefined);
    }).not.toThrow();
    await logger.flush();
    expect(sink.records[2]?.meta.error).toBe("tool broke");

    // `null`: `.name`/`.message` on it throws outright — this is the case
    // that would previously crash the handler itself
    expect(() => {
      handler.handleToolError(null, "tool-2", undefined);
    }).not.toThrow();
    await logger.flush();
    expect(sink.records[3]?.meta.error).toBe("null");
  });

  it("an LLM error logs at ERROR level", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleLLMStart(serialized("llm"), ["hi"], "llm-1");
    handler.handleLLMError(new Error("rate limited"), "llm-1", undefined);
    await logger.flush();

    expect(sink.records).toHaveLength(2);
    expect(sink.records[1]?.level).toBe("ERROR");
    expect(sink.records[1]?.meta.error).toBe("Error: rate limited");
  });

  it("falls back to the last id segment when serialized.name is absent", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    const unnamed = {
      lc: 1,
      type: "not_implemented",
      id: ["langchain_core", "runnables", "RunnableLambda"],
    } as unknown as Serialized;

    handler.handleChainStart(unnamed, {}, "chain-1");
    handler.handleChainEnd({}, "chain-1", undefined);
    await logger.flush();

    expect(sink.records[0]?.message).toBe("RunnableLambda");
  });

  it("handleAgentAction maps to .action() with parentSpanId", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangChainAdapter(logger);

    handler.handleAgentAction({ tool: "calculator", toolInput: "2+2", log: "" }, "chain-1");
    await logger.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.message).toBe("calculator");
    expect(sink.records[0]?.meta.kind).toBe("action");
    expect(sink.records[0]?.meta.parentSpanId).toBe("chain-1");
  });
});
