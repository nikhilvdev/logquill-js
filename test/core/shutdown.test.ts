import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { installShutdownHandlers } from "../../src/core/shutdown.js";
import { CollectingTransport, Logger } from "../../src/index.js";

describe("installShutdownHandlers", () => {
  const uninstalls: (() => void)[] = [];
  let exitSpy: MockInstance<typeof process.exit> | undefined;

  afterEach(() => {
    for (const uninstall of uninstalls.splice(0)) {
      uninstall();
    }
    exitSpy?.mockRestore();
    exitSpy = undefined;
  });

  it("flushes and closes the logger on beforeExit, without calling process.exit", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    logger.info("queued before shutdown");

    uninstalls.push(installShutdownHandlers(logger));
    process.emit("beforeExit", 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.records).toHaveLength(1);
    expect(transport.closed).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("flushes, closes, and exits on a registered signal", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    logger.warn("queued before SIGTERM");

    uninstalls.push(installShutdownHandlers(logger, { signals: ["SIGTERM"] }));
    process.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.records).toHaveLength(1);
    expect(transport.closed).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("only runs the shutdown sequence once even if multiple signals fire", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const transport = new CollectingTransport();
    const logger = new Logger("app.test", { transports: [transport] });
    let closeCalls = 0;
    const originalClose = transport.close.bind(transport);
    transport.close = () => {
      closeCalls += 1;
      originalClose();
    };

    uninstalls.push(installShutdownHandlers(logger, { signals: ["SIGTERM", "SIGINT"] }));
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeCalls).toBe(1);
  });

  it("the returned unsubscribe function removes the listeners", () => {
    const logger = new Logger("app.test");
    const before = process.listenerCount("SIGTERM");

    const uninstall = installShutdownHandlers(logger, { signals: ["SIGTERM"] });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
