# logquill

[![CI](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilvdev/logquill-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/logquill.svg)](https://www.npmjs.com/package/logquill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A logging framework for Node/TypeScript that shares one mental model and one
JSON log shape with its Python sibling, [`logquill`](https://pypi.org/project/logquill/)
(repo: `logquill-python`).

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
