import { describe, expect, it } from "vitest";
import type { LogRecord } from "../../../src/index.js";
import { toEcsDocument } from "../../../src/transports/cloud/ecs-mapper.js";

const record = (meta: Record<string, unknown>): LogRecord => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  level: "ERROR",
  logger: "app.api",
  message: "boom",
  meta,
});

describe("toEcsDocument", () => {
  it("adds the standard ECS fields alongside the record's own", () => {
    const doc = toEcsDocument(record({ traceId: "t1", spanId: "s1", stack: "Error: x\n at f" }));
    expect(doc).toMatchObject({
      "@timestamp": "2026-01-01T00:00:00.000Z",
      log: { level: "error" },
      service: { name: "app.api" },
      trace: { id: "t1" },
      span: { id: "s1" },
      error: { message: "boom", stack_trace: "Error: x\n at f" },
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "ERROR",
    });
  });

  it("accepts snake_case trace ids and omits fields that are absent", () => {
    const doc = toEcsDocument(record({ trace_id: "t2" }));
    expect(doc.trace).toEqual({ id: "t2" });
    expect(doc).not.toHaveProperty("span");
    expect(doc).not.toHaveProperty("error");
  });
});
