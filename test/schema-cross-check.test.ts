import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSONFormatter, Level, Logger } from "../src/index.js";

/**
 * Validates a subset of JSON Schema (draft-07) sufficient for record.schema.json:
 * type, required, properties, additionalProperties, enum, pattern, minLength.
 * No schema-validation library is a dependency of this package, so this stays
 * hand-rolled rather than pulling one in just for a single fixture check.
 */
function validate(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`expected an object, got ${typeof value}`];
    }
    const obj = value as Record<string, unknown>;

    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) {
        errors.push(`missing required property "${key}"`);
      }
    }

    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`unexpected property "${key}"`);
        }
      }
    }

    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(...validate(subSchema, obj[key]).map((message) => `${key}: ${message}`));
      }
    }
    return errors;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      return [`expected a string, got ${typeof value}`];
    }
    const enumValues = schema.enum as string[] | undefined;
    if (enumValues && !enumValues.includes(value)) {
      errors.push(`"${value}" is not one of ${JSON.stringify(enumValues)}`);
    }
    const pattern = schema.pattern as string | undefined;
    if (pattern && !new RegExp(pattern).test(value)) {
      errors.push(`"${value}" does not match pattern ${pattern}`);
    }
    const minLength = schema.minLength as number | undefined;
    if (minLength !== undefined && value.length < minLength) {
      errors.push(`length ${String(value.length)} is below minLength ${String(minLength)}`);
    }
    return errors;
  }

  return errors;
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const schema = JSON.parse(readFileSync(join(fixturesDir, "record.schema.json"), "utf8")) as Record<
  string,
  unknown
>;

describe("cross-language record schema", () => {
  it("validates a JS-produced record", () => {
    const logger = new Logger("app.test", { level: Level.TRACE });
    const record = logger.info("user signed up", { user_id: 42, plan: "pro" });

    expect(record).not.toBeNull();
    expect(validate(schema, record)).toEqual([]);
  });

  it("validates a Python-produced record against the same schema", () => {
    const raw = readFileSync(join(fixturesDir, "python-sample-record.json"), "utf8");
    const pythonRecord: unknown = JSON.parse(raw);

    expect(validate(schema, pythonRecord)).toEqual([]);
  });

  it("round-trips a JS record through JSONFormatter and still matches the schema", () => {
    const logger = new Logger("app.test");
    const record = logger.info("hello", { user_id: 42 });
    if (record === null) {
      throw new Error("expected a record");
    }

    const formatted = new JSONFormatter().format(record);
    const parsed: unknown = JSON.parse(formatted);

    expect(validate(schema, parsed)).toEqual([]);
    expect(parsed).toEqual(record);
  });
});
