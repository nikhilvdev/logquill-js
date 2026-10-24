# Migrating from logquill 1.x to 2.0

2.0 extends the record shape shared with `logquill` on PyPI and renames the
named `meta` keys to snake_case so both packages write byte-compatible
records. Application code that only calls `logger.info(...)` and friends
needs no changes; what changes is what's on disk and on the wire.

## 1. Every record carries `schema_version`

Records now start with `"schema_version": "2.0"`:

```json
{
  "schema_version": "2.0",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "level": "INFO",
  "logger": "app",
  "message": "hello",
  "meta": {}
}
```

**If you read logs** — a parser, a dashboard, a SIEM rule — make sure it
tolerates one extra top-level key. A strict "exactly these five keys" check is
the only thing that breaks.

**Existing 1.x logs don't need converting.** A record with no `schema_version`
is a 1.x record, and `parseRecord` reads both:

```ts
import { parseRecord } from "logquill";

const record = parseRecord(JSON.parse(line)); // a 1.x or 2.x line
record.schema_version; // "1.0" for a 1.x record, "2.0" for a 2.x one
```

`parseRecord` throws, with a message saying to upgrade, on a record from a
newer major version, and says what is wrong with a record that is malformed.

## 2. Named `meta` keys are snake_case

| 1.x                 | 2.0                   |
| ------------------- | --------------------- |
| `meta.runId`        | `meta.run_id`         |
| `meta.spanId`       | `meta.span_id`        |
| `meta.parentSpanId` | `meta.parent_span_id` |
| `meta.traceId`      | `meta.trace_id`       |
| `meta.durationMs`   | `meta.duration_ms`    |
| `meta.prevHash`     | `meta.prev_hash`      |

Your own `meta` keys are not touched. `parseRecord` renames exactly the keys in
the table, and only on a record with no `schema_version` (a 1.x record), so
old logs read the same as new ones.

What does **not** change is the options you pass in code: `RunPlugin({ runId })`,
`logger.span(name, fn, { spanId, parentSpanId })` and `plugin.runId` keep their
camelCase names. What you must update is anything that reads or writes those
keys in `meta` directly:

```ts
// 1.x
logger.info("step", { traceId: req.id });
record.meta.runId;

// 2.0
logger.info("step", { trace_id: req.id });
record.meta.run_id;
```

`TraceContextPlugin` and `SamplingPlugin` default their `traceKey` option to
`"trace_id"`; if you passed `traceKey: "traceId"` explicitly, it still works.

## 3. SQL and DynamoDB column names

`PostgresTransport`, `MySQLTransport` and `SQLiteTransport` now write
`run_id`, `span_id`, `parent_span_id` and `trace_id` columns (they were
`runId`, ...), matching `logquill-python`. `DynamoDBTransport` items use the
same attribute names, and the partition key attribute is `run_id`.

These are schema changes, and this package does not alter your tables. Before
upgrading, either rename the columns:

```sql
ALTER TABLE logs RENAME COLUMN "runId" TO run_id;       -- Postgres; repeat for the other three
ALTER TABLE logs RENAME COLUMN runId TO run_id;         -- MySQL 8 / SQLite 3.25+
```

or point the 2.0 transport at a new table. A DynamoDB partition key can't be
renamed in place, so create a new table keyed on `run_id` and let the old one
age out.

## 4. Tamper-evident chains

`TamperEvidentPlugin` now computes its hash over the same canonical JSON text
`logquill-python` does, and covers `schema_version` and `llm`. A chain written
by either package verifies in the other.

**A chain written by logquill-js 1.x does not verify under 2.0**, because its
hashes were computed over different bytes and different key names. Keep the
1.x release around to verify old files, or record the last 1.x `hash` and
start the 2.0 chain from it with `genesisHash`.

Known limits, all from JavaScript reading a number Python wrote:

- JSON can't tell `12` from `12.0`, so a Python record with an integral float
  (`12.0`) hashes as `12.0` in Python but `12` when JS recomputes it.
- Integers above 2^53 lose precision when JS parses them, so they hash
  differently from the digits Python wrote.
- Python writes floats of 1e16 or more in exponent form (`1e+16`); JS reads
  them back as integers and prints all the digits.

Non-integral floats, including very small ones like `2e-05`, match.
