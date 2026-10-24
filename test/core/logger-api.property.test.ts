import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectingTransport,
  ConsoleTransport,
  JSONFormatter,
  LogfmtFormatter,
  Logger,
  SyslogTransport,
  TextFormatter,
  type ContentCapturePolicy,
  type LogRecord,
} from "../../src/index.js";

/**
 * Property tests for the Logger API added in 2.0 and for the formatters and
 * transports a record reaches: whatever the caller hands in, a log call never
 * throws into the caller, and a text or logfmt line is always exactly one line.
 */

const adversarial = fc.object({
  maxDepth: 6,
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

function circular(meta: Record<string, unknown>): Record<string, unknown> {
  const loop: Record<string, unknown> = { ...meta };
  loop.self = loop;
  return loop;
}

function record(meta: Record<string, unknown>, message = "m"): LogRecord {
  return {
    schema_version: "2.0",
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "INFO",
    logger: "app",
    message,
    meta,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatters", () => {
  it("TextFormatter and LogfmtFormatter never throw, whatever the meta", () => {
    fc.assert(
      fc.property(fc.string(), adversarial, fc.boolean(), (message, meta, loop) => {
        const rec = record(loop ? circular(meta) : meta, message);
        expect(() => new TextFormatter().format(rec)).not.toThrow();
        expect(() => new LogfmtFormatter().format(rec)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("a logfmt line is always exactly one line", () => {
    fc.assert(
      fc.property(fc.string(), adversarial, (message, meta) => {
        expect(new LogfmtFormatter().format(record(meta, message))).not.toMatch(/[\n\r]/);
      }),
      { numRuns: 300 },
    );
  });

  it("JSONFormatter may refuse an unserializable record, but the logger catches it", () => {
    const sink = new CollectingTransport();
    sink.formatter = new JSONFormatter();
    const logger = new Logger("app", { transports: [sink] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fc.assert(
      fc.property(adversarial, (meta) => {
        expect(() => logger.info("m", circular(meta))).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

describe("Logger API", () => {
  it("contentPolicy never throws for any policy and any content value", () => {
    const policies: ContentCapturePolicy[] = ["off", "hash", "truncate", "full"];
    fc.assert(
      fc.property(
        fc.constantFrom(...policies),
        adversarial,
        fc.boolean(),
        (policy, value, loop) => {
          const logger = new Logger("app", { contentPolicy: policy });
          const content = loop ? circular(value) : value;
          expect(() =>
            logger.info("m", {
              input_messages: content,
              tool_result: content,
              state_diff: content,
              other: value,
            }),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("opt({ lazy, depth }) never throws, even with throwing functions in meta", () => {
    fc.assert(
      fc.property(
        adversarial,
        fc.boolean(),
        fc.option(fc.nat({ max: 50 }), { nil: undefined }),
        (meta, lazy, depth) => {
          const logger = new Logger("app");
          const withFns = {
            ...meta,
            ok: () => 1,
            bad: () => {
              throw new Error("x");
            },
            thrower: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- a function may throw anything
              throw { not: "an error" };
            },
          };
          expect(() =>
            logger.opt({ lazy, ...(depth === undefined ? {} : { depth }) }).info("m", withFns),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("llmCall never throws for any field values", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), fc.anything(), (a, b, c, d) => {
        const logger = new Logger("app");
        expect(() =>
          logger.llmCall({
            model: a as string,
            tokensIn: b as number,
            tokensOut: c as number,
            costUsd: d as number,
            latencyMs: a as number,
            finishReason: b as string,
          }),
        ).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("a span with an adversarial captureState never throws into the caller", async () => {
    const logger = new Logger("app", { contentPolicy: "full" });
    await fc.assert(
      fc.asyncProperty(adversarial, fc.boolean(), async (state, throwing) => {
        const result = await logger.span("work", () => "done", {
          captureState: () => {
            if (throwing) throw new Error("x");
            return state;
          },
        });
        expect(result).toBe("done");
      }),
      { numRuns: 100 },
    );
  });

  it("retry tracking never throws and never mutates the caller's meta", () => {
    fc.assert(
      fc.property(adversarial, fc.string(), (meta, tool) => {
        const logger = new Logger("app");
        const input = { ...meta, tool, tool_call_id: tool };
        const before = Object.keys(input).sort();
        expect(() => {
          logger.action("a", input);
          logger.action("a", input);
          logger.observation("o", input);
        }).not.toThrow();
        expect(Object.keys(input).sort()).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe("transports", () => {
  it("Console and Syslog transports never throw into the caller for any meta, with every formatter", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lines: string[] = [];
    const sent: Buffer[] = [];
    const formatters = [new JSONFormatter(), new TextFormatter(), new LogfmtFormatter()];
    fc.assert(
      fc.property(
        fc.constantFrom(...formatters),
        adversarial,
        fc.boolean(),
        (formatter, meta, loop) => {
          const logger = new Logger("app", {
            transports: [
              new ConsoleTransport({
                formatter,
                colorize: false,
                console: {
                  log: (l) => lines.push(l),
                  error: (l) => lines.push(l),
                },
              }),
              new SyslogTransport({ formatter, sender: (data) => sent.push(data) }),
            ],
          });
          expect(() => logger.error("m", loop ? circular(meta) : meta)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});
