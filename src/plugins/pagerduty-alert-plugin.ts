import { AlertingPlugin, type AlertingPluginOptions } from "./alerting-plugin.js";
import type { LogRecord } from "../core/records.js";

const ENDPOINT = "https://events.pagerduty.com/v2/enqueue";
const SEVERITY: Readonly<Record<string, string>> = { ERROR: "error", FATAL: "critical" };

/** POSTs one PagerDuty Events API v2 payload. Swap in a fake for tests. */
export type PagerDutySender = (body: string) => Promise<void> | void;

async function fetchPagerDutySender(body: string): Promise<void> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `PagerDutyAlertPlugin: Events API returned HTTP ${String(response.status)} — check the routing key is a valid Events API v2 integration key`,
    );
  }
}

/** Options for {@link PagerDutyAlertPlugin}. */
export interface PagerDutyAlertPluginOptions extends AlertingPluginOptions {
  /** Posts one Events API v2 payload. Defaults to a `fetch` POST; override for a fake or an alternate backend. */
  sender?: PagerDutySender;
}

/**
 * Sends deduplicated `AlertingPlugin` alerts to PagerDuty via the Events
 * API v2 (`POST https://events.pagerduty.com/v2/enqueue`).
 *
 * `routingKey` is an Events API v2 integration key from a PagerDuty
 * service. Uses `fetch` — no extra dependency required. Pass `sender` to
 * swap in a fake for tests or an alternate backend.
 */
export class PagerDutyAlertPlugin extends AlertingPlugin {
  /** PagerDuty Events API v2 integration key every alert is sent under. */
  readonly routingKey: string;
  private readonly sender: PagerDutySender;

  constructor(routingKey: string, options: PagerDutyAlertPluginOptions = {}) {
    super(options);
    this.routingKey = routingKey;
    this.sender = options.sender ?? fetchPagerDutySender;
  }

  protected async sendAlert(record: LogRecord, occurrences: number): Promise<void> {
    let summary = `${record.logger}: ${record.message}`;
    if (occurrences > 1) {
      summary += ` (x${String(occurrences)})`;
    }
    const body = JSON.stringify({
      routing_key: this.routingKey,
      event_action: "trigger",
      payload: {
        summary,
        severity: SEVERITY[record.level] ?? "error",
        source: record.logger,
        timestamp: record.timestamp,
        custom_details: { occurrences, ...record.meta },
      },
    });
    await this.sender(body);
  }
}
