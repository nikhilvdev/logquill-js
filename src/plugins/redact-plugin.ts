import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

export const DEFAULT_REDACTED_KEYS: readonly string[] = ["password", "token", "secret", "api_key", "authorization"];

export interface RedactPluginOptions {
  keys?: readonly string[];
  replacement?: string;
}

/** Replaces sensitive `meta` values, matched by key (case-insensitive), with a placeholder. */
export class RedactPlugin implements Plugin {
  private readonly keys: ReadonlySet<string>;
  readonly replacement: string;

  constructor(options: RedactPluginOptions = {}) {
    this.keys = new Set((options.keys ?? DEFAULT_REDACTED_KEYS).map((key) => key.toLowerCase()));
    this.replacement = options.replacement ?? "***";
  }

  beforeLog(record: LogRecord): LogRecord {
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.meta)) {
      meta[key] = this.keys.has(key.toLowerCase()) ? this.replacement : value;
    }
    return { ...record, meta };
  }
}
