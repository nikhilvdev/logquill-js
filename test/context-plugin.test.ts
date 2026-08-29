import { describe, expect, it } from "vitest";
import { ContextPlugin, Logger } from "../src/index.js";

describe("ContextPlugin", () => {
  it("injects fixed context into meta", () => {
    const logger = new Logger("app.test", { plugins: [new ContextPlugin({ service: "api", env: "prod" })] });

    const record = logger.info("hello", { user_id: 42 });

    expect(record?.meta).toEqual({ service: "api", env: "prod", user_id: 42 });
  });

  it("call-site meta overrides fixed context", () => {
    const logger = new Logger("app.test", { plugins: [new ContextPlugin({ env: "prod" })] });

    const record = logger.info("hello", { env: "staging" });

    expect(record?.meta.env).toBe("staging");
  });
});
