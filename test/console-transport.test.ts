import { describe, expect, it } from "vitest";
import { ConsoleTransport, Logger, type ConsoleLike } from "../src/index.js";

function fakeConsole(): ConsoleLike & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    log(message: string) {
      outLines.push(message);
    },
    error(message: string) {
      errLines.push(message);
    },
  };
}

describe("ConsoleTransport", () => {
  it("writes to console.log, uncolored, when colorize is off", () => {
    const out = fakeConsole();
    const transport = new ConsoleTransport({ colorize: false, console: out });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");

    expect(out.outLines).toHaveLength(1);
    expect(out.outLines[0]).toContain("hello");
    expect(out.errLines).toHaveLength(0);
  });

  it("routes ERROR and above to console.error", () => {
    const out = fakeConsole();
    const transport = new ConsoleTransport({ colorize: false, console: out });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.error("boom");

    expect(out.outLines).toHaveLength(0);
    expect(out.errLines).toHaveLength(1);
    expect(out.errLines[0]).toContain("boom");
  });

  it("wraps output in ANSI codes when colorize is on", () => {
    const out = fakeConsole();
    const transport = new ConsoleTransport({ colorize: true, console: out });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");

    expect(out.outLines[0]?.startsWith("\x1b[")).toBe(true);
  });

  it("defaults colorize based on the NO_COLOR environment variable", () => {
    const original = process.env.NO_COLOR;
    try {
      process.env.NO_COLOR = "1";
      const withNoColor = new ConsoleTransport();
      expect(withNoColor.colorize).toBe(false);

      delete process.env.NO_COLOR;
      const withoutNoColor = new ConsoleTransport();
      expect(withoutNoColor.colorize).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = original;
      }
    }
  });
});
