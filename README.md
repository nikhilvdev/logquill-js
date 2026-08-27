# logquill

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

> **Status:** Phase 0 (repo & build tooling) is scaffolded. The public logging
> API — `Logger`, levels, transports, formatters, plugins — lands in the
> phases that follow; see [CLAUDE.md](./CLAUDE.md) for the roadmap.

## Install

```sh
npm install logquill
```

## Usage

```ts
import { VERSION } from "logquill";

console.log(VERSION);
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
