import { randomUUID } from "node:crypto";
import type { Plugin } from "../core/plugin.js";
import type { LogRecord } from "../core/records.js";

/** Options for {@link RunPlugin}. */
export interface RunPluginOptions {
  /** Adopt an id handed in from elsewhere (e.g. an upstream call) instead of generating a fresh `randomUUID()`. */
  runId?: string;
}

/**
 * Stamps `meta.runId` — a stable id grouping every record from one agent
 * run — plus an incrementing `meta.step` counter, one per record processed
 * through this plugin instance.
 *
 * Distinct from `TraceContextPlugin`'s `traceId`: `runId` scopes one agent
 * run, `traceId` follows one request across services. A run can span
 * multiple traces (e.g. an agent that calls several downstream services);
 * the two ids are independent.
 *
 * One instance is one run: attach a fresh `RunPlugin()` per run (typically
 * via `logger.child("agent").use(new RunPlugin())`), never a process-wide
 * singleton shared across runs — otherwise concurrent runs would share both
 * the run id and the step counter.
 *
 * A record that already carries `meta.runId` (e.g. propagated from an
 * upstream call) keeps its existing value; `meta.step` is always set from
 * this instance's own counter.
 */
export class RunPlugin implements Plugin {
  /** Id stamped onto `meta.runId` for every record this instance processes. */
  readonly runId: string;
  private step = 0;

  constructor(options: RunPluginOptions = {}) {
    this.runId = options.runId ?? randomUUID();
  }

  beforeLog(record: LogRecord): LogRecord {
    record.meta.runId ??= this.runId;
    record.meta.step = this.step++;
    return record;
  }
}
