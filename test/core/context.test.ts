import { describe, expect, it } from "vitest";
import { bindContext, currentContext, Logger } from "../../src/index.js";

describe("bindContext / currentContext", () => {
  it("is empty outside any bound block", () => {
    expect(currentContext()).toEqual({});
  });

  it("is visible to a direct log call inside the block", () => {
    const logger = new Logger("app.test");

    const record = bindContext({ requestId: "abc123" }, () => logger.info("handled"));

    expect(record?.meta.requestId).toBe("abc123");
  });

  it("is visible through nested function calls with no manual threading", () => {
    const logger = new Logger("app.test");

    function handleRequest() {
      return logger.info("deep call");
    }

    const record = bindContext({ requestId: "abc123" }, handleRequest);

    expect(record?.meta.requestId).toBe("abc123");
  });

  it("survives an internal await", async () => {
    const logger = new Logger("app.test");

    const record = await bindContext({ requestId: "abc123" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return logger.info("after await");
    });

    expect(record?.meta.requestId).toBe("abc123");
  });

  it("restores the outer context once the block exits", () => {
    const logger = new Logger("app.test");

    bindContext({ requestId: "abc123" }, () => {
      /* no-op */
    });

    expect(logger.info("outside")?.meta.requestId).toBeUndefined();
  });

  it("nested blocks merge, with the inner value winning on collision", () => {
    const logger = new Logger("app.test");

    const record = bindContext({ requestId: "outer", service: "api" }, () =>
      bindContext({ requestId: "inner" }, () => logger.info("nested")),
    );

    expect(record?.meta.requestId).toBe("inner");
    expect(record?.meta.service).toBe("api");
  });

  it("a call-site meta value always wins over bound context", () => {
    const logger = new Logger("app.test");

    const record = bindContext({ requestId: "abc123" }, () =>
      logger.info("call site wins", { requestId: "explicit" }),
    );

    expect(record?.meta.requestId).toBe("explicit");
  });

  it("concurrent async operations don't leak context into each other", async () => {
    const logger = new Logger("app.test");
    const results: Record<string, unknown>[] = [];

    async function run(requestId: string, delayMs: number) {
      await bindContext({ requestId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const record = logger.info("concurrent");
        if (record) {
          results.push(record.meta);
        }
      });
    }

    await Promise.all([run("first", 10), run("second", 0)]);

    const first = results.find((meta) => meta.requestId === "first");
    const second = results.find((meta) => meta.requestId === "second");
    expect(first?.requestId).toBe("first");
    expect(second?.requestId).toBe("second");
  });
});
