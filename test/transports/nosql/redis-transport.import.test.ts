import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/core/logger.js";
import { RedisTransport } from "../../../src/transports/nosql/redis-transport.js";

const xAddCalls: [string, string, Record<string, string>][] = [];

vi.mock("redis", () => ({
  createClient: (options: { url: string }) => ({
    url: options.url,
    connect: () => Promise.resolve(),
    xAdd: (stream: string, id: string, fields: Record<string, string>) => {
      xAddCalls.push([stream, id, fields]);
      return Promise.resolve(`mock-${String(xAddCalls.length)}`);
    },
  }),
}));

describe("RedisTransport (auto-imported `redis` driver)", () => {
  it("builds a real client via createClient(), connects it, and writes through it when no client is injected", async () => {
    const transport = new RedisTransport({ url: "redis://example:6380", stream: "custom" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hello", { runId: "run-1" });
    await logger.flush();
    transport.close();
    // sendBatch() has to await importClient()'s dynamic import before it can
    // call xAdd() at all, so give the chain real time rather than a single
    // microtask tick — same technique as the "not installed" test above.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(xAddCalls).toHaveLength(1);
    const [stream, id, fields] = xAddCalls[0] as [string, string, Record<string, string>];
    expect(stream).toBe("custom");
    expect(id).toBe("*");
    expect(fields.message).toBe("hello");
  });
});
