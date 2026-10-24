import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { hostname } from "node:os";
import { connect, type Socket as TcpSocket } from "node:net";
import type { Formatter } from "../../core/formatter.js";
import { Level, parseLevel } from "../../core/levels.js";
import type { LogRecord } from "../../core/records.js";
import { Transport } from "../transport.js";

/** Delivers one already-framed syslog message. Swap in a fake for tests. */
export type SyslogSender = (data: Buffer) => void;

const FACILITY_USER = 1;
const NIL = "-";

// TCP writes queue in memory while the server is slow or unreachable; past this, new messages are dropped.
const MAX_PENDING_TCP_BYTES = 1024 * 1024;

// LogQuill has no equivalent of syslog's alert/emergency severities.
const SEVERITY: Readonly<Record<Level, number>> = {
  [Level.TRACE]: 7,
  [Level.DEBUG]: 7,
  [Level.INFO]: 6,
  [Level.WARN]: 4,
  [Level.ERROR]: 3,
  [Level.FATAL]: 2,
};

/** Options for {@link SyslogTransport}. */
export interface SyslogTransportOptions {
  /** Syslog server host. Default `"localhost"`. */
  host?: string;
  /** Syslog server port. Default `514`. */
  port?: number;
  /** `"udp"` (default) or `"tcp"`. */
  protocol?: "udp" | "tcp";
  /** Standard syslog facility code. Default `1` (`LOG_USER`). */
  facility?: number;
  /** RFC 5424 APP-NAME. Defaults to each record's logger name. */
  appName?: string;
  /** Turns a `LogRecord` into the message text. Defaults to `JSONFormatter`. */
  formatter?: Formatter;
  /** Delivers one framed message. Defaults to a real socket, opened lazily on first use; override for a fake. */
  sender?: SyslogSender;
}

/**
 * Sends each record as one RFC 5424 message over UDP (default) or TCP, using
 * Node's `dgram`/`net` — no dependency. Not batched: syslog is one message
 * per datagram. TCP messages are newline-framed (RFC 6587 non-transparent
 * framing); a UDP datagram needs no framing. Delivery is fire-and-forget, so
 * a down server never blocks or throws into the caller; a failed or closed TCP
 * connection is re-opened on the next record, and while a server is slow or
 * unreachable at most 1 MiB is queued before new messages are dropped. Sockets
 * are unref'd, so they never keep the process alive.
 */
export class SyslogTransport extends Transport {
  /** Syslog server host. */
  readonly host: string;
  /** Syslog server port. */
  readonly port: number;
  /** `"udp"` or `"tcp"`. */
  readonly protocol: "udp" | "tcp";
  /** Syslog facility code. */
  readonly facility: number;
  /** RFC 5424 APP-NAME, or `undefined` to use each record's logger name. */
  readonly appName: string | undefined;
  private readonly hostName = hostname();
  private readonly injected: SyslogSender | undefined;
  private udp: UdpSocket | undefined;
  private tcp: TcpSocket | undefined;

  constructor(options: SyslogTransportOptions = {}) {
    super(options.formatter);
    const protocol: string = options.protocol ?? "udp";
    if (protocol !== "udp" && protocol !== "tcp") {
      throw new Error(
        `SyslogTransport: protocol must be 'udp' or 'tcp', got ${JSON.stringify(protocol)}`,
      );
    }
    this.protocol = protocol;
    this.host = options.host ?? "localhost";
    this.port = options.port ?? 514;
    this.facility = options.facility ?? FACILITY_USER;
    this.appName = options.appName;
    this.injected = options.sender;
  }

  /** Frames `formatted` as one RFC 5424 message and sends it immediately. */
  write(formatted: string, record: LogRecord): void {
    const pri = this.facility * 8 + SEVERITY[parseLevel(record.level)];
    const appName = this.appName ?? record.logger;
    const message = `<${String(pri)}>1 ${record.timestamp} ${this.hostName} ${appName} ${String(process.pid)} ${NIL} ${NIL} ${formatted}`;
    const data = Buffer.from(this.protocol === "tcp" ? `${message}\n` : message, "utf8");
    if (this.injected) this.injected(data);
    else this.send(data);
  }

  /** Closes the underlying socket, if one was opened. */
  override close(): void {
    this.udp?.close();
    this.tcp?.end();
    this.udp = undefined;
    this.tcp = undefined;
  }

  private send(data: Buffer): void {
    if (this.protocol === "udp") {
      // The send callback swallows errors: UDP delivery is best effort.
      if (!this.udp) {
        const socket = createSocket("udp4");
        // unref: an open socket must not keep the process alive after the app is done.
        socket.unref().on("error", () => {
          if (this.udp === socket) this.udp = undefined;
        });
        this.udp = socket;
      }
      this.udp.send(data, this.port, this.host, () => undefined);
      return;
    }
    if (!this.tcp) {
      const socket = connect(this.port, this.host);
      const forget = (): void => {
        if (this.tcp === socket) this.tcp = undefined;
      };
      // A closed or failed connection is replaced on the next record.
      socket.unref().on("error", forget).on("close", forget);
      this.tcp = socket;
    }
    if (this.tcp.writableLength + data.length > MAX_PENDING_TCP_BYTES) return;
    this.tcp.write(data);
  }
}
