import type { Serialized } from "@langchain/core/load/serializable";
import { describe, expect, it } from "vitest";
import { LangChainAdapter } from "../../src/adapters/langchain-adapter.js";
import { LangGraphAdapter } from "../../src/adapters/langgraph-adapter.js";
import { CollectingTransport, Logger } from "../../src/index.js";

function serialized(name: string): Serialized {
  return { name } as unknown as Serialized;
}

describe("LangGraphAdapter", () => {
  it("is a LangChainAdapter — LangGraph.js nodes run as ordinary LangChain Runnables", () => {
    const logger = new Logger("app.agent");
    const handler = new LangGraphAdapter(logger);

    expect(handler).toBeInstanceOf(LangChainAdapter);
  });

  it("handles the same chain/LLM/tool events identically to LangChainAdapter", () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", { transports: [sink] });
    const handler = new LangGraphAdapter(logger);

    handler.handleChainStart(serialized("graph_node"), {}, "node-1");
    handler.handleChainEnd({}, "node-1", undefined);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.message).toBe("graph_node");
    expect(sink.records[0]?.meta.kind).toBe("span");
  });
});
