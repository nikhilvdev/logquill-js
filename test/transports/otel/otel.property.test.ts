import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OTelLogsTransport, OTLPTransport, type LogRecord } from "../../../src/index.js";

/**
 * Whatever a record's `meta` holds, the OpenTelemetry transports must turn it into
 * a span or log record (or ignore it) without throwing. The logger would catch a
 * throw, but a transport that throws on every odd record is noisy and drops data,
 * so this calls `write()` directly.
 */

const adversarial = fc.object({
  maxDepth: 5,
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
  withSparseArray: true,
  withTypedArray: true,
  withUnicodeString: true,
});

// Keys the transports read, with values of every type, so a wrong type reaches each code path.
const named = fc.record(
  {
    kind: fc.constantFrom("span", "action", "thought", 5, null),
    span_id: fc.anything(),
    parent_span_id: fc.anything(),
    trace_id: fc.anything(),
    run_id: fc.anything(),
    tool: fc.anything(),
    tool_call_id: fc.anything(),
    agent_name: fc.anything(),
    operation: fc.anything(),
    provider: fc.anything(),
    duration_ms: fc.anything(),
    error: fc.anything(),
    retry_count: fc.anything(),
    state_diff: fc.anything(),
    stack: fc.anything(),
    input_messages: fc.anything(),
  },
  { requiredKeys: [] },
);

const llm = fc.option(
  fc.record(
    {
      model: fc.anything(),
      tokens_in: fc.anything(),
      tokens_out: fc.anything(),
      cost_usd: fc.anything(),
      latency_ms: fc.anything(),
      finish_reason: fc.anything(),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

function record(meta: Record<string, unknown>, llmBlock: unknown): LogRecord {
  const rec: LogRecord = {
    schema_version: "2.0",
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "INFO",
    logger: "app",
    message: "m",
    meta,
  };
  if (llmBlock !== undefined) rec.llm = llmBlock as NonNullable<LogRecord["llm"]>;
  return rec;
}

describe("OpenTelemetry transports", () => {
  it("OTLPTransport.write never throws, whatever the record holds", () => {
    const transport = new OTLPTransport({
      spanExporter: new InMemorySpanExporter(),
      processor: "simple",
      captureContent: true,
    });
    fc.assert(
      fc.property(named, adversarial, llm, (known, extra, llmBlock) => {
        expect(() => {
          transport.write("", record({ ...extra, ...known }, llmBlock));
        }).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("OTelLogsTransport.write never throws, whatever the record holds", () => {
    const transport = new OTelLogsTransport({
      logExporter: new InMemoryLogRecordExporter(),
      processor: "simple",
    });
    fc.assert(
      fc.property(named, adversarial, llm, (known, extra, llmBlock) => {
        expect(() => {
          transport.write("", record({ ...extra, ...known }, llmBlock));
        }).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
