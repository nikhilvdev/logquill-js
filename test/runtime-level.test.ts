import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Level,
  LevelEnvWatcher,
  LevelFileWatcher,
  Logger,
  installSignalLevelHandler,
} from "../src/index.js";

afterEach(() => {
  delete process.env.LQ_TEST_LEVEL;
  vi.restoreAllMocks();
});

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("installSignalLevelHandler", () => {
  it("re-reads the env var and applies it when the signal arrives, then uninstalls cleanly", async () => {
    const logger = new Logger("app", { level: "INFO" });
    process.env.LQ_TEST_LEVEL = "DEBUG";
    const uninstall = installSignalLevelHandler(logger, { envVar: "LQ_TEST_LEVEL" });
    process.kill(process.pid, "SIGUSR2");
    await tick();
    expect(logger.level).toBe(Level.DEBUG);

    uninstall();
    expect(process.listenerCount("SIGUSR2")).toBe(0);
  });

  it("ignores an invalid or empty value with a warning naming it, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new Logger("app", { level: "INFO" });
    const uninstall = installSignalLevelHandler(logger, { envVar: "LQ_TEST_LEVEL" });
    process.env.LQ_TEST_LEVEL = "LOUD";
    process.kill(process.pid, "SIGUSR2");
    await tick();
    expect(logger.level).toBe(Level.INFO);
    expect(String(warn.mock.calls[0]?.[0])).toContain("LQ_TEST_LEVEL");

    process.env.LQ_TEST_LEVEL = "  ";
    process.kill(process.pid, "SIGUSR2");
    await tick();
    expect(warn).toHaveBeenCalledOnce();
    uninstall();
  });
});

describe("LevelFileWatcher", () => {
  const file = (content?: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), "lq-level-")), "app.level");
    if (content !== undefined) writeFileSync(path, content);
    return path;
  };

  it("applies the file's level, and only again when it changes", () => {
    const path = file("DEBUG\n");
    const logger = new Logger("app", { level: "INFO" });
    const watcher = new LevelFileWatcher(logger, path);
    watcher.pollOnce();
    expect(logger.level).toBe(Level.DEBUG);

    logger.setLevel("WARN"); // someone set it by hand
    watcher.pollOnce(); // file unchanged: leave the manual level alone
    expect(logger.level).toBe(Level.WARN);

    writeFileSync(path, "ERROR");
    watcher.pollOnce();
    expect(logger.level).toBe(Level.ERROR);
  });

  it("treats a missing file as no change until it appears", () => {
    const path = file();
    const logger = new Logger("app", { level: "INFO" });
    const watcher = new LevelFileWatcher(logger, path);
    expect(() => {
      watcher.pollOnce();
    }).not.toThrow();
    expect(logger.level).toBe(Level.INFO);
    writeFileSync(path, "TRACE");
    watcher.pollOnce();
    expect(logger.level).toBe(Level.TRACE);
  });

  it("ignores an invalid level with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new Logger("app", { level: "INFO" });
    new LevelFileWatcher(logger, file("nonsense")).pollOnce();
    expect(logger.level).toBe(Level.INFO);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("polls on a timer once started and stops when asked", async () => {
    const path = file("INFO");
    const logger = new Logger("app", { level: "WARN" });
    const watcher = new LevelFileWatcher(logger, path, { pollIntervalMs: 10 });
    watcher.start();
    watcher.start(); // idempotent
    expect(logger.level).toBe(Level.INFO);
    writeFileSync(path, "DEBUG");
    await tick(60);
    expect(logger.level).toBe(Level.DEBUG);

    watcher.stop();
    watcher.stop(); // safe twice
    writeFileSync(path, "ERROR");
    await tick(60);
    expect(logger.level).toBe(Level.DEBUG);
  });
});

describe("LevelEnvWatcher", () => {
  it("applies the variable when it changes inside the process", () => {
    const logger = new Logger("app", { level: "INFO" });
    const watcher = new LevelEnvWatcher(logger, "LQ_TEST_LEVEL");
    watcher.pollOnce(); // unset: nothing
    expect(logger.level).toBe(Level.INFO);
    process.env.LQ_TEST_LEVEL = "debug";
    watcher.pollOnce();
    expect(logger.level).toBe(Level.DEBUG);
  });
});
