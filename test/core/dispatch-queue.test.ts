import { describe, expect, it } from "vitest";
import { DispatchQueue } from "../../src/core/dispatch-queue.js";

describe("DispatchQueue", () => {
  it("runs enqueued tasks outside the caller's own call stack", () => {
    const queue = new DispatchQueue();
    let ran = false;

    queue.enqueue(() => {
      ran = true;
    });

    expect(ran).toBe(false); // hasn't run yet — still queued
    expect(queue.size).toBe(1);
  });

  it("flush() resolves once every queued task has run", async () => {
    const queue = new DispatchQueue();
    const order: number[] = [];

    queue.enqueue(() => {
      order.push(1);
    });
    queue.enqueue(() => {
      order.push(2);
    });
    queue.enqueue(() => {
      order.push(3);
    });
    await queue.flush();

    expect(order).toEqual([1, 2, 3]);
    expect(queue.size).toBe(0);
  });

  it("flush() on an idle queue resolves immediately", async () => {
    const queue = new DispatchQueue();
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it("a throwing task does not stop the rest of the queue from draining", async () => {
    const queue = new DispatchQueue();
    const ran: number[] = [];

    queue.enqueue(() => {
      ran.push(1);
      throw new Error("boom");
    });
    queue.enqueue(() => {
      ran.push(2);
    });
    await queue.flush();

    expect(ran).toEqual([1, 2]);
  });

  describe("backpressure", () => {
    it("dropOldest evicts the longest-waiting task to make room", async () => {
      const dropped: number[] = [];
      const queue = new DispatchQueue({
        maxSize: 2,
        policy: "dropOldest",
        onDrop: (count) => dropped.push(count),
      });
      const ran: string[] = [];

      // Fill the queue without letting it drain, so overflow is deterministic.
      queue.enqueue(() => {
        ran.push("a");
      });
      queue.enqueue(() => {
        ran.push("b");
      });
      queue.enqueue(() => {
        ran.push("c"); // evicts "a"
      });

      expect(queue.size).toBe(2);
      await queue.flush();

      expect(ran).toEqual(["b", "c"]);
      expect(dropped).toEqual([1]);
    });

    it("dropNewest discards the incoming task, keeping what's already queued", async () => {
      const dropped: number[] = [];
      const queue = new DispatchQueue({
        maxSize: 2,
        policy: "dropNewest",
        onDrop: (count) => dropped.push(count),
      });
      const ran: string[] = [];

      queue.enqueue(() => {
        ran.push("a");
      });
      queue.enqueue(() => {
        ran.push("b");
      });
      queue.enqueue(() => {
        ran.push("c"); // discarded — "a" and "b" stay
      });

      expect(queue.size).toBe(2);
      await queue.flush();

      expect(ran).toEqual(["a", "b"]);
      expect(dropped).toEqual([1]);
    });

    it("block runs the overflowing task synchronously instead of dropping it", () => {
      const queue = new DispatchQueue({ maxSize: 1, policy: "block" });
      const ran: string[] = [];

      queue.enqueue(() => {
        ran.push("a"); // fits under maxSize, stays queued
      });
      queue.enqueue(() => {
        ran.push("b"); // queue is full — runs inline, right now
      });

      expect(ran).toEqual(["b"]); // "b" already ran; "a" is still waiting to drain
      expect(queue.size).toBe(1);
    });

    it("never grows past maxSize under a sustained burst, regardless of policy", () => {
      for (const policy of ["dropOldest", "dropNewest"] as const) {
        const queue = new DispatchQueue({ maxSize: 50, policy });
        for (let i = 0; i < 5000; i += 1) {
          queue.enqueue(() => {});
        }
        expect(queue.size).toBeLessThanOrEqual(50);
      }
    });

    it("rate-limits onDrop instead of calling it once per dropped task", () => {
      const dropCalls: number[] = [];
      const queue = new DispatchQueue({
        maxSize: 1,
        policy: "dropNewest",
        warnIntervalMs: 60_000, // effectively "only once" for this test's duration
        onDrop: (count) => dropCalls.push(count),
      });

      queue.enqueue(() => {});
      for (let i = 0; i < 100; i += 1) {
        queue.enqueue(() => {}); // every one of these is dropped
      }

      // The first drop fires onDrop immediately (nothing to rate-limit against
      // yet); every drop after that within warnIntervalMs is coalesced rather
      // than calling onDrop again per drop.
      expect(dropCalls).toHaveLength(1);
      expect(dropCalls[0]).toBe(1);
    });

    it("a broken onDrop callback does not crash the caller", () => {
      const queue = new DispatchQueue({
        maxSize: 1,
        policy: "dropNewest",
        onDrop: () => {
          throw new Error("boom");
        },
      });

      queue.enqueue(() => {});
      expect(() => {
        queue.enqueue(() => {});
      }).not.toThrow();
    });
  });
});
