import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogRecord } from "../../src/index.js";
import { spanIdFor, traceIdFor, traceIdFromParent } from "../../src/otel/ids.js";
import {
  CONVENTION_VERSION,
  captureContentEnabled,
  epochHr,
  hrMinusMs,
  isLlmRecord,
  isSpanRecord,
  isToolRecord,
  llmSpec,
  logAttributes,
  resolveConvention,
  spanSpec,
  toolSpec,
} from "../../src/otel/semconv.js";

const latest = resolveConvention("latest");
const legacy = resolveConvention("legacy");

const record = (extra: Partial<LogRecord> & { meta?: Record<string, unknown> }): LogRecord => ({
  schema_version: "2.0",
  timestamp: "2026-01-01T00:00:00.500Z",
  level: "INFO",
  logger: "app.agent",
  message: "m",
  meta: {},
  ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConvention", () => {
  it("defaults to the latest names, and an explicit choice wins over the environment", () => {
    expect(resolveConvention(undefined, {}).version).toBe(CONVENTION_VERSION);
    expect(
      resolveConvention("legacy", { OTEL_SEMCONV_STABILITY_OPT_IN: "gen_ai_latest_experimental" })
        .version,
    ).toBe("legacy");
  });

  it("reads OTEL_SEMCONV_STABILITY_OPT_IN, including from a comma-separated list", () => {
    expect(
      resolveConvention(undefined, {
        OTEL_SEMCONV_STABILITY_OPT_IN: "http, gen_ai_latest_experimental",
      }).version,
    ).toBe(CONVENTION_VERSION);
  });

  it("never emits old and new names together: a /dup opt-in warns once and uses one generation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { OTEL_SEMCONV_STABILITY_OPT_IN: "gen_ai_latest_experimental/dup" };
    expect(resolveConvention(undefined, env).version).toBe(CONVENTION_VERSION);
    resolveConvention(undefined, env);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects an unknown generation, naming the valid ones", () => {
    expect(() => resolveConvention("v9")).toThrow(/must be one of latest, legacy/);
  });

  it("captureContentEnabled follows the standard environment switch, case-insensitively", () => {
    expect(captureContentEnabled({})).toBe(false);
    expect(
      captureContentEnabled({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: " TRUE " }),
    ).toBe(true);
    expect(captureContentEnabled({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "1" })).toBe(
      false,
    );
  });
});

describe("llmSpec", () => {
  const llmRecord = record({
    llm: {
      model: "gpt-4o",
      tokens_in: 10,
      tokens_out: 20,
      cost_usd: 0.002,
      latency_ms: 1500,
      finish_reason: "stop",
    },
    meta: {
      kind: "action",
      provider: "openai",
      response_model: "gpt-4o-2026",
      thread_id: "t1",
      run_id: "r1",
      retry_count: 2,
    },
  });

  it("maps the llm block onto the latest GenAI names", () => {
    const spec = llmSpec(llmRecord, latest);
    expect(spec).toMatchObject({
      name: "chat gpt-4o",
      kind: "client",
      durationMs: 1500,
      isError: false,
    });
    expect(spec.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.response.model": "gpt-4o-2026",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.conversation.id": "t1",
      "logquill.cost_usd": 0.002,
      "logquill.run_id": "r1",
      "logquill.retry_count": 2,
    });
  });

  it("legacy names differ in exactly the provider and token attributes, and the two never mix", () => {
    const attrs = llmSpec(llmRecord, legacy).attributes;
    expect(attrs["gen_ai.system"]).toBe("openai");
    expect(attrs["gen_ai.usage.prompt_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.completion_tokens"]).toBe(20);
    expect(attrs).not.toHaveProperty("gen_ai.provider.name");
    expect(attrs).not.toHaveProperty("gen_ai.usage.input_tokens");
  });

  it("uses the default provider when the record names none, and text_completion when asked", () => {
    const spec = llmSpec(
      record({ llm: { model: "m" }, meta: { operation: "text_completion" } }),
      latest,
      { defaultProvider: "azure" },
    );
    expect(spec.name).toBe("text_completion m");
    expect(spec.attributes["gen_ai.provider.name"]).toBe("azure");
    expect(llmSpec(record({ llm: {} }), latest).name).toBe("chat");
  });

  it("exports prompt and completion text only when capture is on", () => {
    const withContent = record({
      llm: { model: "m" },
      meta: { input_messages: [{ role: "user" }], output_messages: ["x"] },
    });
    expect(llmSpec(withContent, latest).attributes).not.toHaveProperty("gen_ai.input.messages");
    const on = llmSpec(withContent, latest, { captureContent: true }).attributes;
    expect(on["gen_ai.input.messages"]).toBe('[{"role":"user"}]');
    expect(on["gen_ai.output.messages"]).toBe('["x"]');
  });

  it("marks an error from meta.error or an ERROR level, with error.type taken from the message head", () => {
    const typed = llmSpec(record({ llm: {}, meta: { error: "TimeoutError: too slow" } }), latest);
    expect(typed.isError).toBe(true);
    expect(typed.attributes["error.type"]).toBe("TimeoutError");
    expect(
      llmSpec(record({ llm: {}, meta: { error: "it broke badly" } }), latest).attributes[
        "error.type"
      ],
    ).toBe("_OTHER");
    expect(llmSpec(record({ llm: {}, level: "ERROR" }), latest).isError).toBe(true);
  });

  it("attaches a state_diff as an event", () => {
    const spec = llmSpec(
      record({ llm: {}, meta: { state_diff: { before: { a: 1 }, after: { a: 2 } } } }),
      latest,
    );
    expect(spec.events).toEqual([
      ["logquill.state_diff", { "logquill.state": '{"before":{"a":1},"after":{"a":2}}' }],
    ]);
  });
});

describe("toolSpec and spanSpec", () => {
  it("toolSpec is execute_tool {tool} with the call id and duration", () => {
    const rec = record({
      meta: { kind: "action", tool: "search", tool_call_id: "c1", duration_ms: 5 },
    });
    expect(isToolRecord(rec)).toBe(true);
    expect(toolSpec(rec, latest)).toMatchObject({
      name: "execute_tool search",
      kind: "internal",
      durationMs: 5,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "search",
        "gen_ai.tool.call.id": "c1",
      },
    });
  });

  it("an ordinary span keeps its own name and carries no GenAI operation", () => {
    const rec = record({
      message: "load_docs",
      meta: { kind: "span", span_id: "abc", duration_ms: 3 },
    });
    expect(isSpanRecord(rec)).toBe(true);
    const spec = spanSpec(rec, latest);
    expect(spec).toMatchObject({ name: "load_docs", kind: "internal", durationMs: 3 });
    expect(spec.attributes).not.toHaveProperty("gen_ai.operation.name");
  });

  it("a span that names an agent (or says invoke_agent) is an invoke_agent span", () => {
    const named = spanSpec(
      record({ meta: { kind: "span", span_id: "a", agent_name: "planner", agent_id: "p1" } }),
      latest,
    );
    expect(named).toMatchObject({ name: "invoke_agent planner", kind: "client" });
    expect(named.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "p1",
      "gen_ai.provider.name": "unknown",
    });
    expect(
      spanSpec(record({ meta: { kind: "span", span_id: "a", operation: "invoke_agent" } }), latest)
        .name,
    ).toBe("invoke_agent app.agent");
  });

  it("is not fooled by a record that is none of the three kinds", () => {
    const plain = record({ meta: { kind: "thought" } });
    expect([isLlmRecord(plain), isToolRecord(plain), isSpanRecord(plain)]).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("logAttributes", () => {
  it("gives a log record the llm block's model and usage under the same names as its span", () => {
    const attrs = logAttributes(
      record({ llm: { model: "m", tokens_in: 1, tokens_out: 2, finish_reason: "length" } }),
      latest,
    );
    expect(attrs).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "m",
      "gen_ai.usage.input_tokens": 1,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.response.finish_reasons": ["length"],
    });
    expect(logAttributes(record({}), latest)).toEqual({});
  });
});

describe("time helpers", () => {
  it("epochHr keeps millisecond precision, and hrMinusMs borrows across a second", () => {
    expect(epochHr("2026-01-01T00:00:00.500Z")).toEqual([1767225600, 500_000_000]);
    expect(hrMinusMs([100, 200_000_000], 1500)).toEqual([98, 700_000_000]);
    expect(hrMinusMs([100, 900_000_000], 0.25)).toEqual([100, 899_750_000]);
  });
});

describe("ids", () => {
  it("match the ids logquill-python derives, so a trace that crosses both lines up", () => {
    expect(spanIdFor("550e8400-e29b-41d4-a716-446655440000")).toBe("a3a9e1ed9732cab2");
    expect(spanIdFor("00f067aa0ba902b7")).toBe("00f067aa0ba902b7");
    expect(traceIdFor({ run_id: "run-1" })).toBe("cef38b0fc7db416194938237d5c0a942");
    expect(traceIdFor({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" })).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(traceIdFromParent("parent-1")).toBe("f77e8a9a212c97d3e39bb5cfa9547755");
  });

  it("an invalid trace id falls back to the run id, and a record naming neither has none", () => {
    expect(traceIdFor({ trace_id: "nope", run_id: "run-1" })).toBe(
      "cef38b0fc7db416194938237d5c0a942",
    );
    expect(traceIdFor({ trace_id: "0".repeat(32) })).toBeUndefined();
    expect(traceIdFor({})).toBeUndefined();
  });
});

describe("golden ids shared with logquill-python", () => {
  const golden = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "golden_otel_ids.json"),
      "utf8",
    ),
  ) as {
    span_id_for: { input: string; span_id: string }[];
    trace_id_for: { meta: Record<string, unknown>; trace_id: string | null }[];
    trace_id_from_parent: { input: string; trace_id: string }[];
  };

  it.each(golden.span_id_for.map((c) => [c.input, c] as const))("span id for %j", (_name, c) => {
    expect(spanIdFor(c.input)).toBe(c.span_id);
  });

  it.each(golden.trace_id_for.map((c) => [JSON.stringify(c.meta), c] as const))(
    "trace id for %s",
    (_name, c) => {
      expect(traceIdFor(c.meta) ?? null).toBe(c.trace_id);
    },
  );

  it.each(golden.trace_id_from_parent.map((c) => [c.input, c] as const))(
    "trace id from parent %j",
    (_name, c) => {
      expect(traceIdFromParent(c.input)).toBe(c.trace_id);
    },
  );
});

describe("isolation", () => {
  it("keeps every gen_ai.* attribute name in semconv.ts, so moving to a newer convention is a one-file change", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const offenders: string[] = [];
    // One recursive listing, then read: no stat-then-open step to race.
    for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".ts") || entry.endsWith(join("otel", "semconv.ts"))) continue;
      const code = readFileSync(join(srcDir, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/gen_ai\./.test(code)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
