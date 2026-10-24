# logquill

[![CI](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/logquill.svg)](https://www.npmjs.com/package/logquill)
[![npm downloads](https://img.shields.io/npm/dm/logquill.svg)](https://www.npmjs.com/package/logquill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

Status: **1.0** — the full core `Logger`, level filtering, non-blocking
async dispatch with configurable backpressure, a full plugin pipeline
(context/redaction/PII/tamper-evidence/sampling/rate-limiting/alerting),
`JSONFormatter`, a broad transport catalog — console/file/HTTP, SQL,
NoSQL, message queues, and cloud-native log platforms — agentic/harness
tracing (including `LangChainAdapter`/`LangGraphAdapter` and
`OtelSpanProcessor`), a separate `logquill/browser` build, and
`winston`/`pino` migration bridges are all shipped; see `CHANGELOG.md` for
the full history.

## Features

- **Structured by default** — every call carries a `meta` object, not just a message string
- **Cross-language record shape** — identical JSON shape and level names/weights as [`logquill` on PyPI](https://pypi.org/project/logquill/)
- **Pluggable formatters** — `JSONFormatter`, `TextFormatter` and `LogfmtFormatter` out of the box, plus `parse()`/`parseLogfmt()` to read logs back; implement `format(record) -> string` for your own
- **A transport for wherever your logs need to go** — console, file, and HTTP out of the box, plus SQL (SQLite/Postgres/MySQL), NoSQL (MongoDB/DynamoDB/Redis), message queues (Kafka/RabbitMQ/SQS/Pub-Sub), and cloud-native platforms (CloudWatch/Cloud Logging/App Insights/Datadog/Elasticsearch/New Relic) — see [Transports](#transports). Every backend driver is an **optional peer dependency**: install only the one you use, or inject a pre-built client. Write your own by subclassing `Transport`; `CollectingTransport` ships as an in-memory sink, handy for tests
- **Plugin pipeline** — `ContextPlugin`, `RedactPlugin`, `PIIRedactPlugin`, tail-based `SamplingPlugin`, `TamperEvidentPlugin`, and `AlertingPlugin` (`SlackAlertPlugin`/`PagerDutyAlertPlugin`/`EmailAlertPlugin`) out of the box; `beforeLog`/`afterLog`/`onError` hooks, or just pass a plain function to `.use()`; a throwing plugin can't crash logging — see [Plugins](#plugins)
- **Child loggers** — `.child()` inherits level, transports, and plugins, and merges its own `meta` on top
- **Typed throughout** — TypeScript strict mode, no `any` in the public API
- **Dual package** — works via both `require()` (CJS) and `import` (ESM) from the same published package
- **Tracing & agentic logging** — `.thought()/.action()/.observation()/.decision()`, `Logger.span()` for nested/duration_ms-stamped spans, `RunPlugin` (per-run id + step counter), and `TraceContextPlugin` (cross-service `trace_id`, OTel-aware) — see [Tracing & agentic logging](#tracing--agentic-logging)
- **LangChain.js / LangGraph.js adapter** — `LangChainAdapter`, a `BaseCallbackHandler` that maps chain/LLM/tool/agent events onto the calls above with zero manual instrumentation, from a separate `logquill/langchain` entry point — see [Agentic framework adapters](#agentic-framework-adapters)
- **OpenTelemetry-native integration** — `OtelSpanProcessor` bridges frameworks that emit OTel spans directly (e.g. the Vercel AI SDK) onto `.action()`/`.observation()`/`.error()`, with zero real dependency on `@opentelemetry/*` — see [OpenTelemetry-native integration](#opentelemetry-native-integration)
- **Non-blocking async dispatch** — a call returns before its write runs, via a bounded internal queue with a configurable backpressure policy (`dropOldest`/`dropNewest`/`block`); `logger.flush()`, `withLambda`/`withCloudFunction`/`withAzureFunction`, and `installShutdownHandlers` cover draining it before a process pauses or exits — see [Async dispatch & shutdown](#async-dispatch--shutdown)
- **Request-scoped context propagation** — `bindContext()`, `AsyncLocalStorage`-backed, so a value set once is visible in every nested log call underneath it without threading it through every signature by hand; `RateLimitPlugin` caps a noisy loop without silencing everything else — see [Context propagation & error capture](#context-propagation--error-capture)
- **Migration bridges** — `LogQuillWinstonTransport` (from `logquill/winston`) and `LogQuillPinoDestination` let an existing `winston`/`pino` app adopt LogQuill's transports/plugins with no call-site changes — see [Migration bridges](#migration-bridges)
- **Browser build** — a separate `logquill/browser` entry (`Logger`, `JSONFormatter`, the plugin pipeline, `ConsoleTransport`, `BeaconTransport`) with no Node built-ins in its module graph — see [Browser build](#browser-build)

## Contents

- [Install](#install)
- [Usage](#usage)
- [Transports](#transports)
  - [SQL transports](#sql-transports)
  - [NoSQL transports](#nosql-transports)
  - [Message queue transports](#message-queue-transports)
  - [Cloud-native transports](#cloud-native-transports)
- [Config from a file or the environment](#config-from-a-file-or-the-environment)
- [Content capture, LLM calls & runtime controls](#content-capture-llm-calls--runtime-controls)
  - [Content capture](#content-capture)
  - [LLM calls and tool retries](#llm-calls-and-tool-retries)
  - [Per-call options and silencing a library](#per-call-options-and-silencing-a-library)
  - [Changing the level without a restart](#changing-the-level-without-a-restart)
- [Plugins](#plugins)
  - [Tail-based sampling](#tail-based-sampling)
  - [PII redaction](#pii-redaction)
  - [Tamper-evident logs](#tamper-evident-logs)
  - [Alerting](#alerting)
  - [Rate limiting](#rate-limiting)
- [Tracing & agentic logging](#tracing--agentic-logging)
- [Agentic framework adapters](#agentic-framework-adapters)
  - [OpenTelemetry-native integration](#opentelemetry-native-integration)
- [Async dispatch & shutdown](#async-dispatch--shutdown)
  - [Kubernetes](#kubernetes)
- [Context propagation & error capture](#context-propagation--error-capture)
- [Migration bridges](#migration-bridges)
- [Browser build](#browser-build)
- [API reference](#api-reference)
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
`{"schema_version": "2.0", "timestamp": ISO8601, "level": string, "logger": string, "message": string, "meta": object}`
(plus an optional `llm` block on LLM-call records; named `meta` keys such as `run_id`, `span_id` and
`duration_ms` are snake_case on the wire, in both languages — see [`schema/README.md`](schema/README.md) and [MIGRATING.md](MIGRATING.md)),
the same shape shared with [`logquill` on PyPI](https://pypi.org/project/logquill/).
Use `JSONFormatter` to serialize a record to the canonical JSON line:

```ts
import { JSONFormatter } from "logquill";

console.log(new JSONFormatter().format(record));
// '{"schema_version":"2.0","timestamp":"2026-08-29T07:12:55.968Z","level":"INFO","logger":"app","message":"user signed up","meta":{"user_id":42,"plan":"pro"}}'
```

For eyes instead of machines, `TextFormatter` renders one readable entry and
`LogfmtFormatter` emits `key=value` pairs for Loki/Splunk/`grep`. Both never
throw on odd `meta` values, and match `logquill-python`'s output byte for byte:

```ts
import {
  ConsoleTransport,
  FileTransport,
  Logger,
  LogfmtFormatter,
  TextFormatter,
  parse,
  parseLogfmt,
  TEXT_LOG_PATTERN,
  TEXT_LOG_CASTS,
} from "logquill";

const text = new Logger("app.api", {
  transports: [
    new ConsoleTransport({ formatter: new TextFormatter(), colorize: false }),
    new FileTransport("app.log", { formatter: new TextFormatter() }),
  ],
});
text.info("user signed up", { userId: 42 });
// 2026-01-01T00:00:00.000Z INFO  app.api: user signed up {"userId":42}

const logfmt = new Logger("app.api", {
  transports: [new ConsoleTransport({ formatter: new LogfmtFormatter(), colorize: false })],
});
logfmt.info("user signed up", { userId: 42 });
// timestamp=2026-01-01T00:00:00.000Z level=INFO logger=app.api message="user signed up" userId=42

parseLogfmt('level=INFO message="user signed up"'); // { level: "INFO", message: "user signed up" }

// Stream structured fields back out of a log file, one object per matching line:
await text.flush();
for await (const entry of parse("app.log", TEXT_LOG_PATTERN, { cast: TEXT_LOG_CASTS })) {
  console.log(entry.level, entry.meta); // INFO { userId: 42 }
}
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

| Transport                | Backend                                          | Peer dependency                   | Setup                                            |
| ------------------------ | ------------------------------------------------ | --------------------------------- | ------------------------------------------------ |
| `ConsoleTransport`       | stdout/stderr via `console.*`                    | _(none)_                          | zero-setup, isomorphic                           |
| `BeaconTransport`        | browser log endpoint, via `navigator.sendBeacon` | _(none, isomorphic)_              | zero-setup — see [Browser build](#browser-build) |
| `FileTransport`          | local file, with rotation                        | _(none)_                          | zero-setup                                       |
| `HTTPTransport`          | any HTTP log endpoint                            | _(none, uses `fetch`)_            | zero-setup                                       |
| `SQLiteTransport`        | SQLite                                           | `better-sqlite3`                  | zero-setup (file or `:memory:`)                  |
| `PostgresTransport`      | PostgreSQL                                       | `pg`                              | needs a server                                   |
| `MySQLTransport`         | MySQL                                            | `mysql2`                          | needs a server                                   |
| `MongoDBTransport`       | MongoDB                                          | `mongodb`                         | needs a server                                   |
| `DynamoDBTransport`      | AWS DynamoDB                                     | `@aws-sdk/client-dynamodb`        | needs an AWS account                             |
| `RedisTransport`         | Redis Streams                                    | `redis`                           | needs a server                                   |
| `KafkaTransport`         | Kafka                                            | `kafkajs`                         | needs a broker                                   |
| `RabbitMQTransport`      | RabbitMQ                                         | `amqplib`                         | needs a broker                                   |
| `SQSTransport`           | AWS SQS                                          | `@aws-sdk/client-sqs`             | needs an AWS account                             |
| `PubSubTransport`        | GCP Pub/Sub                                      | `@google-cloud/pubsub`            | needs a GCP account                              |
| `CloudWatchTransport`    | AWS CloudWatch Logs                              | `@aws-sdk/client-cloudwatch-logs` | needs an AWS account                             |
| `CloudLoggingTransport`  | GCP Cloud Logging                                | `@google-cloud/logging`           | needs a GCP account                              |
| `AppInsightsTransport`   | Azure Application Insights                       | `applicationinsights`             | needs an Azure account                           |
| `DatadogTransport`       | Datadog Logs                                     | _(none, uses `fetch`)_            | needs a Datadog account                          |
| `ElasticsearchTransport` | Elasticsearch `_bulk` API                        | _(none, uses `fetch`)_            | needs a cluster                                  |
| `SyslogTransport`        | RFC 5424 syslog over UDP/TCP                     | _(none, uses `dgram`/`net`)_      | needs a syslog server                            |
| `NewRelicTransport`      | New Relic Log API                                | _(none, uses `fetch`)_            | needs a New Relic account                        |

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
exceeds `maxBytes`, keeping `backupCount` numbered backups (`.1`, `.2`, …);
`compression: "gz"` gzips each backup as it is rotated out (`.1.gz`, `.2.gz`, …).
`HTTPTransport` batches formatted lines and POSTs them as
newline-delimited JSON once `batchSize` is reached, or on `.close()`/
`.flush()`; pass `sender` to swap in a fake for tests or a different
backend.

A log file on disk is usually not encrypted at rest the way a cloud sink is.
Pass `encryptKey` to `FileTransport` to encrypt every line as a
[Fernet](https://github.com/fernet/spec/blob/master/Spec.md) token — the
same format `logquill-python`'s `encrypt_key` writes, so either package can
read the other's files:

```ts
import { FileTransport, Logger, fernetDecrypt, generateFernetKey } from "logquill";
import { readFileSync } from "node:fs";

const key = generateFernetKey(); // keep this somewhere other than the log file
const logger = new Logger("app", {
  transports: [new FileTransport("app.log", { encryptKey: key })],
});
logger.info("user signed up", { userId: 42 });
await logger.close();

for (const line of readFileSync("app.log", "utf8").trim().split("\n")) {
  console.log(fernetDecrypt(key, line)); // the JSON record
}
```

`fernetDecrypt` throws if the key is wrong or a line was edited.

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
`level`, `logger`, `message`, `meta`, plus `run_id`/`span_id`/`parent_span_id`/
`trace_id` for future trace correlation) and always batches inserts into one
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

const transport = new PostgresTransport({
  connectionString: process.env.DATABASE_URL,
  maxRecords: 100,
});
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

// Partition key is meta.run_id (falling back to meta.trace_id, then the
// logger name); sort key is `timestamp`. Batches are chunked to respect
// BatchWriteItem's 25-item cap.
const transport = new DynamoDBTransport({ tableName: "app-logs", region: "us-east-1" });
const logger = new Logger("app", { transports: [transport] });
logger.info("order placed", { run_id: "run-42", orderId: "o_9" });
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

// Each message is keyed by meta.run_id (falling back to meta.trace_id), so
// kafkajs's default partitioner keeps one run/trace on the same partition.
const transport = new KafkaTransport({ topic: "app-logs", brokers: ["localhost:9092"] });
const logger = new Logger("app", { transports: [transport] });
logger.info("order placed", { run_id: "run-42", orderId: "o-123" });
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
  transports: [
    new CloudWatchTransport({
      logGroupName: "/my-app",
      logStreamName: "prod",
      region: "us-east-1",
    }),
  ],
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
  transports: [
    new AppInsightsTransport({ connectionString: process.env.APPINSIGHTS_CONNECTION_STRING }),
  ],
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
    new ElasticsearchTransport({
      node: "https://localhost:9200",
      index: "app-logs",
      apiKey: process.env.ES_API_KEY,
    }),
  ],
});
logger.info("service started");
// Each document also carries Elastic Common Schema fields (`@timestamp`,
// `log.level`, `service.name`, `trace.id`, `span.id`, `error.*`), so Kibana's
// Discover and dashboards work with no field mapping.
```

```ts
import { Logger, SyslogTransport } from "logquill";

// One RFC 5424 message per record. UDP by default; `protocol: "tcp"` newline-frames.
// Delivery is fire-and-forget, so an unreachable server never blocks or throws.
const logger = new Logger("app", {
  transports: [new SyslogTransport({ host: "logs.internal", port: 514, protocol: "udp" })],
});
logger.warn("disk almost full");
```

```ts
import { Logger, NewRelicTransport } from "logquill";

// `region` selects the ingest host ("US" default, or "EU") — set it
// explicitly for EU accounts, since a mismatched region is rejected.
// Batches are gzip-compressed, and a 429 pauses further sends until the
// `Retry-After` window elapses.
const logger = new Logger("app", {
  transports: [
    new NewRelicTransport({ licenseKey: process.env.NEW_RELIC_LICENSE_KEY!, region: "EU" }),
  ],
});
logger.info("service started");
```

## Config from a file or the environment

`loggerFromFile` builds a `Logger` from a `.json`, `.yaml` or `.yml` file in the
same shape `logquill-python` reads, so one config can serve both stacks. YAML
needs the optional `yaml` package (`npm install yaml`).

```json
{
  "level": "INFO",
  "transports": [
    { "type": "console", "options": { "formatter": "text" } },
    { "type": "file", "options": { "path": "app.log", "max_bytes": 1000000 } }
  ],
  "plugins": [{ "type": "sampling", "options": { "rate": 0.1 } }],
  "max_queue_size": 10000,
  "backpressure": "drop_oldest"
}
```

```ts
import { loggerFromEnv, loggerFromFile } from "logquill";

// logquill.json is the JSON above, saved next to your entry point.
const logger = await loggerFromFile("logquill.json", "app");

// LOGQUILL_CONFIG_FILE points at such a file; LOGQUILL_LEVEL, if set, always wins.
const fromEnv = await loggerFromEnv();
```

Built-in transport types are `console`, `file`, `http` and `syslog`; plugin types
are `context`, `redact`, `sampling`, `trace_context`, `run`, `pii_redact` and
`tamper_evident`. Option names may be snake_case or camelCase. A transport's
`formatter` may be `"json"`, `"text"` or `"logfmt"`. Anything else is referenced
as `{ "class": "<module>#<ExportName>" }` and constructed with `options` as its
single argument (a `./relative` module is resolved against the config file) — that
imports code, so only load config you trust. Python's
`async_dispatch` and `flush_at_exit` keys are ignored: dispatch here is always
async, and shutdown flushing is opt-in via `installShutdownHandlers(logger)`.

## Content capture, LLM calls & runtime controls

### Content capture

Prompts, completions, tool arguments and results, and captured span state are
**content**: sometimes exactly what you want while debugging, sometimes exactly
what must never reach a log. `contentPolicy` decides, once per logger, before any
plugin or transport sees the record. It is **`"off"` by default**: a content
field is replaced with a placeholder, never silently dropped.

```ts
import { CollectingTransport, Logger } from "logquill";

const sink = new CollectingTransport();
const logger = new Logger("agent", { transports: [sink], contentPolicy: "hash" });
logger.action("call_model", {
  input_messages: [{ role: "user", content: "my password is hunter2" }],
});
await logger.flush();
console.log(sink.records[0]?.meta.input_messages); // sha256:... — same prompt, same hash; the text is gone
```

`"hash"` gives a stable `sha256:` digest (the same one `logquill-python` produces,
so two services can confirm they saw the same prompt), `"truncate"` keeps the
first 200 characters, `"full"` passes the value through. The governed keys are
`input_messages`, `output_messages`, `system_instructions`, `tool_arguments`,
`tool_result` and `state_diff` (`CONTENT_FIELDS`). This is a technical control that
supports privacy work, not a compliance guarantee.

### LLM calls and tool retries

```ts
import { Logger } from "logquill";

const logger = new Logger("agent");
logger.llmCall(
  {
    model: "gpt-4o",
    tokensIn: 812,
    tokensOut: 96,
    costUsd: 0.0031,
    latencyMs: 1240,
    finishReason: "stop",
  },
  { provider: "openai" },
);
// record.llm = { model, tokens_in, tokens_out, cost_usd, latency_ms, finish_reason }
```

The `llm` block is first-class on the record, so cost and latency dashboards can
rely on its names. A field of the wrong type is dropped with a warning rather than
thrown. A tool `.action()` that reopens a call which has not succeeded yet gets
`meta.retry_count` automatically (a successful `.observation()` ends the chain);
give calls a `tool_call_id` to tell concurrent calls to one tool apart.

`span()` can also snapshot state before and after the block:

```ts
import { Logger } from "logquill";

const logger = new Logger("agent", { contentPolicy: "full" }); // state_diff is a content field
const state = { step: 0 };
await logger.span(
  "plan",
  () => {
    state.step = 1;
  },
  { captureState: () => state },
);
// meta.state_diff = { before: { step: 0 }, after: { step: 1 } } (a content field: see contentPolicy)
```

### Per-call options and silencing a library

```ts
logger.opt({ lazy: true }).debug("state", { dump: () => expensiveDump() }); // runs only if DEBUG is on

// depth: 1 inside a wrapper reports the wrapper's caller, not the wrapper:
function audit(message: string) {
  logger.opt({ depth: 1 }).info(message); // meta.caller = { function, file, line, column }
}
audit("exported");

import { disable, enable } from "logquill";
disable("mylib"); // a library calls this at import to be silent by default
enable("mylib.http"); // the app opts one part back in; the most specific rule wins
```

### Changing the level without a restart

```ts
import { LevelFileWatcher, installSignalLevelHandler } from "logquill";

installSignalLevelHandler(logger); // kill -USR2 <pid> re-reads LOGQUILL_LEVEL
new LevelFileWatcher(logger, "/tmp/app.level").start(); // echo DEBUG > /tmp/app.level
```

`SIGUSR2` is used because Node reserves `SIGUSR1` for the inspector. Windows has no
`SIGUSR2`, so use `LevelFileWatcher` or `LevelEnvWatcher` there. A bad value is
ignored with a warning, and the watchers' timers never keep the process alive.

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
and it buffers a sampled-out record under its `meta.trace_id` instead of
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

logger.info("step 1", { trace_id: "req-42" }); // likely dropped...
logger.info("step 2", { trace_id: "req-42" }); // ...and this one too
logger.error("step 3 failed", { trace_id: "req-42" }); // elevates req-42 — steps 1-3 all ship
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

### Rate limiting

`RateLimitPlugin` drops records once a key — by default `(logger, level)`
— exceeds `maxRecords` within a rolling `perSeconds` window, so a noisy
loop (a retry logging the same error every iteration) can't drown out a
logger's other messages. Each key gets its own window, so unrelated keys
never reset in lockstep; pass `keyFunc` to key on something else, e.g. an
error message or a `meta` field identifying the caller.

```ts
import { Logger, RateLimitPlugin } from "logquill";

const logger = new Logger("app", { plugins: [new RateLimitPlugin(5, 60)] }); // at most 5 per key per minute

for (let i = 0; i < 10; i++) {
  logger.error("db connection failed"); // only the first 5 in any 60s window ship
}
```

## Tracing & agentic logging

`.thought()/.action()/.observation()/.decision()` are `.info()` with
`meta.kind` pre-set, for tagging steps of an agent's reasoning loop:

```ts
import { Logger } from "logquill";

const logger = new Logger("agent");
logger.thought("deciding which tool to call", { candidates: ["search", "calculator"] });
logger.action("calling search", { query: "current weather in nyc" });
logger.observation("search returned 3 results");
logger.decision("using search result #1");
```

`Logger.span()` wraps an operation, emitting one record on completion with
`meta.span_id`/`meta.duration_ms` — every record logged inside it, including
across an `await`, is automatically stamped with `meta.parent_span_id`, so a
full run's nesting can be reconstructed by sorting on `span_id`/`parent_span_id`.
It still emits (at `ERROR`, with `meta.error`) and rethrows if the block
throws:

```ts
import { Logger } from "logquill";

async function callLlm(prompt: string): Promise<string> {
  return `response to: ${prompt}`;
}

const logger = new Logger("agent");

const answer = await logger.span(
  "callLlm",
  async () => {
    logger.action("requesting completion", { model: "gpt-4" });
    const response = await callLlm("current weather in nyc");
    logger.observation("received completion");
    return response;
  },
  { model: "gpt-4" },
);
```

`RunPlugin` stamps `meta.run_id` (generated, or given explicitly) plus an
incrementing `meta.step` — attach a fresh instance per run so concurrent
runs don't share a counter:

```ts
import { Logger, RunPlugin } from "logquill";

const runLogger = new Logger("app").child("agent").use(new RunPlugin());
runLogger.thought("step one"); // meta: { kind: "thought", run_id: "...", step: 0 }
runLogger.action("step two"); // meta: { kind: "action", run_id: "...", step: 1 }
```

`TraceContextPlugin` stamps `meta.trace_id`, for correlating one request
across services — distinct from `run_id`, which scopes one agent run. It
resolves, in priority order: an active OpenTelemetry span (if
`@opentelemetry/api` is installed — never a required dependency), an
inbound `traceparent`/X-Ray/GCP trace header, or a freshly generated id:

```ts
import { Logger, setTraceparent, TraceContextPlugin } from "logquill";

const logger = new Logger("app", { plugins: [new TraceContextPlugin()] });

// in HTTP middleware, before the handler runs:
const reset = setTraceparent(req.headers["traceparent"]);
try {
  logger.info("handling request"); // meta.trace_id resolved from the inbound header
} finally {
  reset();
}
```

## Agentic framework adapters

`LangChainAdapter` implements LangChain.js's `BaseCallbackHandler`, mapping
chain/LLM/tool/agent events onto `.action()/.observation()/.decision()` and
`span()`-shaped records — pass it into `callbacks: [...]` and a chain's
full call tree is captured with zero manual instrumentation:

```ts
import { RunnableLambda } from "@langchain/core/runnables";
import { Logger, RunPlugin } from "logquill";
import { LangChainAdapter } from "logquill/langchain";

const logger = new Logger("agent").use(new RunPlugin());
const handler = new LangChainAdapter(logger);

const answerQuestion = RunnableLambda.from((question: string) => `answer: ${question}`);
await answerQuestion.invoke("what is 2+2?", { callbacks: [handler] });
// logs one record: { message: "RunnableLambda", meta: { kind: "span", span_id: "...", duration_ms: ... } }
```

`LangGraphAdapter` is the same handler under its own name, for LangGraph.js
graphs — its nodes run as ordinary LangChain `Runnable`s, so no extra
mapping is needed; pass it the same way:

```ts
import { LangGraphAdapter } from "logquill/langchain";

const handler = new LangGraphAdapter(logger);
// const graph = builder.compile({ checkpointer });
// await graph.invoke(input, { callbacks: [handler], configurable: { thread_id: "1" } });
```

This is a **separate entry point** — `import ... from "logquill/langchain"`,
not the main `"logquill"` import — because `LangChainAdapter` has to
`extends BaseCallbackHandler`, LangChain's own class. Importing plain
`logquill` never touches `@langchain/core`; only importing
`logquill/langchain` does. Install `@langchain/core` yourself (it's an
optional peer dependency) — no separate `@langchain/langgraph` dependency
is needed for `LangGraphAdapter`.

### OpenTelemetry-native integration

Some frameworks aren't callback-handler-based — the Vercel AI SDK's
`experimental_telemetry` is the main JS example, emitting OpenTelemetry
spans directly instead of calling into a handler object like
`BaseCallbackHandler`. `OtelSpanProcessor` covers that case: register it on
any OTel tracer provider, and every span becomes one `.action()` call on
start plus one `.observation()` (or `.error()`, on an error status) call on
end, carrying the span's own `span_id`/`parent_span_id` — OTel span ids are
already the same 16-hex-char shape LogQuill's own ids use — plus
`meta.duration_ms` on the end record:

```ts
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Logger, OtelSpanProcessor } from "logquill";

const logger = new Logger("agent");
const provider = new BasicTracerProvider({
  spanProcessors: [new OtelSpanProcessor(logger)],
});
const tracer = provider.getTracer("my-app");

const span = tracer.startSpan("callLlm");
span.end();
// logs two records: one .action() on start, one .observation() on end
// (or .error() if span.setStatus({ code: SpanStatusCode.ERROR }) was called)
```

Unlike `LangChainAdapter`, this is exported from the **main** `"logquill"`
entry point, not a separate subpath — it's fully duck-typed against the
`Span`/`ReadableSpan` shape, the same approach `TraceContextPlugin` uses
for its own OTel lookup, so it never imports `@opentelemetry/api` or
`@opentelemetry/sdk-trace-base` for real. Non-empty span attributes are
copied onto `meta.attributes` (configurable via `attributesKey`) verbatim;
mapping onto the OTel `gen_ai.*` semantic conventions is left to the
planned `OTLPTransport` (v2.0).

## Async dispatch & shutdown

Every `Logger` call returns before the write it triggers actually runs —
the write (and any plugin `afterLog` hooks) is handed to an internal,
bounded dispatch queue, drained outside the caller's own call stack:

```ts
import { CollectingTransport, Logger } from "logquill";

const transport = new CollectingTransport();
const logger = new Logger("app", { transports: [transport] });

logger.info("hello");
console.log(transport.records.length); // 0 — still queued
await logger.flush();
console.log(transport.records.length); // 1 — now written
```

The queue has a configurable size and backpressure policy, so a sustained
burst can't grow memory without bound:

```ts
const logger = new Logger("app", {
  transports: [transport],
  queue: {
    maxSize: 10_000, // default
    policy: "dropOldest", // "dropOldest" (default) | "dropNewest" | "block"
  },
});
```

- `"dropOldest"` — once the queue is full, the longest-waiting record is
  discarded to make room for the new one.
- `"dropNewest"` — the incoming record is discarded; everything already
  queued is left alone.
- `"block"` — nothing is ever dropped: once the queue is full, a call runs
  its write immediately, on the caller's own stack, instead of queueing it.

Any dropped-record policy calls `onDrop(count, policy)` — rate-limited to
once per `warnIntervalMs` (default 5000) — so sustained overload is
visible without flooding your own logs with one warning per drop.

`logger.flush()` waits for every record dispatched so far to reach its
transports. Note it does _not_ force a batching transport (SQL, a queue,
`HTTPTransport`, ...) to send a batch still under its own threshold early
— for that, use `withLambda`/`withCloudFunction`/`withAzureFunction`
(same wrapper, three platform-matching names) around a serverless handler,
which additionally forces every batching transport's buffer out before
the wrapped function's result settles — important because a frozen or
recycled execution environment may never come back to finish a partial
batch on its own:

```ts
import { withLambda } from "logquill";

export const handler = withLambda(logger, async (event) => {
  logger.info("handling request", { requestId: event.requestId });
  return { statusCode: 200 };
});
```

For a long-running process, `installShutdownHandlers` flushes and closes a
logger once on `SIGTERM`/`SIGINT`/`beforeExit`, so nothing queued is lost
when the process stops:

```ts
import { installShutdownHandlers } from "logquill";

installShutdownHandlers(logger); // Node only
```

### Kubernetes

Default to `ConsoleTransport`, not `FileTransport`, for anything running in
a container. A container's filesystem is ephemeral and invisible to the
rest of the cluster — a log file written inside it disappears the moment
the pod is rescheduled, and nothing aggregates it in the meantime unless
you also run a sidecar to tail it back out. Writing to stdout/stderr
instead costs nothing extra: every major container runtime already
captures both streams, and the node-level log agent your cluster runs
(Fluentd, Fluent Bit, Vector, or your cloud provider's own) ships them to
your aggregator without any code on your side that needs to know that
agent exists:

```ts
import { ConsoleTransport, Logger } from "logquill";

const logger = new Logger("app", { transports: [new ConsoleTransport()] });
```

Kubernetes sends `SIGTERM` and then kills the process after
`terminationGracePeriodSeconds` (30s by default) regardless of whether
it's finished shutting down, so a record still sitting in the dispatch
queue at that instant can be lost if nothing catches the signal.
`installShutdownHandlers(logger)` closes that gap the same way
`withLambda` closes it for a serverless freeze — call it once, on process
start, so a pod that's told to stop still flushes and closes the logger
before Kubernetes kills it.

## Context propagation & error capture

`bindContext()` merges values into a request-scoped context, backed by
`AsyncLocalStorage`: every `Logger` call underneath it — through any
number of function calls and `await`s deep — picks them up in `meta`
automatically, without threading them through every signature by hand.
Concurrent async operations sharing one `Logger` never see each other's
bound context.

```ts
import { bindContext, Logger } from "logquill";

const logger = new Logger("app");

await bindContext({ requestId: "abc123" }, async () => {
  await handleRequest(); // any logging in here, or in what it calls,
  // gets meta.requestId = "abc123" for free
});

function handleRequest() {
  logger.info("handled"); // meta: { requestId: "abc123" }
}
```

Nested `bindContext()` calls merge, with the inner value winning on key
collision — the same way an explicit call-site `meta` value always wins
over anything bound this way.

Pass an `Error` as `meta.err` and it's replaced with a formatted
`meta.stack`, the same shape `Logger.span()` already produces internally
for a thrown error:

```ts
try {
  await riskyOperation();
} catch (err) {
  logger.error("operation failed", { err, orderId: "o-123" });
  // meta: { orderId: "o-123", stack: "Error: ...\n    at ..." } — no meta.err
}
```

## Migration bridges

For an app already using `winston` or `pino`, LogQuill can sit alongside
either with no call-site changes, so a migration can happen transport by
transport instead of all at once.

`LogQuillWinstonTransport` (from the separate `logquill/winston` entry
point, since it has to extend `winston-transport`'s own class) plugs a
LogQuill `Logger` into an existing `winston.createLogger()` as one more
transport:

```ts
import winston from "winston";
import { Logger } from "logquill";
import { LogQuillWinstonTransport } from "logquill/winston";

const logquill = new Logger("app");
const winstonLogger = winston.createLogger({
  transports: [new LogQuillWinstonTransport(logquill)],
});

winstonLogger.info("still works exactly as before", { userId: 42 });
```

`LogQuillPinoDestination` is a pino `destination` — pass it straight into
`pino()` and pino's own NDJSON output is parsed back into LogQuill calls.
It needs no dependency on `pino` itself (a destination only has to be
duck-type compatible with a Node `Writable`), so it ships from the main
entry point:

```ts
import pino from "pino";
import { Logger, LogQuillPinoDestination } from "logquill";

const logquill = new Logger("app");
const log = pino(new LogQuillPinoDestination(logquill));

log.info({ userId: 42 }, "still works exactly as before");
```

Both re-filter by the LogQuill `Logger`'s own `level` after the
source library's own filtering runs — the stricter of the two wins — and
map that library's levels onto LogQuill's via a `levelMap` option,
overridable for a non-default level configuration.

## Browser build

`import ... from "logquill/browser"` is a separate entry point shipping
the same `Logger`, levels, `JSONFormatter`, and plugin pipeline
(`ContextPlugin`/`RedactPlugin`/`PIIRedactPlugin`/`SamplingPlugin`), plus
`ConsoleTransport` and `BeaconTransport`. `FileTransport`, `HTTPTransport`,
every SQL/NoSQL/queue/cloud-native transport, and the LangChain adapters
are absent from this entry's module graph entirely — not tree-shaken,
simply never imported — so this bundle never pulls in a Node built-in.

```ts
import { BeaconTransport, ConsoleTransport, Logger } from "logquill/browser";

const logger = new Logger("app", {
  transports: [
    new ConsoleTransport(),
    new BeaconTransport("https://logs.example.com/ingest", { batchSize: 20 }),
  ],
});

logger.info("page loaded", { path: location.pathname });
window.addEventListener("pagehide", () => logger.close()); // flushes the pending beacon batch
```

`BeaconTransport` batches formatted records and sends them via
`navigator.sendBeacon`, which — unlike `fetch` — can complete even after
the page that queued it starts unloading; it falls back to a `keepalive`
`fetch` where `sendBeacon` isn't available (a worker, an older browser).
Keep `batchSize` small — `sendBeacon` payloads are capped (64KB in most
browsers).

One behavioral difference from the Node build: `Logger.span()`'s
`parent_span_id` nesting is backed by a plain stack here instead of
`AsyncLocalStorage` (which browsers don't have), so two spans on the same
`Logger` running concurrently across an `await` can interleave and stamp
the wrong `parent_span_id` — fine for the common case of one span in flight
at a time.

## API reference

Every exported class and function carries a TSDoc comment; the full
reference, generated from those comments with
[TypeDoc](https://typedoc.org), is published at
[nikhilvdev.github.io/logquill-js](https://nikhilvdev.github.io/logquill-js/)
and rebuilt on every push to `main`. To build it locally:

```sh
npm run docs   # writes static HTML to site/
```

## Development

```sh
npm install
npm run build      # dist/index.{mjs,cjs,d.ts} via tsup
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run coverage    # vitest run --coverage
npm run docs        # typedoc -> site/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow, the
[Code of Conduct](CODE_OF_CONDUCT.md) for community standards, and
[SECURITY.md](.github/SECURITY.md) for how to report a vulnerability.

## License

MIT
