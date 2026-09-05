import { describe, expect, it } from "vitest";
import { bindContext, currentContext } from "../../src/core/context-browser.js";

describe("context-browser (the logquill/browser build's stack-based bindContext)", () => {
  it("is empty outside any bound block", () => {
    expect(currentContext()).toEqual({});
  });

  it("is visible inside the block", () => {
    const seen = bindContext({ requestId: "abc123" }, () => currentContext());
    expect(seen).toEqual({ requestId: "abc123" });
  });

  it("is visible through nested function calls with no manual threading", () => {
    function readContext() {
      return currentContext();
    }

    const seen = bindContext({ requestId: "abc123" }, readContext);
    expect(seen).toEqual({ requestId: "abc123" });
  });

  it("restores the outer context once the block exits", () => {
    bindContext({ requestId: "abc123" }, () => {
      /* no-op */
    });
    expect(currentContext()).toEqual({});
  });

  it("pops its frame even if fn throws", () => {
    expect(() =>
      bindContext({ requestId: "abc123" }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentContext()).toEqual({});
  });

  it("nested blocks merge, with the inner value winning on collision", () => {
    const seen = bindContext({ requestId: "outer", service: "api" }, () =>
      bindContext({ requestId: "inner" }, () => currentContext()),
    );
    expect(seen).toEqual({ requestId: "inner", service: "api" });
  });

  it("returns fn's return value", () => {
    const result = bindContext({ requestId: "abc123" }, () => 42);
    expect(result).toBe(42);
  });

  it("documented limitation: two concurrent bindContext calls across an await interleave, unlike the Node build's AsyncLocalStorage-backed version", async () => {
    const seenDuringSecond: (Record<string, unknown> | undefined)[] = [];

    async function run(requestId: string) {
      return bindContext({ requestId }, async () => {
        await Promise.resolve();
        seenDuringSecond.push(currentContext());
      });
    }

    // Both run() calls push onto the same shared stack; the second call's
    // bindContext frame sits on top of the first's for as long as both are
    // in flight, so after the first's `await` resumes, `currentContext()`
    // sees the *second* call's requestId, not its own — the interleaving
    // `core/context-browser.ts`'s own doc comment warns about.
    await Promise.all([run("first"), run("second")]);

    expect(seenDuringSecond).toEqual([{ requestId: "second" }, { requestId: "second" }]);
  });
});
