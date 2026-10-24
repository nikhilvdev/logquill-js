import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LogfmtFormatter,
  parse,
  parseLogfmt,
  TEXT_LOG_CASTS,
  TEXT_LOG_PATTERN,
  TextFormatter,
} from "../../src/index.js";
import type { LogRecord } from "../../src/index.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const record = (message: string, meta: Record<string, unknown> = {}): LogRecord => ({
  schema_version: "2.0",
  timestamp: "2026-01-01T00:00:00.000Z",
  level: "INFO",
  logger: "app.api",
  message,
  meta,
});

describe("TextFormatter", () => {
  it("renders one entry with compact meta", () => {
    expect(new TextFormatter().format(record("user signed up", { userId: 42 }))).toBe(
      '2026-01-01T00:00:00.000Z INFO  app.api: user signed up {"userId":42}',
    );
  });

  it("prints meta.stack on the lines after the entry", () => {
    const out = new TextFormatter().format(record("boom", { stack: "Error: x\n  at f\n" }));
    expect(out).toBe("2026-01-01T00:00:00.000Z INFO  app.api: boom\nError: x\n  at f");
  });

  it("does not throw on a circular or BigInt meta value", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => new TextFormatter().format(record("m", { loop, big: 1n }))).not.toThrow();
  });

  it("round-trips through parse()", async () => {
    const line = new TextFormatter().format(record("hello world", { a: 1 }));
    const [entry] = await collect(parse([line], TEXT_LOG_PATTERN, { cast: TEXT_LOG_CASTS }));
    expect(entry).toMatchObject({
      level: "INFO",
      logger: "app.api",
      message: "hello world",
      meta: { a: 1 },
    });
  });
});

describe("LogfmtFormatter", () => {
  const fmt = new LogfmtFormatter();

  it("emits the four fields then meta pairs, quoting only when needed", () => {
    expect(fmt.format(record("user signed up", { userId: 42, ok: true, none: null }))).toBe(
      'timestamp=2026-01-01T00:00:00.000Z level=INFO logger=app.api message="user signed up" userId=42 ok=true none=null',
    );
  });

  it("flattens nested objects, JSON-encodes arrays, and prefixes reserved keys", () => {
    expect(
      fmt.format(record("m", { http: { status: 200 }, tags: ["a", "b"], level: "x" })),
    ).toContain('http.status=200 tags="[\\"a\\",\\"b\\"]" meta.level=x');
  });

  it("always emits exactly one line", () => {
    const out = fmt.format(record("a\nb", { stack: "x\ty\r\nz" }));
    expect(out).not.toMatch(/[\n\r]/);
  });

  it("round-trips scalar values through parseLogfmt", () => {
    const parsed = parseLogfmt(fmt.format(record('say "hi"\nnow', { k: "a b=c" })));
    expect(parsed).toMatchObject({ message: 'say "hi"\nnow', k: "a b=c", level: "INFO" });
  });

  it("does not throw on circular meta", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => fmt.format(record("m", { loop }))).not.toThrow();
  });
});

describe("parseLogfmt", () => {
  it("maps bare keys to '' and lets the last duplicate win", () => {
    expect(parseLogfmt("a=1 flag a=2")).toEqual({ a: "2", flag: "" });
  });
});

describe("parse", () => {
  it("rejects a pattern with no named groups, or a cast for an unknown group", () => {
    expect(() => parse([], /abc/)).toThrow(/no named groups/);
    expect(() => parse([], /(?<a>x)/, { cast: { b: Number } })).toThrow(/not named groups/);
  });

  it("streams a file, skipping non-matching lines and casting groups", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "lq-parse-")), "legacy.log");
    writeFileSync(path, "ERROR 503 down\nnoise\nWARN 200 ok\n");
    const entries = await collect(
      parse(path, /^(?<level>[A-Z]+) (?<code>\d+) (?<message>.*)$/, { cast: { code: Number } }),
    );
    expect(entries).toEqual([
      { level: "ERROR", code: 503, message: "down" },
      { level: "WARN", code: 200, message: "ok" },
    ]);
  });

  it("names the line number when a cast fails", async () => {
    await expect(
      collect(
        parse(["x", "bad"], /^(?<v>.+)$/, {
          cast: {
            v: (t) => {
              if (t === "bad") throw new Error("nope");
              return t;
            },
          },
        }),
      ),
    ).rejects.toThrow(/line 2/);
  });
});

describe("llm block", () => {
  const withLlm = (): LogRecord => ({
    ...record("called", { provider: "openai" }),
    llm: { model: "gpt-4o", tokens_in: 10, cost_usd: 0.0002 },
  });

  it("TextFormatter prints it as llm={...} before meta, like logquill-python", () => {
    expect(new TextFormatter().format(withLlm())).toBe(
      '2026-01-01T00:00:00.000Z INFO  app.api: called llm={"model":"gpt-4o","tokens_in":10,"cost_usd":0.0002} {"provider":"openai"}',
    );
  });

  it("LogfmtFormatter flattens it to llm.* pairs before meta", () => {
    expect(new LogfmtFormatter().format(withLlm())).toBe(
      "timestamp=2026-01-01T00:00:00.000Z level=INFO logger=app.api message=called llm.model=gpt-4o llm.tokens_in=10 llm.cost_usd=0.0002 provider=openai",
    );
  });

  it("omits it when empty, and round-trips through parse()", async () => {
    expect(new TextFormatter().format({ ...record("m"), llm: {} })).not.toContain("llm=");
    const [entry] = await collect(
      parse([new TextFormatter().format(withLlm())], TEXT_LOG_PATTERN, { cast: TEXT_LOG_CASTS }),
    );
    expect(entry).toMatchObject({
      llm: { model: "gpt-4o", tokens_in: 10, cost_usd: 0.0002 },
      meta: { provider: "openai" },
    });
  });
});
