import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { MySQLTransport } from "../../../src/transports/sql/mysql-transport.js";

const executeCalls: { sql: string; values: unknown[] }[] = [];
let createPoolTarget: unknown;

vi.mock("mysql2/promise", () => ({
  createPool: (target: unknown) => {
    createPoolTarget = target;
    return {
      execute: (sql: string, values: unknown[]) => {
        executeCalls.push({ sql, values });
        return Promise.resolve();
      },
    };
  },
  // The source's `mod.default?.createPool ?? mod.createPool` fallback reads
  // `.default` unconditionally — vitest's mock proxy throws on accessing an
  // export the factory didn't return at all, so this must be present (even
  // as undefined) to let that optional-chaining read fall through cleanly.
  default: undefined,
}));

describe("MySQLTransport (auto-imported `mysql2/promise` driver)", () => {
  it("builds a real pool via createPool() and inserts through it when no client is injected", async () => {
    const transport = new MySQLTransport({ connectionString: "mysql://example/db" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(createPoolTarget).toBe("mysql://example/db");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.sql).toContain("INSERT INTO logs");
    expect(executeCalls[0]?.values).toHaveLength(9);
  });

  it("runs createTableSQL() via execute() when ensureSchema is true", async () => {
    const transport = new MySQLTransport({
      connectionString: "mysql://example/db2",
      ensureSchema: true,
    });
    const logger = new Logger("app.test2", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const createCall = executeCalls.find((call) => call.sql.includes("CREATE TABLE"));
    expect(createCall).toBeDefined();
    expect(createCall?.values).toEqual([]);
  });
});
