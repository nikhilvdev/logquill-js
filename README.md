# logquill

[![CI](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/logquill.svg)](https://www.npmjs.com/package/logquill)
[![npm downloads](https://img.shields.io/npm/dm/logquill.svg)](https://www.npmjs.com/package/logquill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

Status: pre-release, under active development. The core `Logger`, level
filtering, the plugin pipeline (with `ContextPlugin`/`RedactPlugin`/
`SamplingPlugin` built in), `JSONFormatter`, and the built-in transports are
implemented; non-blocking async dispatch is not yet — see `CHANGELOG.md`
for what's landed so far.

## Features

- **Structured by default** — every call carries a `meta` object, not just a message string
- **Cross-language record shape** — identical JSON shape and level names/weights as [`logquill` on PyPI](https://pypi.org/project/logquill/)
- **Pluggable formatters** — `JSONFormatter` out of the box; implement `format(record) -> string` for your own
- **Pluggable transports** — `ConsoleTransport` (colorized, respects `NO_COLOR`, isomorphic), `FileTransport` (rotation), `HTTPTransport` (batched, `fetch`-based); write your own by subclassing `Transport`; `CollectingTransport` ships as an in-memory sink, handy for tests
- **Plugin pipeline** — `ContextPlugin`, `RedactPlugin`, `SamplingPlugin` out of the box; `beforeLog`/`afterLog`/`onError` hooks; a throwing plugin can't crash logging
- **Child loggers** — `.child()` inherits level, transports, and plugins, and merges its own `meta` on top
- **Typed throughout** — TypeScript strict mode, no `any` in the public API
- **Dual package** — works via both `require()` (CJS) and `import` (ESM) from the same published package
- *(planned)* non-blocking async dispatch, `AsyncLocalStorage`-based context propagation — see `CHANGELOG.md`

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
(non-blocking dispatch isn't implemented yet):

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

Write your own by implementing `Plugin`; every hook is optional.

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
