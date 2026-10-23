import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTransport, Logger, fernetDecrypt, generateFernetKey } from "../../src/index.js";
import { fernetEncrypt } from "../../src/transports/fernet.js";

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

describe("FileTransport encryptKey", () => {
  // Minted by Python's `cryptography.fernet.Fernet` — proves files interoperate across the two packages.
  const pythonKey = "oy8rs0xSQbV3bKVkNG-w8NyXs_SMTP_VhrH1t1gwDKE=";
  const pythonToken =
    "gAAAAABq2t72U46ao5CH2n4XEz3MG9DiN1GiNc3iYk_dXe0PGAdDXCDd5fFRyqJUAAvNXlu0iNnn-ZoBY-5Q5D24BBscbBKN5wyhCyysB6snm0XcSr9XLX_MX5i24yCj_diZEteCwP4h";

  it("decrypts a token written by logquill-python's Fernet", () => {
    expect(fernetDecrypt(pythonKey, pythonToken)).toBe('{"message":"héllo from python"}');
  });

  it("writes one decryptable token per line and never the plaintext", async () => {
    const path = join(dir, "secret.log");
    const key = generateFernetKey();
    const transport = new FileTransport(path, { encryptKey: key });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("top secret", { ssn: "123-45-6789" });
    logger.info("second");
    await logger.flush();
    transport.close();

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("top secret");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(fernetDecrypt(key, lines[0] ?? "")) as { message: string }).message).toBe("top secret");
    expect((JSON.parse(fernetDecrypt(key, lines[1] ?? "")) as { message: string }).message).toBe("second");
  });

  it("rejects a malformed key at construction, saying how to make one", () => {
    expect(() => new FileTransport(join(dir, "bad.log"), { encryptKey: "nope" })).toThrow(/generateFernetKey/);
  });

  it("refuses the wrong key and an edited line", () => {
    const token = fernetEncrypt(generateFernetKey(), "hello");
    expect(() => fernetDecrypt(generateFernetKey(), token)).toThrow(/wrong key/);
    const key = generateFernetKey();
    const edited = fernetEncrypt(key, "hello").slice(0, -6) + "AAAAA=";
    expect(() => fernetDecrypt(key, edited)).toThrow();
  });
});

describe("FileTransport compression", () => {
  it("gzips rotated backups and shifts them as .1.gz, .2.gz", async () => {
    const path = join(dir, "app.log");
    const transport = new FileTransport(path, { maxBytes: 1, backupCount: 2, compression: "gz" });
    const logger = new Logger("app.test", { transports: [transport] });

    logger.info("first");
    logger.info("second");
    logger.info("third");
    await logger.flush();
    transport.close();

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(gunzipSync(readFileSync(`${path}.1.gz`)).toString()).toContain("third");
    expect(gunzipSync(readFileSync(`${path}.2.gz`)).toString()).toContain("second");
    expect(existsSync(`${path}.3.gz`)).toBe(false);
  });
});
