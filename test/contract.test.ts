import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  JSONFormatter,
  Level,
  Logger,
  LEGACY_SCHEMA_VERSION,
  RunPlugin,
  SCHEMA_VERSION,
  TamperEvidentPlugin,
  TraceContextPlugin,
  parseRecord,
} from "../src/index.js";
import { CollectingTransport } from "../src/transports/transport.js";

/**
 * The cross-language record contract: `schema/record.schema.json` and the golden
 * records in `schema/golden_records.json`, which `logquill-python` tests against too.
 */
const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
const read = (name: string): unknown => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

interface Entry {
  name: string;
  why?: string;
  record: unknown;
  parsed?: unknown;
}
const schema = read("record.schema.json") as { properties: { schema_version: { const: string } } };
const golden = read("golden_records.json") as Record<
  "valid" | "invalid" | "legacy" | "rejected",
  Entry[]
> & {
  schema_version: string;
};

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("record schema", () => {
  it("names the version this package writes", () => {
    expect(schema.properties.schema_version.const).toBe(SCHEMA_VERSION);
    expect(golden.schema_version).toBe(SCHEMA_VERSION);
  });

  it.each(golden.valid.map((e) => [e.name, e] as const))("valid golden: %s", (_name, entry) => {
    expect(validate(entry.record), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.parse(JSON.stringify(entry.record))).toEqual(entry.record);
    expect(parseRecord(entry.record)).toEqual(entry.record);
  });

  it.each(golden.invalid.map((e) => [e.name, e] as const))("invalid golden: %s", (_name, entry) => {
    expect(validate(entry.record), entry.why).toBe(false);
  });

  it.each(golden.legacy.map((e) => [e.name, e] as const))("legacy golden: %s", (_name, entry) => {
    expect(parseRecord(entry.record)).toEqual(entry.parsed);
  });

  it.each(golden.rejected.map((e) => [e.name, e] as const))(
    "rejected golden: %s",
    (_name, entry) => {
      expect(() => parseRecord(entry.record), entry.why).toThrow();
    },
  );
});

describe("parseRecord", () => {
  it("labels a 1.x record '1.0', defaults meta, and leaves the input alone", () => {
    const raw = { timestamp: "2026-01-01T00:00:00.000Z", level: "INFO", logger: "a", message: "m" };
    const parsed = parseRecord(raw);
    expect(parsed.schema_version).toBe(LEGACY_SCHEMA_VERSION);
    expect(parsed.meta).toEqual({});
    expect(raw).not.toHaveProperty("schema_version");
  });

  it("renames the camelCase named keys logquill-js 1.x wrote, leaving user keys alone", () => {
    const parsed = parseRecord({
      timestamp: "t",
      level: "INFO",
      logger: "a",
      message: "m",
      meta: { runId: "r", spanId: "s", parentSpanId: "p", traceId: "t", durationMs: 1, userId: 7 },
    });
    expect(parsed.meta).toEqual({
      run_id: "r",
      span_id: "s",
      parent_span_id: "p",
      trace_id: "t",
      duration_ms: 1,
      userId: 7,
    });
  });

  it("returns a record that shares no mutable state with its input", () => {
    const raw = {
      schema_version: "2.0",
      timestamp: "t",
      level: "INFO",
      logger: "a",
      message: "m",
      meta: { k: 1 },
      llm: { model: "m" },
    };
    const parsed = parseRecord(raw);
    parsed.meta.k = 2;
    if (parsed.llm) parsed.llm.model = "other";
    expect(raw.meta.k).toBe(1);
    expect(raw.llm.model).toBe("m");
  });

  it("does not rename keys in a 2.x record", () => {
    const record = {
      schema_version: "2.0",
      timestamp: "t",
      level: "INFO",
      logger: "a",
      message: "m",
      meta: { runId: "mine" },
    };
    expect(parseRecord(record).meta).toEqual({ runId: "mine" });
  });

  it("says what to do when it refuses a record", () => {
    expect(() => parseRecord({ schema_version: "3.0" })).toThrow(/upgrade logquill/);
    expect(() =>
      parseRecord({ timestamp: "t", level: "info", logger: "a", message: "m", meta: {} }),
    ).toThrow(/upper case/);
    expect(() => parseRecord({ timestamp: "t", level: "INFO", logger: "a", meta: {} })).toThrow(
      /'message' must be a string/,
    );
  });
});

describe("what this package writes satisfies the schema", () => {
  it("stamps schema_version on every record", () => {
    expect(new Logger("app").info("hello")?.schema_version).toBe(SCHEMA_VERSION);
  });

  it("validates records from a full pipeline: span, run, trace context, tamper chain", async () => {
    const sink = new CollectingTransport();
    const logger = new Logger("app.agent", {
      level: Level.TRACE,
      transports: [sink],
      plugins: [new RunPlugin(), new TraceContextPlugin(), new TamperEvidentPlugin()],
    });
    logger.thought("thinking");
    await logger.span("call_llm", () => {
      logger.action("search", { tool: "web" });
    });
    await logger.flush();

    expect(sink.records.length).toBeGreaterThanOrEqual(3);
    for (const record of sink.records) {
      const written: unknown = JSON.parse(new JSONFormatter().format(record));
      expect(validate(written), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(sink.records.at(-1)?.meta).toHaveProperty("duration_ms");
  });
});
