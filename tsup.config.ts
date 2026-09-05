import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/langchain.ts", "src/winston.ts"],
    format: ["esm", "cjs"],
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".mjs" };
    },
  },
  {
    // The browser entry (Phase 8): ESM only, built as its own esbuild pass
    // with the "browser" export condition so `logger.ts`'s `"#span"` subpath
    // import (see package.json's `imports` map) resolves to
    // `core/span-browser.ts` instead of the `AsyncLocalStorage`-based
    // `core/span.ts` the Node build above resolves it to — the one thing
    // that would otherwise pull `node:async_hooks`/`node:crypto` into this
    // bundle.
    entry: { browser: "src/browser.ts" },
    format: ["esm"],
    platform: "browser",
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    outExtension() {
      return { js: ".mjs" };
    },
    esbuildOptions(options) {
      options.conditions = [...(options.conditions ?? []), "browser"];
    },
  },
]);
