import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CollectingTransport,
  CONTENT_FIELDS,
  Logger,
  TRUNCATE_CHARS,
  type ContentCapturePolicy,
} from "../../src/index.js";
import { applyContentPolicy } from "../../src/core/privacy.js";
import { sha256Hex } from "../../src/core/sha256.js";

describe("sha256Hex", () => {
  it.each([0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000])(
    "matches node:crypto at length %i (padding boundaries)",
    (length) => {
      const text = "a".repeat(length);
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    },
  );

  it("matches node:crypto on multi-byte text", () => {
    const text = "héllo ☃ 𝄞 日本語";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

function logWith(policy: ContentCapturePolicy | undefined, meta: Record<string, unknown>) {
  const sink = new CollectingTransport();
  const logger = new Logger("app", {
    transports: [sink],
    ...(policy ? { contentPolicy: policy } : {}),
  });
  const record = logger.info("m", meta);
  return { record, sink, logger };
}

describe("contentPolicy", () => {
  const content = { input_messages: [{ role: "user", content: "secret prompt" }], note: "kept" };

  it("is off by default: a content field becomes a placeholder, other fields are untouched", () => {
    const { record } = logWith(undefined, content);
    expect(record?.meta.input_messages).toMatch(/content capture is off/);
    expect(JSON.stringify(record)).not.toContain("secret prompt");
    expect(record?.meta.note).toBe("kept");
  });

  it("full passes the value through", () => {
    expect(logWith("full", content).record?.meta.input_messages).toEqual(content.input_messages);
  });

  it("hash replaces the value with the same sha256 digest logquill-python produces", () => {
    expect(
      logWith("hash", { tool_arguments: { b: 1, a: [1, 2, { x: null }] } }).record?.meta
        .tool_arguments,
    ).toBe("sha256:e530cf8a34a3a5f6b44313d26158bc532efe2551dd55b2610d3ad7b7310943fd");
    expect(logWith("hash", { tool_result: "héllo ☃" }).record?.meta.tool_result).toBe(
      "sha256:c1988efb8161d8884c8ddb4ad5f74dcb4522e1ab287fd920b803f90df45f02ce",
    );
  });

  it("hash is stable: the same content hashes the same, different content differs", () => {
    const a = logWith("hash", { output_messages: ["x"] }).record?.meta.output_messages;
    const b = logWith("hash", { output_messages: ["x"] }).record?.meta.output_messages;
    const c = logWith("hash", { output_messages: ["y"] }).record?.meta.output_messages;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("truncate keeps the first characters and says how long the original was", () => {
    const long = "x".repeat(TRUNCATE_CHARS + 50);
    const value = logWith("truncate", { tool_result: long }).record?.meta.tool_result as string;
    expect(value.startsWith(`"${"x".repeat(10)}`)).toBe(true);
    expect(value).toMatch(/\.\.\.\(truncated, \d+ chars total\)$/);
    expect(logWith("truncate", { tool_result: "short" }).record?.meta.tool_result).toBe('"short"');
  });

  it("is applied before any plugin sees the record, so a plugin cannot read raw content", () => {
    const seen: unknown[] = [];
    const logger = new Logger("app", {
      plugins: [
        (record) => {
          seen.push(record.meta.input_messages);
          return record;
        },
      ],
    });
    logger.info("m", { input_messages: ["raw"] });
    expect(String(seen[0])).toMatch(/content capture is off/);
  });

  it("governs state_diff and every other content field", () => {
    expect(CONTENT_FIELDS).toEqual(
      expect.arrayContaining([
        "input_messages",
        "output_messages",
        "system_instructions",
        "tool_arguments",
        "tool_result",
        "state_diff",
      ]),
    );
  });

  it("does not throw on a circular value under hash or truncate", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    for (const policy of ["hash", "truncate"] as const) {
      expect(() => logWith(policy, { tool_result: loop })).not.toThrow();
    }
  });

  it("rejects an unknown policy at construction, naming the valid ones", () => {
    expect(() => new Logger("app", { contentPolicy: "nope" as ContentCapturePolicy })).toThrow(
      /one of "off", "hash", "truncate", "full"/,
    );
  });

  it("is inherited by a child logger", () => {
    const child = new Logger("app", { contentPolicy: "full" }).child("db");
    expect(child.contentPolicy).toBe("full");
  });

  it("applyContentPolicy leaves meta without content fields alone", () => {
    const meta = { a: 1 };
    applyContentPolicy(meta, "off");
    expect(meta).toEqual({ a: 1 });
  });
});

describe("acceptance: a seeded secret in a prompt", () => {
  it("never reaches any transport by default", async () => {
    const SECRET = "sk-live-SEEDED-0123456789abcdef";
    const written: string[] = [];
    const sink = new CollectingTransport();
    const { ConsoleTransport, SyslogTransport, TextFormatter, LogfmtFormatter } =
      await import("../../src/index.js");
    const logger = new Logger("agent", {
      transports: [
        sink,
        new ConsoleTransport({
          formatter: new TextFormatter(),
          colorize: false,
          console: { log: (l) => written.push(l), error: (l) => written.push(l) },
        }),
        new SyslogTransport({
          formatter: new LogfmtFormatter(),
          sender: (d) => written.push(d.toString()),
        }),
      ],
    });

    logger.llmCall(
      { model: "m" },
      {
        input_messages: [{ role: "user", content: `use key ${SECRET}` }],
        output_messages: [{ role: "assistant", content: SECRET }],
        tool_arguments: { api_key_param: SECRET },
        tool_result: SECRET,
        system_instructions: SECRET,
      },
    );
    await logger.span("work", () => undefined, {
      captureState: () => ({ key: SECRET }),
      note: "x",
    });
    await logger.flush();

    const everything = [...sink.formatted, ...written, JSON.stringify(sink.records)].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain("content capture is off");
  });
});
