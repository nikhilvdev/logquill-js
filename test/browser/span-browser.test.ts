import { describe, expect, it } from "vitest";
import { currentSpanId, newSpanId, runInSpan } from "../../src/core/span-browser.js";

describe("span-browser (the logquill/browser build's stack-based span context)", () => {
  it("has no active span outside runInSpan", () => {
    expect(currentSpanId()).toBeUndefined();
  });

  it("newSpanId returns a 16-hex-char id", () => {
    const id = newSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(newSpanId()).not.toBe(id);
  });

  it("runInSpan makes the id current for the duration of fn", () => {
    let seen: string | undefined;
    runInSpan("abc123", () => {
      seen = currentSpanId();
    });
    expect(seen).toBe("abc123");
    expect(currentSpanId()).toBeUndefined();
  });

  it("nested runInSpan calls form a stack, restored on exit", () => {
    const seen: (string | undefined)[] = [];
    runInSpan("outer", () => {
      seen.push(currentSpanId());
      runInSpan("inner", () => {
        seen.push(currentSpanId());
      });
      seen.push(currentSpanId());
    });
    expect(seen).toEqual(["outer", "inner", "outer"]);
  });

  it("pops its span even if fn throws", () => {
    expect(() =>
      runInSpan("risky", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentSpanId()).toBeUndefined();
  });

  it("survives an internal await for a single in-flight span", async () => {
    let seenDuringAwait: string | undefined;
    await runInSpan("abc123", async () => {
      await Promise.resolve();
      seenDuringAwait = currentSpanId();
    });
    expect(seenDuringAwait).toBe("abc123");
    expect(currentSpanId()).toBeUndefined();
  });

  it("pops an async fn's span even if it rejects", async () => {
    await expect(
      runInSpan("risky", async () => {
        await Promise.resolve();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(currentSpanId()).toBeUndefined();
  });

  it("documented limitation: two concurrent runInSpan calls across an await can interleave, unlike the Node build's AsyncLocalStorage-backed version", async () => {
    const seen: (string | undefined)[] = [];

    async function run(spanId: string) {
      return runInSpan(spanId, async () => {
        await Promise.resolve();
        seen.push(currentSpanId());
      });
    }

    await Promise.all([run("first"), run("second")]);

    // Both entries land on the same id — the interleaving `span-browser.ts`'s
    // own doc comment warns about, since both spans share one stack with no
    // way to tell which is "current" independent of call order.
    expect(seen[0]).toBe(seen[1]);
    expect(currentSpanId()).toBeUndefined();
  });
});
