import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, PagerDutyAlertPlugin, type PagerDutySender } from "../../src/index.js";

interface PagerDutyBody {
  routing_key: string;
  event_action: string;
  payload: {
    summary: string;
    severity: string;
    source: string;
    timestamp: string;
    custom_details: Record<string, unknown>;
  };
}

function fakeSender(): PagerDutySender & { calls: string[] } {
  const calls: string[] = [];
  const sender = (body: string) => {
    calls.push(body);
  };
  return Object.assign(sender, { calls });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PagerDutyAlertPlugin", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts an Events API v2 payload", async () => {
    const sender = fakeSender();
    const plugin = new PagerDutyAlertPlugin("routing-key-123", { sender, dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom", { userId: 42 });
    await flushMicrotasks();

    expect(sender.calls).toHaveLength(1);
    const body = JSON.parse(sender.calls[0] as string) as PagerDutyBody;
    expect(body.routing_key).toBe("routing-key-123");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("error");
    expect(body.payload.custom_details.userId).toBe(42);
  });

  it("FATAL maps to critical severity", async () => {
    const sender = fakeSender();
    const plugin = new PagerDutyAlertPlugin("routing-key-123", { sender, dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.fatal("meltdown");
    await flushMicrotasks();

    const body = JSON.parse(sender.calls[0] as string) as PagerDutyBody;
    expect(body.payload.severity).toBe("critical");
  });

  it("includes the occurrence count on a follow-up alert", async () => {
    vi.useFakeTimers();
    try {
      const sender = fakeSender();
      const plugin = new PagerDutyAlertPlugin("routing-key-123", { sender, dedupeWindowMs: 100 });
      const logger = new Logger("app.test", { plugins: [plugin] });

      for (let i = 0; i < 6; i += 1) {
        logger.error("boom");
      }
      await vi.advanceTimersByTimeAsync(150);

      expect(sender.calls).toHaveLength(2);
      const followup = JSON.parse(sender.calls[1] as string) as PagerDutyBody;
      expect(followup.payload.summary).toContain("x6");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default fetch-based sender throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const errors: unknown[] = [];

    class ObservingPagerDutyAlertPlugin extends PagerDutyAlertPlugin {
      override onError(error: unknown): void {
        errors.push(error);
      }
    }
    const plugin = new ObservingPagerDutyAlertPlugin("routing-key-123", { dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("HTTP 400");
  });
});
