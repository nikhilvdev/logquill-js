import type { LogRecord } from "../../core/records.js";

/**
 * Returns a copy of `record` with Elastic Common Schema fields added alongside
 * LogQuill's own — never replacing them, since ECS is permissive about extra
 * fields. Naming the *standard* fields correctly is what makes Kibana's
 * default Discover view, dashboards and alerting rules work on this data with
 * no manual field mapping:
 *
 * - `@timestamp` from `timestamp`
 * - `log.level` from `level`, lowercased
 * - `service.name` from `logger`
 * - `trace.id` / `span.id` from `meta.trace_id` / `meta.span_id`, when present
 * - `error.message` / `error.stack_trace` when `meta.stack` is present
 *   (`error.message` reuses the record's own `message`)
 *
 * The only module that knows ECS field names; `ElasticsearchTransport` is its
 * only caller.
 */
export function toEcsDocument(record: LogRecord): Record<string, unknown> {
  const { meta } = record;
  const document: Record<string, unknown> = { ...record };
  document["@timestamp"] = record.timestamp;
  document.log = { level: record.level.toLowerCase() };
  document.service = { name: record.logger };

  const traceId = meta.trace_id;
  if (traceId !== undefined && traceId !== null) document.trace = { id: traceId };

  const spanId = meta.span_id;
  if (spanId !== undefined && spanId !== null) document.span = { id: spanId };

  if (typeof meta.stack === "string") {
    document.error = { message: record.message, stack_trace: meta.stack };
  }
  return document;
}
