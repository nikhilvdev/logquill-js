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
});
