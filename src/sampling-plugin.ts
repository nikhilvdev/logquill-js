import type { Plugin } from "./plugin.js";
import type { LogRecord } from "./records.js";

export interface SamplingPluginOptions {
  rng?: () => number;
}

/** Keeps roughly `rate` of records (0.0-1.0), dropping the rest. */
export class SamplingPlugin implements Plugin {
  readonly rate: number;
  private readonly rng: () => number;

  constructor(rate: number, options: SamplingPluginOptions = {}) {
    if (rate < 0 || rate > 1) {
      throw new Error(`rate must be between 0 and 1, got ${String(rate)}`);
    }
    this.rate = rate;
    this.rng = options.rng ?? Math.random;
  }

  beforeLog(record: LogRecord): LogRecord | null {
    return this.rng() < this.rate ? record : null;
  }
}
