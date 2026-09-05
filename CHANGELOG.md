# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

Browser build:

- A separate `logquill/browser` entry point (`import ... from "logquill/browser"`)
  — the same `Logger`, levels, `JSONFormatter`, and plugin pipeline
  (`ContextPlugin`/`RedactPlugin`/`PIIRedactPlugin`/`SamplingPlugin`), plus
  `ConsoleTransport` and a new `BeaconTransport`. `FileTransport`,
  `HTTPTransport`, every SQL/NoSQL/queue/cloud-native transport, and the
  LangChain adapters are absent from this entry's module graph entirely —
  not just tree-shaken — so it never pulls in a Node built-in.
- `BeaconTransport` — batches formatted records and sends them via
  `navigator.sendBeacon`, falling back to a `keepalive` `fetch` where
  `sendBeacon` isn't available (a worker, an older browser, or Node);
  pass `sender` to swap in a fake for tests. Also exported from the main
  `"logquill"` entry.
- One behavioral difference from the Node build: `Logger.span()`'s
  `parentSpanId` nesting is backed by a plain stack in the browser build
  instead of `AsyncLocalStorage` (which browsers don't have), so unlike the
  Node build, two spans on the same `Logger` running concurrently across an
  `await` can interleave and stamp the wrong `parentSpanId`. Fine for the
  common case of one span in flight at a time; documented as a known
  limitation rather than fixed, since there's no browser-standard
  equivalent of `AsyncLocalStorage` to fall back on.

Async dispatch, shutdown & serverless safety:

- Non-blocking dispatch — `Logger` calls now hand their write (and any
  plugin `afterLog` hooks) to an internal `DispatchQueue` and return before
  either runs, draining outside the caller's own call stack (`setImmediate`,
  falling back to a microtask where it isn't available). The queue has a
  configurable `maxSize` (default 10,000) and backpressure policy —
  `dropOldest` (default), `dropNewest`, or `block`, the last running the
  overflowing write inline instead of dropping it — set per `Logger` via
  the new `queue` option. Dropped-record warnings are rate-limited via a
  configurable `onDrop` callback rather than one `console.warn` per drop.
- `Logger.flush()` now returns a `Promise` and actually waits for every
  dispatched record to reach its transports, instead of being synchronous
  and immediate; `Logger.close()` is now async too, awaiting a flush before
  closing transports so a pending write can't be lost to a closed file
  descriptor or connection. `Logger.queueSize` exposes the current pending
  count.
- `withLambda`/`withCloudFunction`/`withAzureFunction` (the same wrapper
  under three platform-matching names) — wraps a serverless handler so
  `logger.flush()` and every batching transport's own `flush()` are awaited
  before the wrapped function's result settles, since a frozen or recycled
  execution environment may never come back to finish a partial batch.
- `installShutdownHandlers(logger)` — flushes and closes a logger once on
  `SIGTERM`/`SIGINT`/`beforeExit`, so nothing queued is lost when a
  long-running process stops. Node-only; returns an unsubscribe function.

This is a breaking change for direct callers of `Logger.close()`, which is
now `async`.

## [0.4.0] - 2026-09-02

### Added

Trace correlation & agentic tracing:

- `.thought()/.action()/.observation()/.decision()` on `Logger` — `.info()`
  with `meta.kind` pre-set for tagging agent reasoning steps; a call-site
  `kind` in the passed `meta` overrides the default.
- `Logger.span(name, fn, options?)` — `await logger.span("callLlm", async () => {...})`
  runs `fn` and, on settling (success or throw), emits one record for the
  span itself carrying `meta.spanId` and `meta.durationMs`. Every record
  logged inside `fn` — through any method, and across any `await` — is
  automatically stamped with `meta.parentSpanId` pointing at this span, via
  a new `AsyncLocalStorage`-backed span context (`src/core/span.ts`), so
  nested/concurrent spans reconstruct their exact nesting by sorting on
  `spanId`/`parentSpanId` without leaking across concurrent calls sharing
  one `Logger`. Still emits its record — at `ERROR`, with `meta.error` set
  — if `fn` throws; the error itself propagates unchanged. `spanId`/
  `parentSpanId` normally auto-generate/auto-nest, but can be passed
  explicitly in `options` to adopt an id handed in from elsewhere (e.g. a
  future framework adapter).
- `RunPlugin` — stamps `meta.runId` (generated if not given) and an
  incrementing `meta.step`; one instance scopes one run, so concurrent runs
  never share a counter. A record that already carries `meta.runId`
  (propagated from upstream) keeps it.
- `TraceContextPlugin` — stamps `meta.traceId` for cross-service
  correlation, distinct from `runId`. Resolves, in order: an active
  OpenTelemetry span's trace id (via a synchronous, lazy
  `require("@opentelemetry/api")` — never a declared dependency, and
  injectable via `resolveActiveOtelTraceId` for tests or non-Node OTel
  surfaces), the `traceparent` constructor option, whatever
  `setTraceparent()` most recently set for the current execution context
  (`AsyncLocalStorage`-backed, matching Python's `contextvars`-based
  propagation), or a freshly generated id. Understands W3C `traceparent`,
  AWS X-Ray `X-Amzn-Trace-Id`, and GCP `X-Cloud-Trace-Context` headers via
  the exported `parseTraceHeader()`.
- `LangChainAdapter` and `LangGraphAdapter` — implement LangChain.js's
  `BaseCallbackHandler`, mapping `handleChainStart`/`handleChainEnd` to one
  `span()`-shaped record, `handleLLMStart`/`handleLLMEnd` to
  `.action()`/`.observation()` with `durationMs`, `handleAgentAction` to
  `.action()`, `handleAgentEnd` to `.decision()`, and
  `handleToolStart`/`handleToolEnd`/`handleToolError` to the matching
  calls — LangChain's own `runId`/`parentRunId` written directly onto
  `meta.spanId`/`meta.parentSpanId` on every event, field renaming rather
  than translation. `LangGraphAdapter` is `LangChainAdapter` re-exported
  under its own name: LangGraph.js nodes run as ordinary LangChain
  `Runnable`s, so the same handler already covers them, and — unlike
  `logquill-python`'s `LangGraphAdapter` — there's no separate
  checkpoint-callback surface to add: `@langchain/langgraph` (checked
  against 1.4.13) exposes no `GraphCallbackHandler`/`onInterrupt`/
  `onResume` equivalent to LangGraph Python's; `interrupt()` instead
  surfaces through the graph's state/stream output, not the
  callback-handler system.

  Ships as a **separate entry point**, `import { LangChainAdapter } from
  "logquill/langchain"` (new `dist/langchain.{mjs,cjs,d.ts}` build target,
  `@langchain/core` as an optional peer dependency) — not from the main
  `"logquill"` import. This is a deliberate deviation from this repo's
  original plan of a fully separate `logquill-langchain` npm package: it
  stays in this repo instead, but is still isolated to its own module
  graph, for a real technical reason, not just organization —
  `LangChainAdapter` has to `extends BaseCallbackHandler`, a hard static
  import, and mixing that into the main barrel would mean every plain
  `import { Logger } from "logquill"` needed `@langchain/core` installed
  to resolve, even for consumers who never touch LangChain. Verified: the
  main entry point's build output has zero references to `@langchain/core`.

### Fixed

- `Logger`'s per-transport dispatch had no error handling: a transport that
  failed to format or write a given record (e.g. a circular reference in
  `meta`) propagated straight to the caller. Now caught and reported via
  `console.error`, per transport, matching every other internal-failure
  path in this codebase (`BatchingTransport`, `HTTPTransport`,
  `NewRelicTransport`) — one broken transport can no longer crash the
  caller or stop other attached transports from receiving the record.
- `LangChainAdapter`'s `handleChainError`/`handleLLMError`/`handleToolError`
  assumed a real `Error` instance and read `.name`/`.message` off it
  directly. LangChain's own type declarations type this parameter as
  `Error`, but nothing enforces that where it actually originates — a
  tool's `_call`, an LLM provider, or any chain step can `throw` a bare
  string or plain object just as validly, and LangChain forwards whatever
  was thrown unchanged. A non-`Error` throw silently corrupted the logged
  `meta.error` (`"undefined: undefined"`); `throw null`/`throw undefined`
  crashed the handler itself — the exact input this code path exists to
  report. Now guarded with an `instanceof Error` check, matching
  `Logger.span()`'s equivalent `formatSpanError` in `core/logger.ts`.

## [0.3.0] - 2026-08-31

### Added

- `.use()` now accepts a plain `beforeLog`-style function in place of a
  `Plugin`, wrapped internally as `FunctionPlugin` — Express/Koa-style
  middleware ergonomics, matching `logquill-python`'s equivalent.
- `SamplingPlugin` gained tail-based elevation: pass `transports` and a
  sampled-out record is buffered under its `meta.traceId` instead of
  dropped; if a later record on that trace reaches `elevateAt` (default
  `ERROR`), the whole trace flushes, buffered records included. Buffering
  is bounded by both `maxBufferedRecords` and `maxTraces`. Without
  `transports`, behavior is unchanged (plain rate-based sampling).
- `PIIRedactPlugin`: regex-based PII redaction over `meta` values (not
  just keys) — emails, SSNs, credit-card numbers, and phone numbers,
  recursively through nested objects/arrays, with depth- and
  cycle-bounded recursion. Complements `RedactPlugin`'s exact-key
  matching. Pass custom `patterns` to extend or replace the defaults.
- `TamperEvidentPlugin`: hash-chains every record (`meta.hash`/
  `meta.prevHash`, SHA-256) so an edited, removed, or reordered line in a
  written log is detectable after the fact via the static
  `verifyChain()`. Opt-in — hashing has a real per-record CPU cost.
- `AlertingPlugin`: base for plugins that fire an external alert on
  ERROR/FATAL (or any configurable `threshold`) without blocking the log
  call that triggered it, with dedupe-window collapsing of repeated
  matches into one follow-up alert reporting the total occurrence count.
  Tracking is bounded by `maxTrackedKeys`.
- `SlackAlertPlugin` and `PagerDutyAlertPlugin`: `fetch`-based, no extra
  dependency.
- `EmailAlertPlugin`: SMTP via the optional `nodemailer` peer dependency,
  or inject a `sender` for tests or an alternate backend.

## [0.2.0] - 2026-08-30

### Added

Database, queue, and cloud-native transports — a full matrix of new
sinks, each with a runnable example in `README.md`. Every real driver
(`pg`, `mysql2`, `better-sqlite3`, `mongodb`, `@aws-sdk/*`, `redis`,
`kafkajs`, `amqplib`, `@google-cloud/*`, `applicationinsights`) is an
**optional peer dependency** — install only the one you use, or inject a
pre-built client for tests or alternate setups.

**SQL** — `BatchingTransport`, a shared base for every batching sink
transport that bounds its buffer by both record count and estimated byte
size, flushing once either limit is hit — never grows unboundedly under a
sustained burst. `BaseSQLTransport` builds on it with a fixed `logs` table
schema (`timestamp`/`level`/`logger`/`message`/`meta`, plus
`runId`/`spanId`/`parentSpanId`/`traceId` for upcoming trace correlation
work) and always-batched inserts.

- `SQLiteTransport`: zero-setup SQL sink via the optional `better-sqlite3`
  peer dependency — no server process, works against a file or `:memory:`.
- `PostgresTransport`: batches formatted records into one parameterized
  multi-row `INSERT` per flush via the optional `pg` peer dependency, with
  dialect-correct `SERIAL`/`JSONB` schema for `ensureSchema: true` dev/test
  use.
- `MySQLTransport`: batches formatted records into one parameterized
  multi-row `INSERT` per flush via the optional `mysql2` peer dependency,
  with dialect-correct `AUTO_INCREMENT`/`JSON` schema for `ensureSchema:
  true` dev/test use.
- Production schema/migrations remain the caller's responsibility, per
  LogQuill's existing stance on auto-created schema.

**NoSQL**

- `MongoDBTransport` batches log records into `insertMany()` calls against
  a MongoDB collection, mapping each record 1:1 to a document; `mongodb`
  is an optional peer dependency, or inject a pre-built `collection`.
- `DynamoDBTransport` writes batches to DynamoDB via `BatchWriteItem`-style
  calls chunked to the API's 25-item cap, partitioning by `meta.runId`/
  `meta.traceId` (falling back to the logger name) with `timestamp` as the
  sort key; `@aws-sdk/client-dynamodb` is an optional peer dependency, or
  inject a `client`.
- `RedisTransport` appends each record to a Redis Stream via `XADD` — a
  fast local buffer/tail, not a durable store; `redis` is an optional peer
  dependency, or inject an already-connected `client`.

**Message queues** — `BaseQueueTransport`, a shared base for every queue
sink, enforcing "always batch, never publish one message per log call."

- `KafkaTransport` publishes batches to Kafka via `kafkajs`, keyed by
  `runId`/`traceId` for per-trace partition ordering.
- `RabbitMQTransport` publishes to RabbitMQ via `amqplib`.
- `SQSTransport` publishes to SQS via batched `SendMessageBatch` calls,
  correctly capped at 10 messages per request.
- `PubSubTransport` publishes to GCP Pub/Sub via `@google-cloud/pubsub`.

**Cloud-native**

- `CloudWatchTransport` ships batched records to AWS CloudWatch Logs via
  the AWS SDK v3 (`@aws-sdk/client-cloudwatch-logs`, optional peer
  dependency), sorting events by timestamp before each `PutLogEvents` call.
- `CloudLoggingTransport` ships batched records to Google Cloud Logging via
  `@google-cloud/logging` (optional peer dependency), mapping `level` onto
  Cloud Logging's `severity` scale.
- `AppInsightsTransport` ships records to Azure Application Insights as
  trace telemetry via `applicationinsights` (optional peer dependency),
  batching at LogQuill's buffering level and looping single `trackTrace()`
  calls per flush, since the SDK has no network-level batch API.
- `DatadogTransport` batches records and POSTs them as JSON to Datadog's
  Logs intake API via `fetch`, with a configurable `site` region
  (`datadoghq.com`/`datadoghq.eu`/etc) — no new dependency.
- `ElasticsearchTransport` batches records and POSTs them to
  Elasticsearch's `_bulk` API as newline-delimited action+source pairs via
  `fetch` — no client dependency.
- `NewRelicTransport` batches and gzips records before POSTing to New
  Relic's Log API, with a configurable US/EU region, the license key in
  `Api-Key`, `meta.eventType` stripped per New Relic's reserved-field rule,
  and 429 handling that reads `Retry-After` (seconds or HTTP-date) and
  pauses further sends until it elapses instead of retrying into a live
  rate limit.

## [0.1.2] - 2026-08-29

### Added

- Plugins: `ContextPlugin` (merges fixed key/value pairs into every record's
  `meta`; call-site `meta` wins on key collisions), `RedactPlugin` (replaces
  sensitive `meta` values, matched by key case-insensitively, with a
  placeholder — defaults to `password`/`token`/`secret`/`api_key`/
  `authorization`), and `SamplingPlugin` (keeps roughly `rate` of records,
  dropping the rest; `rate` outside `[0, 1]` throws). All three implement
  the `Plugin` hook interface and are usable via `.use()`. Matches
  `logquill-python`'s behavior test-for-test.

- Transports: `ConsoleTransport` (colorized via ANSI, respects `NO_COLOR`,
  writes via `console.log`/`console.error` so it works unmodified in a
  browser bundle), `FileTransport` (appends to a file, rotating to numbered
  backups `.1`, `.2`, … once it exceeds `maxBytes`), and `HTTPTransport`
  (batches formatted lines and POSTs them as newline-delimited JSON via
  `fetch` once `batchSize` is reached or on `.close()`/`.flush()`, with an
  injectable `sender` for tests or alternate backends). Each extends the
  `Transport` base class added in the previous entry. Unit tests per
  transport use `CollectingTransport` and fakes, matching `logquill-python`'s
  behavior (rotation scheme, batching, color routing) test-for-test.

- Core API: `Logger` (`.trace()/.debug()/.info()/.warn()/.error()/.fatal()`,
  `.child()`, `.use()`, `.setLevel()`), `Level`/`parseLevel`/`levelName`,
  `LogRecord`, `Formatter`/`JSONFormatter`, the `Plugin` hook interface
  (`beforeLog`/`afterLog`/`onError`), and the `Transport` base class with an
  in-memory `CollectingTransport` for tests. Record shape and level
  names/weights match the `logquill-python` contract byte-for-byte, verified
  by a schema cross-check test against a Python-produced sample record.

- Added `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `.github/CODEOWNERS`,
  `.github/PULL_REQUEST_TEMPLATE.md`, and `CONTRIBUTING.md` documenting the
  PR workflow (branch naming, scoping, review/CI requirements, squash-merge),
  synced with `logquill-python`.

- Added `.github/SECURITY.md`: supported-versions policy and instructions
  to report vulnerabilities via GitHub's private vulnerability reporting
  instead of public issues. Linked from the README.

- Added `.github/dependabot.yml`: weekly version updates for `npm`
  dependencies and GitHub Actions.

- Added GitHub issue templates: `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `feature_request.yml`, and a `config.yml` that points security reports at
  private vulnerability reporting instead of a public issue.

## [0.1.1] - 2026-08-27

### Changed

- `release.yml` now triggers on every push to `main` (i.e. on PR merge)
  instead of on `v*` tags, publishing only when `package.json`'s `version`
  differs from what's live on npm.

## [0.1.0] - 2026-08-27

### Added

- MIT `LICENSE` file, README badges (CI, npm version, license), expanded
  `package.json` keywords/author, and GitHub repo description/topics for
  discoverability.

- Repo scaffolding: TypeScript (strict mode), `tsup` dual ESM+CJS+`.d.ts`
  build, `eslint` (flat config, type-checked, `no-explicit-any`) + `prettier`,
  `vitest` with coverage, and a CI workflow (`lint` → `typecheck` → `coverage` → `build`).
