import { describe, expect, it } from "vitest";
import { Logger, SamplingPlugin } from "../../src/index.js";

describe("SamplingPlugin", () => {
  it("rate 0 drops everything", () => {
    const logger = new Logger("app.test", { plugins: [new SamplingPlugin(0)] });

    expect(logger.info("hello")).toBeNull();
  });

  it("rate 1 keeps everything", () => {
    const logger = new Logger("app.test", { plugins: [new SamplingPlugin(1)] });

    expect(logger.info("hello")).not.toBeNull();
  });

  it("throws on an invalid rate", () => {
    expect(() => new SamplingPlugin(1.5)).toThrow(/rate must be between 0 and 1/);
    expect(() => new SamplingPlugin(-0.1)).toThrow(/rate must be between 0 and 1/);
  });

  it("a custom rng controls keep or drop", () => {
    const keep = new SamplingPlugin(0.5, { rng: () => 0.1 });
    const drop = new SamplingPlugin(0.5, { rng: () => 0.9 });

    const loggerKeep = new Logger("app.test", { plugins: [keep] });
    const loggerDrop = new Logger("app.test", { plugins: [drop] });

    expect(loggerKeep.info("hello")).not.toBeNull();
    expect(loggerDrop.info("hello")).toBeNull();
  });
});
