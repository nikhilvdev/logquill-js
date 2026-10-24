import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectingTransport,
  disable,
  enable,
  isEnabled,
  Logger,
  RetryTracker,
  type LogRecord,
} from "../../src/index.js";
import { resetToggleRules } from "../../src/core/toggle.js";

afterEach(() => {
  resetToggleRules();
  vi.restoreAllMocks();
});

const named = (name: string): Logger => new Logger(name);

describe("disable() / enable()", () => {
  it("silences a logger and everything nested under it, but not a sibling with a shared prefix", () => {
    disable("mylib");
    expect(named("mylib").info("x")).toBeNull();
    expect(named("mylib.http").info("x")).toBeNull();
    expect(named("mylib2").info("x")).not.toBeNull();
    expect(isEnabled("other")).toBe(true);
  });

  it("the most specific rule wins", () => {
    disable("mylib");
    enable("mylib.http");
    expect(named("mylib.http").info("x")).not.toBeNull();
    expect(named("mylib.http.client").info("x")).not.toBeNull();
    expect(named("mylib.db").info("x")).toBeNull();
  });

  it("disable() with no name turns everything off, and enable() turns it back on", () => {
    disable();
    expect(named("anything").info("x")).toBeNull();
    enable();
    expect(named("anything").info("x")).not.toBeNull();
  });

  it("rejects a non-string name", () => {
    expect(() => {
      disable(42 as unknown as string);
    }).toThrow(/take a logger name/);
  });
});

describe("opt({ lazy })", () => {
  it("calls function-valued meta only when the record will really be emitted", () => {
    const logger = new Logger("app", { level: "INFO" });
    const expensive = vi.fn(() => "dump");
    expect(logger.opt({ lazy: true }).debug("filtered", { dump: expensive })).toBeNull();
    expect(expensive).not.toHaveBeenCalled();

    const record = logger.opt({ lazy: true }).info("kept", { dump: expensive });
    expect(expensive).toHaveBeenCalledOnce();
    expect(record?.meta.dump).toBe("dump");
  });

  it("does not call them at all for a disabled logger", () => {
    disable("app");
    const expensive = vi.fn(() => 1);
    new Logger("app").opt({ lazy: true }).info("x", { v: expensive });
    expect(expensive).not.toHaveBeenCalled();
  });

  it("turns a throwing function into a placeholder instead of throwing into the caller", () => {
    const record = new Logger("app").opt({ lazy: true }).info("x", {
      bad: () => {
        throw new TypeError("boom");
      },
    });
    expect(record?.meta.bad).toBe("<lazy value raised TypeError: boom>");
  });

  it("leaves functions alone when lazy is off", () => {
    const fn = () => 1;
    expect(new Logger("app").info("x", { fn })?.meta.fn).toBe(fn);
  });
});

describe("opt({ depth })", () => {
  function wrapper(logger: Logger, depth: number): LogRecord | null {
    return logger.opt({ depth }).info("from wrapper");
  }

  it("depth 0 names the code that called the log method", () => {
    const record = new Logger("app").opt({ depth: 0 }).info("here");
    const caller = record?.meta.caller as { function: string; file: string; line: number };
    expect(caller.file).toContain("logger-api.test");
    expect(caller.line).toBeGreaterThan(0);
  });

  it("depth 1 inside a wrapper names the wrapper's caller, not the wrapper", () => {
    const record = wrapper(new Logger("app"), 1);
    const caller = record?.meta.caller as { function: string };
    expect(caller.function).not.toMatch(/wrapper/);
    const direct = wrapper(new Logger("app"), 0);
    expect((direct?.meta.caller as { function: string }).function).toMatch(/wrapper/);
  });

  it("returns no caller (rather than throwing) when the stack is not that deep", () => {
    const record = new Logger("app").opt({ depth: 500 }).info("x");
    expect(record).not.toBeNull();
    expect(record?.meta).not.toHaveProperty("caller");
  });

  it("does not overwrite a caller the call site supplied", () => {
    expect(new Logger("app").opt({ depth: 0 }).info("x", { caller: "mine" })?.meta.caller).toBe(
      "mine",
    );
  });

  it("rejects a negative or fractional depth", () => {
    expect(() => new Logger("app").opt({ depth: -1 })).toThrow(/non-negative integer/);
    expect(() => new Logger("app").opt({ depth: 1.5 })).toThrow(/non-negative integer/);
  });
});

describe("opt() views", () => {
  it("caches one view per combination", () => {
    const logger = new Logger("app");
    expect(logger.opt({ lazy: true })).toBe(logger.opt({ lazy: true }));
    expect(logger.opt({ depth: 1 })).toBe(logger.opt({ depth: 1 }));
    expect(logger.opt({ lazy: true })).not.toBe(logger.opt());
  });

  it("stops caching past 32 combinations but keeps working", () => {
    const logger = new Logger("app");
    for (let depth = 0; depth < 40; depth += 1) logger.opt({ depth });
    expect(logger.opt({ depth: 39 })).not.toBe(logger.opt({ depth: 39 }));
    expect(logger.opt({ depth: 39 }).info("x")).not.toBeNull();
  });

  it("every method goes through the logger's level, plugins and transports", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink], plugins: [(r) => r] });
    const view = logger.opt({ lazy: true });
    view.thought("t");
    view.action("a");
    view.observation("o");
    view.decision("d");
    view.warn("w");
    await logger.flush();
    expect(sink.records.map((r) => r.meta.kind ?? r.level)).toEqual([
      "thought",
      "action",
      "observation",
      "decision",
      "WARN",
    ]);
  });
});

describe("llmCall()", () => {
  it("logs an action carrying the llm block in snake_case", () => {
    const record = new Logger("app").llmCall(
      {
        model: "gpt-4o",
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.0002,
        latencyMs: 12.5,
        finishReason: "stop",
      },
      { provider: "openai" },
    );
    expect(record?.llm).toEqual({
      model: "gpt-4o",
      tokens_in: 10,
      tokens_out: 20,
      cost_usd: 0.0002,
      latency_ms: 12.5,
      finish_reason: "stop",
    });
    expect(record).toMatchObject({
      message: "llm_call",
      meta: { kind: "action", provider: "openai" },
    });
  });

  it("omits fields you leave out, and the whole block if nothing is left", () => {
    expect(new Logger("app").llmCall({ model: "m" })?.llm).toEqual({ model: "m" });
    expect(new Logger("app").llmCall({})).not.toHaveProperty("llm");
  });

  it("accepts a custom message", () => {
    expect(new Logger("app").llmCall({ message: "summarize", model: "m" })?.message).toBe(
      "summarize",
    );
  });

  it("drops a field of the wrong type with a warning naming it, rather than throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const record = new Logger("app").llmCall({
      model: "m",
      tokensIn: -1,
      tokensOut: 1.5,
      costUsd: "free" as unknown as number,
      latencyMs: Number.NaN,
    });
    expect(record?.llm).toEqual({ model: "m" });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /tokensIn=-1.*non-negative integer/,
    );
  });

  it("is written by the JSON formatter with the llm block", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink] });
    logger.llmCall({ model: "m", tokensIn: 1 });
    await logger.flush();
    expect(JSON.parse(sink.formatted[0] ?? "{}")).toMatchObject({
      schema_version: "2.0",
      llm: { model: "m", tokens_in: 1 },
    });
  });

  it("works through opt()", () => {
    expect(new Logger("app").opt({ lazy: true }).llmCall({ model: "m" })?.llm).toEqual({
      model: "m",
    });
  });
});

describe("retry tracking", () => {
  const action = (logger: Logger, tool = "search", extra: Record<string, unknown> = {}) =>
    logger.action("call", { tool, ...extra });

  it("stamps retry_count on a reopened tool action, not on the first attempt", () => {
    const logger = new Logger("app");
    expect(action(logger)?.meta).not.toHaveProperty("retry_count");
    expect(action(logger)?.meta.retry_count).toBe(1);
    expect(action(logger)?.meta.retry_count).toBe(2);
  });

  it("a successful observation ends the chain", () => {
    const logger = new Logger("app");
    action(logger);
    action(logger);
    logger.observation("ok", { tool: "search" });
    expect(action(logger)?.meta).not.toHaveProperty("retry_count");
  });

  it("an errored observation does not end the chain", () => {
    const logger = new Logger("app");
    action(logger);
    logger.observation("failed", { tool: "search", error: "timeout" });
    expect(action(logger)?.meta.retry_count).toBe(1);
  });

  it("tracks tools and call ids independently, and ignores records with no tool", () => {
    const logger = new Logger("app");
    action(logger, "a");
    action(logger, "b");
    expect(action(logger, "a")?.meta.retry_count).toBe(1);
    expect(action(logger, "b", { tool_call_id: "c2" })?.meta).not.toHaveProperty("retry_count");
    expect(logger.action("no tool")?.meta).not.toHaveProperty("retry_count");
  });

  it("keeps a retry_count the call site set, and never mutates the caller's meta", () => {
    const logger = new Logger("app");
    const meta = { tool: "search" };
    logger.action("x", meta);
    logger.action("x", meta);
    expect(meta).toEqual({ tool: "search" });
    expect(logger.action("x", { tool: "search", retry_count: 9 })?.meta.retry_count).toBe(9);
  });

  it("scopes a chain to the enclosing span", async () => {
    const logger = new Logger("app");
    action(logger);
    await logger.span("inner", () => {
      expect(action(logger)?.meta).not.toHaveProperty("retry_count");
    });
  });

  it("RetryTracker is bounded: the oldest in-flight call is forgotten first", () => {
    const tracker = new RetryTracker(2);
    tracker.opened(undefined, "a");
    tracker.opened(undefined, "b");
    tracker.opened(undefined, "c"); // evicts "a"
    expect(tracker.opened(undefined, "a")).toBe(0);
    expect(tracker.opened(undefined, "c")).toBe(1);
    expect(() => new RetryTracker(0)).toThrow(/maxEntries/);
  });
});

describe("span({ captureState })", () => {
  async function spanRecord(
    run: (state: Record<string, unknown>) => void | Promise<void>,
    state: Record<string, unknown> = { a: 1, b: 2 },
    contentPolicy: "full" | "off" = "full",
  ): Promise<LogRecord | undefined> {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink], contentPolicy });
    await logger.span("work", () => run(state), { captureState: () => state });
    await logger.flush();
    return sink.records[0];
  }

  it("records only the keys that changed, before and after", async () => {
    const record = await spanRecord((s) => {
      s.b = 3;
      s.c = 4;
    });
    expect(record?.meta.state_diff).toEqual({ before: { b: 2 }, after: { b: 3, c: 4 } });
  });

  it("sees an in-place mutation of nested state (the snapshot is a copy)", async () => {
    const state = { list: [1] };
    const record = await spanRecord((s) => {
      (s.list as number[]).push(2);
    }, state);
    expect(record?.meta.state_diff).toEqual({ before: { list: [1] }, after: { list: [1, 2] } });
  });

  it("omits state_diff when nothing changed", async () => {
    expect((await spanRecord(() => undefined))?.meta).not.toHaveProperty("state_diff");
  });

  it("still records a diff when the block throws", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink], contentPolicy: "full" });
    const state = { n: 0 };
    await expect(
      logger.span(
        "fails",
        () => {
          state.n = 1;
          throw new Error("x");
        },
        { captureState: () => state },
      ),
    ).rejects.toThrow("x");
    await logger.flush();
    expect(sink.records[0]?.meta.state_diff).toEqual({ before: { n: 0 }, after: { n: 1 } });
  });

  it("a state that cannot be copied, or a callback that throws, just means no state_diff", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink], contentPolicy: "full" });
    await logger.span("a", () => undefined, { captureState: () => ({ fn: () => 1 }) });
    await logger.span("b", () => undefined, {
      captureState: () => {
        throw new Error("nope");
      },
    });
    await logger.flush();
    expect(sink.records).toHaveLength(2);
    for (const record of sink.records) expect(record.meta).not.toHaveProperty("state_diff");
  });

  it("is a content field: the default policy replaces it with a placeholder", async () => {
    const record = await spanRecord(
      (s) => {
        s.a = 99;
      },
      { a: 1 },
      "off",
    );
    expect(record?.meta.state_diff).toMatch(/content capture is off/);
  });

  it("diffs non-object state as a whole value", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app", { transports: [sink], contentPolicy: "full" });
    let counter = 1;
    await logger.span(
      "n",
      () => {
        counter = 2;
      },
      { captureState: () => counter },
    );
    await logger.flush();
    expect(sink.records[0]?.meta.state_diff).toEqual({ before: 1, after: 2 });
  });
});
