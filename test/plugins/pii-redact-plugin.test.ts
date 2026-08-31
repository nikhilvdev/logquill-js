import { describe, expect, it } from "vitest";
import { Logger, PIIRedactPlugin } from "../../src/index.js";

describe("PIIRedactPlugin", () => {
  it("redacts an email in a string value", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("signup", { note: "contact me at jane.doe@example.com please" });

    expect(record).not.toBeNull();
    expect(record?.meta.note).not.toContain("jane.doe@example.com");
    expect(record?.meta.note).toContain("***");
  });

  it("redacts an SSN regardless of key name", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("free text field", { notes: "ssn on file: 123-45-6789" });

    expect(record).not.toBeNull();
    expect(record?.meta.notes).not.toContain("123-45-6789");
  });

  it("redacts a phone number", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("contact", { note: "call me at 415-555-0199" });

    expect(record).not.toBeNull();
    expect(record?.meta.note).not.toContain("415-555-0199");
  });

  it("leaves non-string values untouched", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("counts", { userId: 42, active: true, ratio: 0.5 });

    expect(record).not.toBeNull();
    expect(record?.meta).toEqual({ userId: 42, active: true, ratio: 0.5 });
  });

  it("redacts a credit card number", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("payment", { note: "card on file: 4242 4242 4242 4242" });

    expect(record).not.toBeNull();
    expect(record?.meta.note).not.toContain("4242 4242 4242 4242");
  });

  it("redacts recursively through arrays", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("array meta", { pair: ["a@example.com", "safe"] });

    expect(record).not.toBeNull();
    const pair = record?.meta.pair as string[];
    expect(pair[0]).toBe("***");
    expect(pair[1]).toBe("safe");
  });

  it("redacts recursively through nested objects and arrays", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });

    const record = logger.info("nested", {
      user: { email: "a@example.com", tags: ["contact: b@example.com"] },
    });

    expect(record).not.toBeNull();
    const user = record?.meta.user as { email: string; tags: string[] };
    expect(user.email).not.toContain("a@example.com");
    expect(user.tags[0]).not.toContain("b@example.com");
  });

  it("a circular reference does not crash", () => {
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin()] });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const record = logger.info("cyclic", { data: cyclic });

    expect(record).not.toBeNull(); // must not throw / hang
  });

  it("custom patterns override the defaults", () => {
    const custom = { employeeId: /\bEMP-\d{4}\b/ };
    const logger = new Logger("app.test", { plugins: [new PIIRedactPlugin({ patterns: custom, replacement: "[X]" })] });

    const record = logger.info("badge scan", { note: "badge EMP-1234 scanned, ssn 123-45-6789 ignored" });

    expect(record).not.toBeNull();
    expect(record?.meta.note).not.toContain("EMP-1234");
    expect(record?.meta.note).toContain("123-45-6789"); // default ssn pattern not active
  });
});
