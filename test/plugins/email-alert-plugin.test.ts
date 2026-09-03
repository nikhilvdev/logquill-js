import { describe, expect, it, vi } from "vitest";
import { EmailAlertPlugin, Logger, type EmailMessage } from "../../src/index.js";

function fakeSender(): ((message: EmailMessage) => void) & { calls: EmailMessage[] } {
  const calls: EmailMessage[] = [];
  const sender = (message: EmailMessage) => {
    calls.push(message);
  };
  return Object.assign(sender, { calls });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EmailAlertPlugin", () => {
  it("sends an email via the injected sender", async () => {
    const sender = fakeSender();
    const plugin = new EmailAlertPlugin({
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      fromAddr: "alerts@example.com",
      toAddrs: ["oncall@example.com"],
      username: "user",
      password: "pass",
      sender,
      dedupeWindowMs: 60_000,
    });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom");
    await logger.flush();
    await flushMicrotasks();

    expect(sender.calls).toHaveLength(1);
    const message = sender.calls[0] as EmailMessage;
    expect(message.to).toEqual(["oncall@example.com"]);
    expect(message.from).toBe("alerts@example.com");
    expect(message.text).toContain("boom");
  });

  it("includes the occurrence count in the subject on a follow-up alert", async () => {
    vi.useFakeTimers();
    try {
      const sender = fakeSender();
      const plugin = new EmailAlertPlugin({
        smtpHost: "smtp.example.com",
        smtpPort: 25,
        fromAddr: "alerts@example.com",
        toAddrs: ["oncall@example.com"],
        sender,
        dedupeWindowMs: 100,
      });
      const logger = new Logger("app.test", { plugins: [plugin] });

      for (let i = 0; i < 9; i += 1) {
        logger.error("boom");
      }
      await vi.advanceTimersByTimeAsync(150);

      expect(sender.calls).toHaveLength(2);
      expect(sender.calls[1]?.subject).toContain("x9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws an actionable error when nodemailer isn't installed and no sender is given", async () => {
    const errors: unknown[] = [];

    class ObservingEmailAlertPlugin extends EmailAlertPlugin {
      override onError(error: unknown): void {
        errors.push(error);
      }
    }
    const plugin = new ObservingEmailAlertPlugin({
      smtpHost: "smtp.example.com",
      smtpPort: 25,
      fromAddr: "alerts@example.com",
      toAddrs: ["oncall@example.com"],
      dedupeWindowMs: 60_000,
    });
    const logger = new Logger("app.test", { plugins: [plugin] });

    logger.error("boom");
    // The failing dynamic import resolves via real filesystem I/O, not just
    // a microtask, so give it real time rather than a fixed tick count.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("install `nodemailer`");
  });
});
