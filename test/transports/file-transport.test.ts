import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTransport, Logger } from "../../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logquill-file-transport-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileTransport", () => {
  it("appends writes to the file", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path);
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    logger.info("second");
    await logger.flush();
    transport.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("rotates the current file to a .1 backup once it exceeds maxBytes", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path, { maxBytes: 1, backupCount: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    logger.info("second");
    await logger.flush();
    transport.close();

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("shifts existing numbered backups up before writing .1", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path, { maxBytes: 1, backupCount: 2 });
    const logger = new Logger("app.test", { transports: [transport] });

    // maxBytes: 1 rotates on every write, so three writes force three rotations.
    logger.info("first");
    logger.info("second");
    logger.info("third");
    await logger.flush();
    transport.close();

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
  });

  it("with backupCount 1, repeated rotation replaces the single backup", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path, { maxBytes: 1, backupCount: 1 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    logger.info("second");
    await logger.flush();
    transport.close();

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it("with backupCount 0, rotation deletes the file instead of keeping a backup", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path, { maxBytes: 1, backupCount: 0 });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    await logger.flush();
    transport.close();

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("creates parent directories that don't exist yet", async () => {
    const path = join(dir, "nested", "dir", "app.log");
    const transport = new FileTransport(path);
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("hi");
    await logger.flush();
    transport.close();

    expect(existsSync(path)).toBe(true);
  });
});
