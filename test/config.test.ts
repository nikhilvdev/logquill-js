import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTransport,
  loadConfig,
  loggerFromEnv,
  loggerFromFile,
  SamplingPlugin,
  TextFormatter,
} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "lq-config-"));
const write = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("loadConfig", () => {
  it("builds transports and plugins from built-in types, converting snake_case options", async () => {
    const logger = await loadConfig({
      name: "svc",
      level: "DEBUG",
      transports: [
        { type: "console", options: { formatter: "text" } },
        { type: "file", options: { path: join(dir, "a.log"), max_bytes: 123, backup_count: 2 } },
      ],
      plugins: [{ type: "sampling", options: { rate: 0.5 } }],
      max_queue_size: 5,
      backpressure: "drop_newest",
    });
    expect(logger.name).toBe("svc");
    const [console_, file] = (logger as unknown as { transports: unknown[] }).transports;
    expect((console_ as { formatter: unknown }).formatter).toBeInstanceOf(TextFormatter);
    expect(file).toBeInstanceOf(FileTransport);
    expect((file as FileTransport).maxBytes).toBe(123);
    expect((file as FileTransport).backupCount).toBe(2);
    expect((logger as unknown as { plugins: unknown[] }).plugins[0]).toBeInstanceOf(SamplingPlugin);
  });

  it("resolves a class entry from a module and export name", async () => {
    const logger = await loadConfig({
      transports: [{ class: "../src/index.js#ConsoleTransport", options: { colorize: false } }],
    });
    expect((logger as unknown as { transports: unknown[] }).transports).toHaveLength(1);
  });

  it("fails with an actionable message on bad entries", async () => {
    await expect(loadConfig({ transports: [{ type: "nope" }] })).rejects.toThrow(
      /built-in types are: console, file/,
    );
    await expect(loadConfig({ transports: [{}] })).rejects.toThrow(/needs a 'type' or 'class'/);
    await expect(loadConfig({ transports: [{ class: "nohash" }] })).rejects.toThrow(
      /<module>#<ExportName>/,
    );
    await expect(loadConfig({ transports: [{ type: "file" }] })).rejects.toThrow(/options.path/);
    await expect(
      loadConfig({ transports: [{ type: "console", options: { formatter: "xml" } }] }),
    ).rejects.toThrow(/Unknown formatter/);
  });
});

describe("loggerFromFile", () => {
  it("loads JSON and YAML", async () => {
    const json = await loggerFromFile(write("c.json", '{"level":"ERROR","name":"j"}'));
    expect(json.name).toBe("j");
    const yaml = await loggerFromFile(
      write("c.yaml", "level: WARN\nname: y\ntransports:\n  - type: console\n"),
    );
    expect(yaml.name).toBe("y");
  });

  it("rejects a non-object file", async () => {
    await expect(loggerFromFile(write("bad.json", "[1]"))).rejects.toThrow(/must be an object/);
  });
});

describe("loggerFromEnv", () => {
  afterEach(() => {
    delete process.env.LOGQUILL_CONFIG_FILE;
    delete process.env.LOGQUILL_LEVEL;
  });

  it("LEVEL wins over the config file's level", async () => {
    process.env.LOGQUILL_CONFIG_FILE = write("e.json", '{"level":"ERROR"}');
    process.env.LOGQUILL_LEVEL = "DEBUG";
    const logger = await loggerFromEnv();
    expect(logger.debug("x")).not.toBeNull();
  });

  it("works with no environment set", async () => {
    expect(await loggerFromEnv()).toBeDefined();
  });
});
