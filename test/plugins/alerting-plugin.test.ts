import { describe, expect, it, vi } from "vitest";
import { AlertingPlugin, Logger, type LogRecord } from "../../src/index.js";

class RecordingAlertPlugin extends AlertingPlugin {
  readonly sent: [LogRecord, number][] = [];

  protected sendAlert(record: LogRecord, occurrences: number): void {
    this.sent.push([record, occurrences]);
  }
}

class BrokenAlertPlugin extends AlertingPlugin {
  readonly errors: unknown[] = [];

  protected sendAlert(): void {
    throw new Error("destination unreachable");
  }

  override onError(error: unknown): void {
    this.errors.push(error);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AlertingPlugin", () => {
  it("an ERROR-level record fires an alert", async () => {
    const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [alerting] });

    logger.error("something broke");
    await flushMicrotasks();

    expect(alerting.sent).toHaveLength(1);
    const [record, occurrences] = alerting.sent[0] as [LogRecord, number];
    expect(record.message).toBe("something broke");
    expect(occurrences).toBe(1);
  });

  it("below-threshold records do not fire an alert", async () => {
    const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [alerting] });

    logger.info("just info");
    logger.warn("just a warning");
    await flushMicrotasks();

    expect(alerting.sent).toHaveLength(0);
  });

  it("never blocks the caller even when the destination is unreachable", async () => {
    const broken = new BrokenAlertPlugin({ dedupeWindowMs: 60_000 });
    const logger = new Logger("app.test", { plugins: [broken] });

    const record = logger.error("boom"); // must return promptly, not hang or throw
    expect(record).not.toBeNull();

    await flushMicrotasks();
    expect(broken.errors).toHaveLength(1);
    expect(broken.errors[0]).toBeInstanceOf(Error);
  });

  it("duplicate errors within the window collapse into one follow-up alert", async () => {
    vi.useFakeTimers();
    try {
      const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 100 });
      const logger = new Logger("app.test", { plugins: [alerting] });

      for (let i = 0; i < 5; i += 1) {
        logger.error("repeated failure");
      }
      await vi.advanceTimersByTimeAsync(0); // let the first send's microtask run
      expect(alerting.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(150); // close the dedupe window
      expect(alerting.sent).toHaveLength(2);
      expect(alerting.sent[0]?.[1]).toBe(1);
      expect(alerting.sent[1]?.[1]).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single occurrence gets no follow-up alert", async () => {
    vi.useFakeTimers();
    try {
      const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 50 });
      const logger = new Logger("app.test", { plugins: [alerting] });

      logger.error("one-off failure");
      await vi.advanceTimersByTimeAsync(0);
      expect(alerting.sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100); // let the window close
      expect(alerting.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("new dedupe keys beyond maxTrackedKeys are dropped", async () => {
    const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 60_000, maxTrackedKeys: 1 });
    const logger = new Logger("app.test", { plugins: [alerting] });

    logger.error("first distinct error");
    await flushMicrotasks();
    expect(alerting.sent).toHaveLength(1);

    // second, different error while the first key's window is still open
    // (maxTrackedKeys: 1) — dropped, not sent
    logger.error("second distinct error");
    await flushMicrotasks();
    expect(alerting.sent).toHaveLength(1);
  });

  it("close() cancels pending dedupe timers", async () => {
    vi.useFakeTimers();
    try {
      const alerting = new RecordingAlertPlugin({ dedupeWindowMs: 60_000 });
      const logger = new Logger("app.test", { plugins: [alerting] });

      logger.error("first");
      logger.error("first"); // buffered as a pending follow-up
      await vi.advanceTimersByTimeAsync(0);
      expect(alerting.sent).toHaveLength(1);

      alerting.close();

      await vi.advanceTimersByTimeAsync(70_000);
      expect(alerting.sent).toHaveLength(1); // no follow-up: the timer was cancelled
    } finally {
      vi.useRealTimers();
    }
  });
});
