import { describe, expect, it } from "vitest";
import { Logger, RedactPlugin } from "../src/index.js";

describe("RedactPlugin", () => {
  it("redacts default sensitive keys", () => {
    const logger = new Logger("app.test", { plugins: [new RedactPlugin()] });

    const record = logger.info("login", { password: "hunter2", user_id: 42 });

    expect(record?.meta.password).toBe("***");
    expect(record?.meta.user_id).toBe(42);
  });

  it("matches keys case-insensitively", () => {
    const logger = new Logger("app.test", { plugins: [new RedactPlugin()] });

    const record = logger.info("login", { Password: "hunter2" });

    expect(record?.meta.Password).toBe("***");
  });

  it("supports custom keys and replacement", () => {
    const logger = new Logger("app.test", {
      plugins: [new RedactPlugin({ keys: ["ssn"], replacement: "[REDACTED]" })],
    });

    const record = logger.info("submit", { ssn: "123-45-6789", password: "not redacted here" });

    expect(record?.meta.ssn).toBe("[REDACTED]");
    expect(record?.meta.password).toBe("not redacted here");
  });
});
