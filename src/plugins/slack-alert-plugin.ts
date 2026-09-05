import { AlertingPlugin, type AlertingPluginOptions } from "./alerting-plugin.js";
import type { LogRecord } from "../core/records.js";

/** Posts one alert body to a Slack incoming webhook URL. Swap in a fake for tests. */
export type SlackSender = (webhookUrl: string, body: string) => Promise<void> | void;

async function fetchSlackSender(webhookUrl: string, body: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `SlackAlertPlugin: webhook returned HTTP ${String(response.status)} — check the webhook URL is still valid in Slack's app config`,
    );
  }
}

function formatMessage(record: LogRecord, occurrences: number): string {
  const suffix = occurrences > 1 ? ` (x${String(occurrences)})` : "";
  return `[${record.level}] ${record.logger}: ${record.message}${suffix}`;
}

/** Options for {@link SlackAlertPlugin}. */
export interface SlackAlertPluginOptions extends AlertingPluginOptions {
  /** Posts one alert. Defaults to a `fetch` POST; override for a fake or an alternate backend. */
  sender?: SlackSender;
}

/**
 * Sends deduplicated `AlertingPlugin` alerts to a Slack incoming webhook.
 *
 * `webhookUrl` is the full "Incoming Webhook" URL from Slack's app config.
 * Uses `fetch` — no extra dependency required. Pass `sender` to swap in a
 * fake for tests or an alternate backend.
 */
export class SlackAlertPlugin extends AlertingPlugin {
  /** Slack "Incoming Webhook" URL every alert is posted to. */
  readonly webhookUrl: string;
  private readonly sender: SlackSender;

  constructor(webhookUrl: string, options: SlackAlertPluginOptions = {}) {
    super(options);
    this.webhookUrl = webhookUrl;
    this.sender = options.sender ?? fetchSlackSender;
  }

  protected async sendAlert(record: LogRecord, occurrences: number): Promise<void> {
    const body = JSON.stringify({ text: formatMessage(record, occurrences) });
    await this.sender(this.webhookUrl, body);
  }
}
