import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, SlackAlertPlugin, type SlackSender } from "../../src/index.js";

function fakeSender(): SlackSender & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  const sender = (webhookUrl: string, body: string) => {
    calls.push([webhookUrl, body]);
  };
  return Object.assign(sender, { calls });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SlackAlertPlugin", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts a JSON body with text", async () => {
    const sender = fakeSender();
    const plugin = new SlackAlertPlugin("https://hooks.slack.example/T000/B000/xxx", { sender, dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom");
    await logger.flush();
    await flushMicrotasks();

    expect(sender.calls).toHaveLength(1);
    const [url, body] = sender.calls[0] as [string, string];
    expect(url).toBe("https://hooks.slack.example/T000/B000/xxx");
    expect((JSON.parse(body) as { text: string }).text).toContain("boom");
  });

  it("includes the occurrence count on a follow-up alert", async () => {
    vi.useFakeTimers();
    try {
      const sender = fakeSender();
      const plugin = new SlackAlertPlugin("https://hooks.slack.example/T000/B000/xxx", { sender, dedupeWindowMs: 100 });
      const logger = new Logger("app.test", { plugins: [plugin] });

      for (let i = 0; i < 7; i += 1) {
        logger.error("boom");
      }
      await vi.advanceTimersByTimeAsync(150);

      expect(sender.calls).toHaveLength(2);
      const [, followupBody] = sender.calls[1] as [string, string];
      expect((JSON.parse(followupBody) as { text: string }).text).toContain("x7");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default fetch-based sender throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const errors: unknown[] = [];

    class ObservingSlackAlertPlugin extends SlackAlertPlugin {
      override onError(error: unknown): void {
        errors.push(error);
      }
    }
    const plugin = new ObservingSlackAlertPlugin("https://hooks.slack.example/T000/B000/xxx", { dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("HTTP 500");
  });
});
