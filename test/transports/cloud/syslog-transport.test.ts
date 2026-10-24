import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { Logger, SyslogTransport } from "../../../src/index.js";

describe("SyslogTransport", () => {
  it("frames a record as RFC 5424 with the level's severity", async () => {
    const sent: Buffer[] = [];
    const transport = new SyslogTransport({ sender: (data) => sent.push(data), appName: "svc" });
    const logger = new Logger("app", { transports: [transport] });
    logger.error("disk full");
    await logger.flush();
    const text = sent[0]?.toString() ?? "";
    expect(text).toMatch(/^<11>1 \d{4}-\d\d-\d\dT[\d:.]+Z \S+ svc \d+ - - \{/); // facility 1 * 8 + severity 3
    expect(text).toContain('"message":"disk full"');
    expect(text.endsWith("\n")).toBe(false);
  });

  it("maps WARN to severity 4 and newline-frames TCP", async () => {
    const sent: Buffer[] = [];
    const logger = new Logger("app", {
      transports: [
        new SyslogTransport({ protocol: "tcp", facility: 16, sender: (d) => sent.push(d) }),
      ],
    });
    logger.warn("careful");
    await logger.flush();
    const text = sent[0]?.toString() ?? "";
    expect(text.startsWith("<132>1 ")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("rejects an unknown protocol", () => {
    expect(() => new SyslogTransport({ protocol: "smtp" as "udp" })).toThrow(/'udp' or 'tcp'/);
  });

  it("delivers over a real UDP socket", async () => {
    const server = createSocket("udp4");
    const received = new Promise<string>((resolve) =>
      server.once("message", (m) => {
        resolve(m.toString());
      }),
    );
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    const transport = new SyslogTransport({ host: "127.0.0.1", port: server.address().port });
    const logger = new Logger("app", { transports: [transport] });
    logger.info("over the wire");
    await logger.flush();
    expect(await received).toContain("over the wire");
    transport.close();
    server.close();
  });

  it("does not throw into the caller when nothing is listening on TCP", async () => {
    const transport = new SyslogTransport({ host: "127.0.0.1", port: 1, protocol: "tcp" });
    const logger = new Logger("app", { transports: [transport] });
    logger.info("nobody home");
    await logger.flush();
    await new Promise((r) => setTimeout(r, 50));
    transport.close();
  });
});

describe("SyslogTransport sockets", () => {
  it("does not keep the process alive after logging", async () => {
    const { spawnSync } = await import("node:child_process");
    const entry = new URL("../../../src/index.ts", import.meta.url).pathname;
    const script = `import { Logger, SyslogTransport } from ${JSON.stringify(entry)};
      const l = new Logger("a", { transports: [new SyslogTransport({ host: "127.0.0.1", port: 9 })] });
      l.info("x"); await l.flush();`;
    const result = spawnSync("npx", ["tsx", "--input-type=module", "-e", script], {
      timeout: 15_000,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }, 20_000);

  it("drops messages instead of queueing without bound while a TCP server is not reading", async () => {
    const { createServer } = await import("node:net");
    const server = createServer((socket) => socket.pause());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const transport = new SyslogTransport({ host: "127.0.0.1", port, protocol: "tcp" });
    const logger = new Logger("app", { transports: [transport], queue: { maxSize: 100_000 } });
    const big = "x".repeat(60_000);
    for (let i = 0; i < 400; i += 1) logger.info(big); // 24 MB offered
    await logger.flush();
    const pending =
      (transport as unknown as { tcp?: { writableLength: number } }).tcp?.writableLength ?? 0;
    expect(pending).toBeLessThanOrEqual(1024 * 1024 + 70_000);
    transport.close();
    server.close();
  });

  it("reconnects after the server closes the connection", async () => {
    const { createServer } = await import("node:net");
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (d) => received.push(d.toString()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const transport = new SyslogTransport({ host: "127.0.0.1", port, protocol: "tcp" });
    const logger = new Logger("app", { transports: [transport] });
    logger.info("first");
    await logger.flush();
    await new Promise((r) => setTimeout(r, 50));
    (transport as unknown as { tcp: { destroy(): void } }).tcp.destroy();
    await new Promise((r) => setTimeout(r, 50));
    logger.info("second");
    await logger.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(received.join("")).toContain("second");
    transport.close();
    server.close();
  });
});
