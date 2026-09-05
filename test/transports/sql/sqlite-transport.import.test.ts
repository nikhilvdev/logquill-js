import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { SQLiteTransport } from "../../../src/transports/sql/sqlite-transport.js";

const runCalls: unknown[][] = [];
let constructedFilename: string | undefined;
let execCalls = 0;

vi.mock("better-sqlite3", () => ({
  default: class {
    constructor(filename: string) {
      constructedFilename = filename;
    }
    exec() {
      execCalls++;
    }
    prepare() {
      return {
        run: (...params: unknown[]) => {
          runCalls.push(params);
        },
      };
    }
    transaction(fn: (...args: never[]) => void) {
      return (...args: never[]) => {
        fn(...args);
      };
    }
  },
}));

describe("SQLiteTransport (auto-imported `better-sqlite3` driver)", () => {
  it("builds a real Database and inserts through it when no client is injected", async () => {
    const transport = new SQLiteTransport({ filename: "/tmp/custom.db" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedFilename).toBe("/tmp/custom.db");
    expect(runCalls).toHaveLength(1);
    expect(execCalls).toBe(0);
  });

  it("runs createTableSQL() via exec() when ensureSchema is true", async () => {
    const transport = new SQLiteTransport({ filename: ":memory:", ensureSchema: true });
    const logger = new Logger("app.test2", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(execCalls).toBe(1);
  });
});
