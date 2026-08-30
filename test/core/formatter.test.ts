import { describe, expect, it } from "vitest";
import { JSONFormatter, Logger } from "../../src/index.js";

describe("JSONFormatter", () => {
  it("round-trips a record", () => {
    const logger = new Logger("app.test");
    const record = logger.info("hello", { user_id: 42 });
    if (record === null) {
      throw new Error("expected a record");
    }

    const formatted = new JSONFormatter().format(record);
    const parsed: unknown = JSON.parse(formatted);

    expect(parsed).toEqual(record);
  });

  it("produces a compact JSON line with no extra whitespace", () => {
    const logger = new Logger("app.test");
    const record = logger.info("hello");
    if (record === null) {
      throw new Error("expected a record");
    }

    expect(new JSONFormatter().format(record)).not.toMatch(/[\n\t]| {2,}/);
  });
});
