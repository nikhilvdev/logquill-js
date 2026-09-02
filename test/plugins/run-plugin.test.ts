import { describe, expect, it } from "vitest";
import { Logger, RunPlugin } from "../../src/index.js";

describe("RunPlugin", () => {
  it("generates a runId when none given", () => {
    const plugin = new RunPlugin();
    const logger = new Logger("app.test", { plugins: [plugin] });

    const record = logger.info("step");

    expect(record?.meta.runId).toBe(plugin.runId);
  });

  it("accepts an explicit runId", () => {
    const logger = new Logger("app.test", { plugins: [new RunPlugin({ runId: "run-123" })] });

    expect(logger.info("step")?.meta.runId).toBe("run-123");
  });

  it("increments step per record", () => {
    const logger = new Logger("app.test", { plugins: [new RunPlugin({ runId: "run-1" })] });

    expect(logger.info("one")?.meta.step).toBe(0);
    expect(logger.info("two")?.meta.step).toBe(1);
    expect(logger.info("three")?.meta.step).toBe(2);
  });

  it("does not override an existing runId", () => {
    const logger = new Logger("app.test", { plugins: [new RunPlugin({ runId: "run-1" })] });

    const record = logger.info("propagated", { runId: "upstream-run" });

    expect(record?.meta.runId).toBe("upstream-run");
  });

  it("two instances track independent counters", () => {
    const a = new Logger("app.a", { plugins: [new RunPlugin({ runId: "run-a" })] });
    const b = new Logger("app.b", { plugins: [new RunPlugin({ runId: "run-b" })] });

    a.info("a1");
    a.info("a2");
    const recordB = b.info("b1");

    expect(recordB?.meta.step).toBe(0);
    expect(recordB?.meta.runId).toBe("run-b");
  });
});
