#!/usr/bin/env bash
# Installs a packed logquill tarball into a clean project and exercises it the way real consumers do.
# usage: run.sh <path-to-tarball> [work-dir]
set -euo pipefail
tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
here=$(cd "$(dirname "$0")" && pwd)
work=${2:-$(mktemp -d)}
mkdir -p "$work" && cd "$work"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$tarball" typescript@5 @types/node
cp "$here"/* . 2>/dev/null || true

node cjs.cjs
node esm.mjs
npx tsc -p tsconfig.node.json
echo "types OK: nodenext (CJS and ESM)"
npx tsc -p tsconfig.browser.json
echo "types OK: browser entry, no Node typings"
npx tsc -p tsconfig.node10.json
echo "types OK: legacy node10 resolution"
