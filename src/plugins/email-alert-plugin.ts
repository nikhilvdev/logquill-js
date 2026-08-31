import { AlertingPlugin, type AlertingPluginOptions } from "./alerting-plugin.js";
import type { LogRecord } from "../core/records.js";

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/** Sends one email message. Swap in a fake for tests. */
export type EmailSender = (message: EmailMessage) => Promise<void> | void;

/** The subset of a `nodemailer` transporter that `EmailAlertPlugin` needs. */
export interface NodemailerTransporterLike {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface EmailAlertPluginOptions extends AlertingPluginOptions {
  smtpHost: string;
  smtpPort: number;
  fromAddr: string;
  toAddrs: string[];
  username?: string;
  password?: string;
  /** `false` for an SMTP server that doesn't support STARTTLS (e.g. a local relay). Default `true`. */
  useTls?: boolean;
  /** Pre-built sender, e.g. for tests. Skips the `nodemailer` auto-import entirely. */
  sender?: EmailSender;
}

/**
 * Sends deduplicated `AlertingPlugin` alerts by email over SMTP.
 *
 * `nodemailer` is an optional peer dependency: install it yourself, or
 * pass `sender` to swap in a fake for tests or an alternate backend —
 * `username`/`password` are only used if both are set.
 */
export class EmailAlertPlugin extends AlertingPlugin {
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly fromAddr: string;
  readonly toAddrs: string[];
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly useTls: boolean;
  private readonly injectedSender: EmailSender | undefined;
  private transporter: NodemailerTransporterLike | undefined;

  constructor(options: EmailAlertPluginOptions) {
    super(options);
    this.smtpHost = options.smtpHost;
    this.smtpPort = options.smtpPort;
    this.fromAddr = options.fromAddr;
    this.toAddrs = options.toAddrs;
    this.username = options.username;
    this.password = options.password;
    this.useTls = options.useTls ?? true;
    this.injectedSender = options.sender;
  }

  protected async sendAlert(record: LogRecord, occurrences: number): Promise<void> {
    let subject = `[${record.level}] ${record.logger}`;
    if (occurrences > 1) {
      subject += ` (x${String(occurrences)})`;
    }
    const text = [
      record.message,
      "",
      `occurrences: ${String(occurrences)}`,
      `timestamp: ${record.timestamp}`,
      `meta: ${JSON.stringify(record.meta)}`,
    ].join("\n");
    const message: EmailMessage = { from: this.fromAddr, to: this.toAddrs, subject, text };

    if (this.injectedSender) {
      await this.injectedSender(message);
      return;
    }

    const transporter = this.transporter ?? (await this.importTransporter());
    await transporter.sendMail({ from: message.from, to: message.to.join(", "), subject: message.subject, text: message.text });
  }

  private async importTransporter(): Promise<NodemailerTransporterLike> {
    let createTransport: (options: Record<string, unknown>) => NodemailerTransporterLike;
    try {
      // A non-literal specifier keeps this an optional peer dependency: `tsc`
      // won't try to resolve types for it, and bundlers won't force-include it.
      const moduleName = "nodemailer";
      const mod = (await import(moduleName)) as unknown as {
        default?: { createTransport?: (options: Record<string, unknown>) => NodemailerTransporterLike };
        createTransport?: (options: Record<string, unknown>) => NodemailerTransporterLike;
      };
      const resolved = mod.default?.createTransport ?? mod.createTransport;
      if (!resolved) {
        throw new Error("no createTransport export found");
      }
      createTransport = resolved;
    } catch {
      throw new Error(
        "EmailAlertPlugin: install `nodemailer` to use this plugin without providing a `sender` — `npm install nodemailer`",
      );
    }

    this.transporter = createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      secure: false,
      requireTLS: this.useTls,
      auth: this.username && this.password ? { user: this.username, pass: this.password } : undefined,
    });
    return this.transporter;
  }
}
