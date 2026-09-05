import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { PostgresTransport } from "../../../src/transports/sql/postgres-transport.js";

const queryCalls: { text: string; values: unknown[] }[] = [];
let constructedConfig: unknown;

vi.mock("pg", () => ({
  Pool: class {
    constructor(config: unknown) {
      constructedConfig = config;
    }
    query(text: string, values: unknown[]) {
      queryCalls.push({ text, values });
      return Promise.resolve();
    }
  },
  // The source's `mod.default?.Pool ?? mod.Pool` fallback reads `.default`
  // unconditionally — vitest's mock proxy throws on accessing an export the
  // factory didn't return at all, so this must be present (even as
  // undefined) to let that optional-chaining read fall through cleanly.
  default: undefined,
}));

describe("PostgresTransport (auto-imported `pg` driver)", () => {
  it("builds a real Pool and inserts through it when no client is injected", async () => {
    const transport = new PostgresTransport({ connectionString: "postgres://example/db" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(constructedConfig).toEqual({ connectionString: "postgres://example/db" });
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.text).toContain("INSERT INTO logs");
    expect(queryCalls[0]?.values).toHaveLength(9);
  });

  it("runs createTableSQL() via query() when ensureSchema is true", async () => {
    const transport = new PostgresTransport({
      connectionString: "postgres://example/db2",
      ensureSchema: true,
    });
    const logger = new Logger("app.test2", { transports: [transport] });

    logger.info("hello");
    await logger.flush();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const createCall = queryCalls.find((call) => call.text.includes("CREATE TABLE"));
    expect(createCall).toBeDefined();
    expect(createCall?.values).toEqual([]);
  });
});
