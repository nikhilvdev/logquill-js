# logquill

[![CI](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/logquill.svg)](https://www.npmjs.com/package/logquill)
[![npm downloads](https://img.shields.io/npm/dm/logquill.svg)](https://www.npmjs.com/package/logquill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

Status: pre-release, under active development. The core `Logger`, level
filtering, a full plugin pipeline (context/redaction/PII/tamper-evidence/
sampling/alerting), `JSONFormatter`, and a broad transport catalog —
console/file/HTTP, SQL, NoSQL, message queues, and cloud-native log
platforms — are implemented; non-blocking async dispatch is not yet — see
`CHANGELOG.md` for what's landed so far.

## Features

- **Structured by default** — every call carries a `meta` object, not just a message string
- **Cross-language record shape** — identical JSON shape and level names/weights as [`logquill` on PyPI](https://pypi.org/project/logquill/)
- **Pluggable formatters** — `JSONFormatter` out of the box; implement `format(record) -> string` for your own
- **A transport for wherever your logs need to go** — console, file, and HTTP out of the box, plus SQL (SQLite/Postgres/MySQL), NoSQL (MongoDB/DynamoDB/Redis), message queues (Kafka/RabbitMQ/SQS/Pub-Sub), and cloud-native platforms (CloudWatch/Cloud Logging/App Insights/Datadog/Elasticsearch/New Relic) — see [Transports](#transports). Every backend driver is an **optional peer dependency**: install only the one you use, or inject a pre-built client. Write your own by subclassing `Transport`; `CollectingTransport` ships as an in-memory sink, handy for tests
- **Plugin pipeline** — `ContextPlugin`, `RedactPlugin`, `PIIRedactPlugin`, tail-based `SamplingPlugin`, `TamperEvidentPlugin`, and `AlertingPlugin` (`SlackAlertPlugin`/`PagerDutyAlertPlugin`/`EmailAlertPlugin`) out of the box; `beforeLog`/`afterLog`/`onError` hooks, or just pass a plain function to `.use()`; a throwing plugin can't crash logging — see [Plugins](#plugins)
- **Child loggers** — `.child()` inherits level, transports, and plugins, and merges its own `meta` on top
- **Typed throughout** — TypeScript strict mode, no `any` in the public API
- **Dual package** — works via both `require()` (CJS) and `import` (ESM) from the same published package
- *(planned)* non-blocking async dispatch, `AsyncLocalStorage`-based context propagation — see `CHANGELOG.md`

## Contents

- [Install](#install)
- [Usage](#usage)
- [Transports](#transports)
  - [SQL transports](#sql-transports)
  - [NoSQL transports](#nosql-transports)
  - [Message queue transports](#message-queue-transports)
  - [Cloud-native transports](#cloud-native-transports)
- [Plugins](#plugins)
  - [Tail-based sampling](#tail-based-sampling)
  - [PII redaction](#pii-redaction)
  - [Tamper-evident logs](#tamper-evident-logs)
  - [Alerting](#alerting)
- [Development](#development)
- [License](#license)

## Install

```sh
npm install logquill
```

## Usage

```ts
import { Level, Logger } from "logquill";

const logger = new Logger("app", { level: Level.INFO });

const record = logger.info("user signed up", { user_id: 42, plan: "pro" });
console.log(record);
// { timestamp: '2026-08-29T07:12:55.968Z', level: 'INFO', logger: 'app',
//   message: 'user signed up', meta: { user_id: 42, plan: 'pro' } }

logger.debug("below threshold, dropped"); // -> null, filtered by level
logger.setLevel("debug");
logger.debug("now visible"); // -> a record
```

Every log call returns the record (or `null` if filtered by level) —
`{"timestamp": ISO8601, "level": string, "logger": string, "message": string, "meta": object}`,
the same shape shared with [`logquill` on PyPI](https://pypi.org/project/logquill/).
Use `JSONFormatter` to serialize a record to the canonical JSON line:

```ts
import { JSONFormatter } from "logquill";

console.log(new JSONFormatter().format(record));
// '{"timestamp":"2026-08-29T07:12:55.968Z","level":"INFO","logger":"app","message":"user signed up","meta":{"user_id":42,"plan":"pro"}}'
```

`.child()` creates a logger scoped under this one, inheriting its level,
transports, and plugins, and merging its own `meta` on top:

```ts
const dbLogger = logger.child("db", { component: "pool" });
dbLogger.warn("connection lost");
// logger: "app.db", meta: { component: "pool" }
```

`.use()` registers a plugin implementing `beforeLog`/`afterLog`/`onError`
hooks (all optional; a throwing hook is caught and routed to `onError`
rather than crashing logging):

```ts
logger.use({
  beforeLog(record) {
    return { ...record, message: record.message.toUpperCase() };
  },
});
```

Works from both ESM (`import`) and CommonJS (`require`) — the package ships
a dual build with full TypeScript types.

## Transports

Attach transports to a `Logger` to actually write records somewhere. Each
record is dispatched to every attached transport synchronously
(non-blocking dispatch isn't implemented yet). Every backend driver below
is an **optional peer dependency** — `npm install` only pulls in what you
actually import; nothing is installed on your behalf.

| Transport | Backend | Peer dependency | Setup |
|---|---|---|---|
| `ConsoleTransport` | stdout/stderr via `console.*` | *(none)* | zero-setup, isomorphic |
| `FileTransport` | local file, with rotation | *(none)* | zero-setup |
| `HTTPTransport` | any HTTP log endpoint | *(none, uses `fetch`)* | zero-setup |
| `SQLiteTransport` | SQLite | `better-sqlite3` | zero-setup (file or `:memory:`) |
| `PostgresTransport` | PostgreSQL | `pg` | needs a server |
| `MySQLTransport` | MySQL | `mysql2` | needs a server |
| `MongoDBTransport` | MongoDB | `mongodb` | needs a server |
| `DynamoDBTransport` | AWS DynamoDB | `@aws-sdk/client-dynamodb` | needs an AWS account |
| `RedisTransport` | Redis Streams | `redis` | needs a server |
| `KafkaTransport` | Kafka | `kafkajs` | needs a broker |
| `RabbitMQTransport` | RabbitMQ | `amqplib` | needs a broker |
| `SQSTransport` | AWS SQS | `@aws-sdk/client-sqs` | needs an AWS account |
| `PubSubTransport` | GCP Pub/Sub | `@google-cloud/pubsub` | needs a GCP account |
| `CloudWatchTransport` | AWS CloudWatch Logs | `@aws-sdk/client-cloudwatch-logs` | needs an AWS account |
| `CloudLoggingTransport` | GCP Cloud Logging | `@google-cloud/logging` | needs a GCP account |
| `AppInsightsTransport` | Azure Application Insights | `applicationinsights` | needs an Azure account |
| `DatadogTransport` | Datadog Logs | *(none, uses `fetch`)* | needs a Datadog account |
| `ElasticsearchTransport` | Elasticsearch `_bulk` API | *(none, uses `fetch`)* | needs a cluster |
| `NewRelicTransport` | New Relic Log API | *(none, uses `fetch`)* | needs a New Relic account |

Every transport also accepts an injected client/sender in place of its
default driver — the pattern every example below and every transport's own
test suite uses, so you never need a live backend just to test your
logging setup.

```ts
import { ConsoleTransport, FileTransport, HTTPTransport, Logger } from "logquill";

const logger = new Logger("app", {
  transports: [
    new ConsoleTransport(), // console.log; ERROR/FATAL to console.error, colorized
    new FileTransport("app.log", { maxBytes: 10 * 1024 * 1024, backupCount: 5 }),
    new HTTPTransport("https://logs.example.com/ingest", { batchSize: 50 }),
  ],
});

logger.info("user signed up", { user_id: 42 });
logger.close(); // flushes the HTTPTransport's pending batch, closes the FileTransport's fd
```

`ConsoleTransport` writes via `console.log`/`console.error` (not
`process.stdout`/`stderr`), so it works unmodified in a browser bundle.
Colorizing defaults to on, unless the [`NO_COLOR`](https://no-color.org)
environment variable is set. `FileTransport` rotates the file once it
exceeds `maxBytes`, keeping `backupCount` numbered backups (`.1`, `.2`, …).
`HTTPTransport` batches formatted lines and POSTs them as
newline-delimited JSON once `batchSize` is reached, or on `.close()`/
`.flush()`; pass `sender` to swap in a fake for tests or a different
backend.

Write your own by subclassing `Transport` (implement `write(formatted,
record)`; `format()` and `close()` have defaults), or use
`CollectingTransport` — an in-memory sink included for tests:

```ts
import { CollectingTransport } from "logquill";

const sink = new CollectingTransport();
const logger2 = new Logger("app", { transports: [sink] });
logger2.info("hello");
console.log(sink.formatted); // ['{"timestamp":...,"message":"hello",...}']
```

### SQL transports

`SQLiteTransport`, `PostgresTransport`, and `MySQLTransport` all extend
`BaseSQLTransport`, which owns a fixed `logs` table schema (`timestamp`,
`level`, `logger`, `message`, `meta`, plus `runId`/`spanId`/`parentSpanId`/
`traceId` for future trace correlation) and always batches inserts into one
parameterized multi-row `INSERT` — never one query per log call. Each
driver (`better-sqlite3`, `pg`, `mysql2`) is an **optional peer
dependency** — install only the one you use, or inject a pre-built
client/pool directly (handy for tests). Production schema/migrations are
your responsibility; pass `ensureSchema: true` to auto-create the table for
local dev/test only.

```ts
import { Logger, SQLiteTransport } from "logquill";

const transport = new SQLiteTransport({ filename: "app.db", ensureSchema: true });
const logger = new Logger("app", { transports: [transport] });

logger.info("user signed up", { userId: "u_123" });
await new Promise((r) => setImmediate(r)); // let the batch flush in this example
logger.close();
```

```ts
import { Logger, PostgresTransport } from "logquill";
// npm install pg

const transport = new PostgresTransport({ connectionString: process.env.DATABASE_URL, maxRecords: 100 });
const logger = new Logger("app", { transports: [transport] });

logger.info("user signed up", { userId: "u_123" });
logger.close();
```

```ts
import { Logger, MySQLTransport } from "logquill";
// npm install mysql2

const transport = new MySQLTransport({ connectionString: "mysql://user:pass@localhost:3306/app" });
const logger = new Logger("app", { transports: [transport] });

logger.info("user signed up", { userId: "u_123" });
logger.close();
```

### NoSQL transports

`MongoDBTransport`, `DynamoDBTransport`, and `RedisTransport` are all
optional peer dependencies too — install only the driver you use, or
inject a pre-built client/collection directly.

```ts
import { Logger, MongoDBTransport } from "logquill";
// npm install mongodb

const transport = new MongoDBTransport({
  connectionString: "mongodb://localhost:27017",
  database: "app",
  collectionName: "logs",
});
const logger = new Logger("app", { transports: [transport] });
logger.info("user signed up", { userId: "u_123" });
```

```ts
import { Logger, DynamoDBTransport } from "logquill";
// npm install @aws-sdk/client-dynamodb

// Partition key is meta.runId (falling back to meta.traceId, then the
// logger name); sort key is `timestamp`. Batches are chunked to respect
// BatchWriteItem's 25-item cap.
const transport = new DynamoDBTransport({ tableName: "app-logs", region: "us-east-1" });
const logger = new Logger("app", { transports: [transport] });
logger.info("order placed", { runId: "run-42", orderId: "o_9" });
```

```ts
import { Logger, RedisTransport } from "logquill";
// npm install redis

// Writes to a Redis Stream via XADD — a fast local buffer/tail, not a
// durable system of record.
const transport = new RedisTransport({ url: "redis://localhost:6379", stream: "app:logs" });
const logger = new Logger("app", { transports: [transport] });
logger.info("cache miss", { key: "user:42" });
```

### Message queue transports

`KafkaTransport`, `RabbitMQTransport`, `SQSTransport`, and `PubSubTransport`
all extend `BaseQueueTransport`, which owns the "always batch, never
publish one message per log call" contract — each only implements
`publishBatch()` against its own driver's batch-publish API. Every
transport takes a `topic` option naming the destination (a Kafka topic, a
RabbitMQ queue, an SQS queue URL, or a Pub/Sub topic, respectively). Each
driver is an optional peer dependency — install only the one you use, or
inject a pre-built client.

```ts
import { Logger, KafkaTransport } from "logquill";
// npm install kafkajs

// Each message is keyed by meta.runId (falling back to meta.traceId), so
// kafkajs's default partitioner keeps one run/trace on the same partition.
const transport = new KafkaTransport({ topic: "app-logs", brokers: ["localhost:9092"] });
const logger = new Logger("app", { transports: [transport] });
logger.info("order placed", { runId: "run-42", orderId: "o-123" });
logger.close();
```

```ts
import { Logger, RabbitMQTransport } from "logquill";
// npm install amqplib

const transport = new RabbitMQTransport({ topic: "app-logs", url: "amqp://localhost" });
const logger = new Logger("app", { transports: [transport] });
logger.warn("low disk space", { host: "worker-3" });
```

```ts
import { Logger, SQSTransport } from "logquill";
// npm install @aws-sdk/client-sqs

// SendMessageBatch caps a request at 10 messages; larger flushes are
// automatically chunked.
const transport = new SQSTransport({
  topic: "https://sqs.us-east-1.amazonaws.com/123456789012/app-logs",
  region: "us-east-1",
});
const logger = new Logger("app", { transports: [transport] });
logger.error("payment failed", { orderId: "o-123" });
```

```ts
import { Logger, PubSubTransport } from "logquill";
// npm install @google-cloud/pubsub

const transport = new PubSubTransport({ topic: "app-logs", projectId: "my-gcp-project" });
const logger = new Logger("app", { transports: [transport] });
logger.info("job completed", { jobId: "j-9" });
```

### Cloud-native transports

`CloudWatchTransport`, `CloudLoggingTransport` (GCP), and
`AppInsightsTransport` (Azure) are SDK-based — each driver is an optional
peer dependency, or inject a pre-built client. `DatadogTransport`,
`ElasticsearchTransport`, and `NewRelicTransport` are plain `fetch`-based
and need no extra dependency at all; pass `sender` to swap in a fake for
tests or an alternate backend.

```ts
import { Logger, CloudWatchTransport } from "logquill";
// npm install @aws-sdk/client-cloudwatch-logs

const logger = new Logger("app", {
  transports: [new CloudWatchTransport({ logGroupName: "/my-app", logStreamName: "prod", region: "us-east-1" })],
});
logger.info("service started");
logger.close(); // flushes buffered log events
```

```ts
import { Logger, CloudLoggingTransport } from "logquill";
// npm install @google-cloud/logging

const logger = new Logger("app", {
  transports: [new CloudLoggingTransport({ projectId: "my-gcp-project", logName: "my-app" })],
});
logger.info("service started");
```

```ts
import { Logger, AppInsightsTransport } from "logquill";
// npm install applicationinsights

const logger = new Logger("app", {
  transports: [new AppInsightsTransport({ connectionString: process.env.APPINSIGHTS_CONNECTION_STRING })],
});
logger.info("service started");
```

```ts
import { Logger, DatadogTransport } from "logquill";

const logger = new Logger("app", {
  transports: [new DatadogTransport({ apiKey: process.env.DD_API_KEY!, site: "datadoghq.eu" })],
});
logger.info("service started");
```

```ts
import { Logger, ElasticsearchTransport } from "logquill";

const logger = new Logger("app", {
  transports: [
    new ElasticsearchTransport({ node: "https://localhost:9200", index: "app-logs", apiKey: process.env.ES_API_KEY }),
  ],
});
logger.info("service started");
```

```ts
import { Logger, NewRelicTransport } from "logquill";

// `region` selects the ingest host ("US" default, or "EU") — set it
// explicitly for EU accounts, since a mismatched region is rejected.
// Batches are gzip-compressed, and a 429 pauses further sends until the
// `Retry-After` window elapses.
const logger = new Logger("app", {
  transports: [new NewRelicTransport({ licenseKey: process.env.NEW_RELIC_LICENSE_KEY!, region: "EU" })],
});
logger.info("service started");
```

## Plugins

Plugins hook into the pipeline around each log call: `beforeLog(record)` can
transform a record or return `null` to drop it, `afterLog(record)` runs once
it's been dispatched to every transport, and `onError(error, record)` catches
anything a plugin's own hooks throw — a broken plugin can't take down logging.

```ts
import { ContextPlugin, Logger, RedactPlugin, SamplingPlugin } from "logquill";

const logger = new Logger("app");
logger.use(new ContextPlugin({ service: "api", env: "prod" })); // merged into every record's meta
logger.use(new RedactPlugin({ keys: ["password", "token"] })); // replaces matching meta values
logger.use(new SamplingPlugin(0.1)); // keep ~10% of records that reach this point

logger.info("login attempt", { user_id: 42, password: "hunter2" });
// meta: { service: "api", env: "prod", user_id: 42, password: "***" }
// (unless this call was one of the ~90% sampling dropped, in which case it's null)
```

Write your own by implementing `Plugin`; every hook is optional. `.use()`
also accepts a plain function in place of a `Plugin` — sugar for a
single-method `beforeLog` plugin, Express/Koa-style:

```ts
logger.use((record) => {
  delete record.meta.ssn;
  return record; // or null to drop the record
});
```

### Tail-based sampling

`SamplingPlugin` can do more than flat-rate sampling: pass `transports`
and it buffers a sampled-out record under its `meta.traceId` instead of
dropping it outright. If a later record on that same trace reaches
`elevateAt` (default `ERROR`), the whole trace is flushed — every buffered
record for it, plus everything from then on — so a request that turned out
to matter still produces a complete trace, even though most of its steps
would otherwise have been sampled away.

```ts
import { CollectingTransport, Logger, SamplingPlugin } from "logquill";

const sink = new CollectingTransport();
const logger = new Logger("app", {
  transports: [sink],
  plugins: [new SamplingPlugin(0.01, { transports: [sink] })], // keep 1%, but never lose an errored trace
});

logger.info("step 1", { traceId: "req-42" }); // likely dropped...
logger.info("step 2", { traceId: "req-42" }); // ...and this one too
logger.error("step 3 failed", { traceId: "req-42" }); // elevates req-42 — steps 1-3 all ship
```

### PII redaction

`PIIRedactPlugin` complements `RedactPlugin`'s exact-key matching with
regex-based scanning of `meta` **values** — emails, SSNs, credit-card
numbers, and phone numbers are redacted wherever they appear, recursively
through nested objects/arrays, regardless of which key holds them.

```ts
import { Logger, PIIRedactPlugin } from "logquill";

const logger = new Logger("app", { plugins: [new PIIRedactPlugin()] });
logger.info("support ticket", { notes: "contact me at jane@example.com" });
// meta.notes: "contact me at ***"
```

### Tamper-evident logs

`TamperEvidentPlugin` hash-chains every record — each one's `meta.hash` is
a SHA-256 digest over its own content plus the previous record's hash — so
editing, removing, or reordering a written line breaks the chain from that
point on, detectable later with the static `verifyChain()`. Opt-in: hashing
every record has a real CPU cost.

```ts
import { Logger, TamperEvidentPlugin } from "logquill";

const logger = new Logger("app", { plugins: [new TamperEvidentPlugin()] });
const records = [logger.info("one"), logger.info("two")];

TamperEvidentPlugin.verifyChain(records); // true
```

### Alerting

`AlertingPlugin` is the base for plugins that fire an external alert on
ERROR/FATAL (or any configurable `threshold`) without ever blocking the
log call that triggered it. Repeated matches within a dedupe window
collapse into a single follow-up alert reporting the total count, instead
of spamming the destination once per record.

```ts
import { Logger, SlackAlertPlugin } from "logquill";

const logger = new Logger("app", {
  plugins: [new SlackAlertPlugin("https://hooks.slack.com/services/...")],
});
logger.error("payment webhook failed", { orderId: "o-123" });
```

`PagerDutyAlertPlugin` (Events API v2, no extra dependency) and
`EmailAlertPlugin` (SMTP via the optional `nodemailer` peer dependency, or
inject a `sender`) follow the same shape. Write your own by extending
`AlertingPlugin` and implementing `sendAlert(record, occurrences)`.

## Development

```sh
npm install
npm run build      # dist/index.{mjs,cjs,d.ts} via tsup
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run coverage    # vitest run --coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, the
[Code of Conduct](CODE_OF_CONDUCT.md) for community standards, and
[SECURITY.md](.github/SECURITY.md) for how to report a vulnerability.

## License

MIT
