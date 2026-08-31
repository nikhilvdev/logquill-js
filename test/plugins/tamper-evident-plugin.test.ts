import { describe, expect, it } from "vitest";
import { GENESIS_HASH, Logger, TamperEvidentPlugin, type LogRecord } from "../../src/index.js";

describe("TamperEvidentPlugin", () => {
  it("each record gets a hash and prevHash", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });

    const record = logger.info("hello");

    expect(record).not.toBeNull();
    expect(typeof record?.meta.hash).toBe("string");
    expect(record?.meta.prevHash).toBe(GENESIS_HASH);
  });

  it("the chain links consecutive records", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });

    const first = logger.info("one");
    const second = logger.info("two");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.meta.prevHash).toBe(first?.meta.hash);
  });

  it("verifyChain passes on an untampered log", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });
    const records = Array.from({ length: 5 }, (_, i) => logger.info(`event ${String(i)}`, { n: i })) as LogRecord[];

    expect(TamperEvidentPlugin.verifyChain(records)).toBe(true);
  });

  it("verifyChain detects an edited message", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });
    const records = Array.from({ length: 5 }, (_, i) => logger.info(`event ${String(i)}`, { n: i })) as LogRecord[];
    const tampered = records.map((r) => ({ ...r, meta: { ...r.meta } }));
    tampered[2] = { ...tampered[2], message: "edited after the fact" } as LogRecord;

    expect(TamperEvidentPlugin.verifyChain(tampered)).toBe(false);
  });

  it("verifyChain detects a removed record", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });
    const records = Array.from({ length: 5 }, (_, i) => logger.info(`event ${String(i)}`, { n: i })) as LogRecord[];
    const tampered = [...records.slice(0, 2), ...records.slice(3)]; // remove index 2

    expect(TamperEvidentPlugin.verifyChain(tampered)).toBe(false);
  });

  it("verifyChain detects reordered records", () => {
    const logger = new Logger("app.test", { plugins: [new TamperEvidentPlugin()] });
    const records = Array.from({ length: 3 }, (_, i) => logger.info(`event ${String(i)}`, { n: i })) as LogRecord[];
    const reordered = [records[1], records[0], records[2]] as LogRecord[];

    expect(TamperEvidentPlugin.verifyChain(reordered)).toBe(false);
  });

  it("verifyChain on empty input is true", () => {
    expect(TamperEvidentPlugin.verifyChain([])).toBe(true);
  });
});
