# logquill

[![CI](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/logquill.svg)](https://www.npmjs.com/package/logquill)
[![npm downloads](https://img.shields.io/npm/dm/logquill.svg)](https://www.npmjs.com/package/logquill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

Status: pre-release, under active development. The core `Logger`, level
filtering, the plugin pipeline, and `JSONFormatter` are implemented;
built-in transports (console/file/HTTP) and non-blocking async dispatch are
not yet — see `CHANGELOG.md` for what's landed so far.

## Features

- **Structured by default** — every call carries a `meta` object, not just a message string
- **Cross-language record shape** — identical JSON shape and level names/weights as [`logquill` on PyPI](https://pypi.org/project/logquill/)
- **Pluggable formatters** — `JSONFormatter` out of the box; implement `format(record) -> string` for your own
- **Pluggable transports** — write your own by subclassing `Transport`; `CollectingTransport` ships as an in-memory sink, handy for tests
- **Plugin pipeline** — `beforeLog`/`afterLog`/`onError` hooks; a throwing plugin can't crash logging
- **Child loggers** — `.child()` inherits level, transports, and plugins, and merges its own `meta` on top
- **Typed throughout** — TypeScript strict mode, no `any` in the public API
- **Dual package** — works via both `require()` (CJS) and `import` (ESM) from the same published package
- *(planned)* built-in `ConsoleTransport`/`FileTransport`/`HTTPTransport`, `ContextPlugin`/`RedactPlugin`/`SamplingPlugin`, non-blocking async dispatch, `AsyncLocalStorage`-based context propagation — see `CHANGELOG.md`

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

Attach transports (a `Transport` subclass implementing `write(formatted,
record)`) to actually dispatch records somewhere — concrete built-in
transports (`ConsoleTransport`, `FileTransport`, `HTTPTransport`) are still
to come; `CollectingTransport` is included now as an in-memory sink,
handy for tests:

```ts
import { CollectingTransport } from "logquill";

const sink = new CollectingTransport();
const logger2 = new Logger("app", { transports: [sink] });
logger2.info("hello");
console.log(sink.formatted); // ['{"timestamp":...,"message":"hello",...}']
```

Works from both ESM (`import`) and CommonJS (`require`) — the package ships
a dual build with full TypeScript types.

## Development

```sh
npm install
npm run build      # dist/index.{mjs,cjs,d.ts} via tsup
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run coverage    # vitest run --coverage
```

## License

MIT
