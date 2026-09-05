import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CollectingTransport,
  ContextPlugin,
  Logger,
  type Plugin,
  RateLimitPlugin,
  RedactPlugin,
  SamplingPlugin,
} from "../../src/index.js";

/**
 * Property-based tests for the core `Logger`/plugin pipeline: throw a wide
 * variety of adversarial `meta` shapes at a real pipeline (multiple
 * plugins, a real transport) and confirm the contract holds no matter
 * what — a log call never throws into the caller's process, it only fails
 * closed (returns `null`, or silently drops the write) the same way a
 * single hand-picked bad input already does in the non-property tests
 * elsewhere.
 */

// Deep nesting, big arrays/objects, bigints, dates, Maps/Sets, typed
// arrays, sparse arrays, and null-prototype objects, plus everything else
// `fc.anything()` covers.
const adversarialMeta = fc.object({
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

function withCircularRef(meta: Record<string, unknown>): Record<string, unknown> {
  const circular: Record<string, unknown> = { ...meta };
  circular.self = circular;
  return circular;
}

function freshLogger(transport: CollectingTransport, plugins: Plugin[] = []) {
  return new Logger("app.property", {
    transports: [transport],
    plugins,
  });
}

describe("Logger/plugin pipeline property tests", () => {
  it("never throws into the caller for any adversarial meta shape, through a full plugin pipeline", () => {
    fc.assert(
      fc.property(fc.string(), adversarialMeta, fc.boolean(), (message, meta, circular) => {
        const transport = new CollectingTransport();
        const logger = freshLogger(transport, [
          new ContextPlugin({ service: "test" }),
          new RedactPlugin(),
          new SamplingPlugin(1),
          new RateLimitPlugin(1000, 60),
        ]);

        expect(() => logger.info(message, circular ? withCircularRef(meta) : meta)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("never throws when the record actually reaches a transport (JSON formatting included)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        adversarialMeta,
        fc.boolean(),
        async (message, meta, circular) => {
          const transport = new CollectingTransport();
          const logger = freshLogger(transport);

          logger.info(message, circular ? withCircularRef(meta) : meta);
          await expect(logger.flush()).resolves.toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a beforeLog that throws on any input never crashes the caller and never stops later plugins running", () => {
    fc.assert(
      fc.property(fc.string(), adversarialMeta, (message, meta) => {
        const errors: unknown[] = [];
        const throwingPlugin: Plugin = {
          beforeLog() {
            throw new Error("adversarial plugin failure");
          },
          onError(error) {
            errors.push(error);
          },
        };
        let sawSecondPlugin = false;
        const secondPlugin: Plugin = {
          beforeLog(record) {
            sawSecondPlugin = true;
            return record;
          },
        };
        const transport = new CollectingTransport();
        const logger = freshLogger(transport, [throwingPlugin, secondPlugin]);

        expect(() => logger.info(message, meta)).not.toThrow();
        expect(errors).toHaveLength(1);
        expect(sawSecondPlugin).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("an onError that itself throws never crashes the caller", () => {
    fc.assert(
      fc.property(fc.string(), adversarialMeta, (message, meta) => {
        const brokenErrorPlugin: Plugin = {
          beforeLog() {
            throw new Error("primary failure");
          },
          onError() {
            throw new Error("onError is broken too");
          },
        };
        const transport = new CollectingTransport();
        const logger = freshLogger(transport, [brokenErrorPlugin]);

        expect(() => logger.info(message, meta)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("a transport whose format()/write() throws on any record never crashes the caller", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), adversarialMeta, async (message, meta) => {
        const collecting = new CollectingTransport();
        const originalWrite = collecting.write.bind(collecting);
        collecting.write = () => {
          throw new Error("adversarial transport failure");
        };
        const logger = freshLogger(collecting);

        expect(() => logger.info(message, meta)).not.toThrow();
        await expect(logger.flush()).resolves.toBeUndefined();
        collecting.write = originalWrite;
      }),
      { numRuns: 100 },
    );
  });

  it("huge messages and huge meta payloads never crash the caller", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10_000, maxLength: 50_000 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.string({ maxLength: 5_000 }), {
          minKeys: 50,
          maxKeys: 200,
        }),
        (message, meta) => {
          const transport = new CollectingTransport();
          const logger = freshLogger(transport, [new RedactPlugin()]);

          expect(() => logger.info(message, meta)).not.toThrow();
        },
      ),
      { numRuns: 20 },
    );
  });
});
