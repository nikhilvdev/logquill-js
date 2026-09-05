import { describe, expect, it } from "vitest";
import { Logger, RateLimitPlugin } from "../../src/index.js";

describe("RateLimitPlugin", () => {
  it("allows up to maxRecords per window", () => {
    const logger = new Logger("app.test", { plugins: [new RateLimitPlugin(2, 60)] });

    expect(logger.info("a")).not.toBeNull();
    expect(logger.info("b")).not.toBeNull();
    expect(logger.info("c")).toBeNull();
  });

  it("different levels have independent windows by default", () => {
    const logger = new Logger("app.test", { plugins: [new RateLimitPlugin(1, 60)] });

    expect(logger.info("a")).not.toBeNull();
    expect(logger.info("b")).toBeNull();
    expect(logger.error("c")).not.toBeNull();
  });

  it("window resets once perSeconds elapses", () => {
    let now = 0;
    const logger = new Logger("app.test", {
      plugins: [new RateLimitPlugin(1, 10, { clock: () => now })],
    });

    expect(logger.info("a")).not.toBeNull();
    expect(logger.info("b")).toBeNull();

    now = 10;
    expect(logger.info("c")).not.toBeNull();
  });

  it("a custom keyFunc groups by message", () => {
    const plugin = new RateLimitPlugin(1, 60, { keyFunc: (record) => record.message });
    const logger = new Logger("app.test", { plugins: [plugin] });

    expect(logger.info("retry")).not.toBeNull();
    expect(logger.info("retry")).toBeNull();
    expect(logger.info("other")).not.toBeNull();
  });

  it("maxKeys evicts the least-recently-seen key", () => {
    const plugin = new RateLimitPlugin(1, 60, { keyFunc: (record) => record.message, maxKeys: 2 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    expect(logger.info("k1")).not.toBeNull();
    expect(logger.info("k2")).not.toBeNull();
    expect(logger.info("k3")).not.toBeNull(); // evicts k1's window

    // k1 was evicted, so it's treated as a fresh key and allowed again.
    expect(logger.info("k1")).not.toBeNull();
  });

  it("throws for a maxRecords below 1", () => {
    expect(() => new RateLimitPlugin(0, 60)).toThrow();
  });

  it("throws for a non-positive perSeconds", () => {
    expect(() => new RateLimitPlugin(1, 0)).toThrow();
  });
});
