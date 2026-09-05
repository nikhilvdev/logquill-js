import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NODE_BUILTIN = /^(?:node:)?(?:fs|http|https|net|tls|dns|crypto|zlib|os|path|async_hooks|module|child_process)$/;

describe("logquill/browser bundle (Phase 8 exit criterion)", () => {
  it("resolves with no Node built-in imports", async () => {
    const entry = fileURLToPath(new URL("../../src/browser.ts", import.meta.url));

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      conditions: ["browser"],
      metafile: true,
      logLevel: "silent",
    });

    const inputPaths = Object.keys(result.metafile.inputs);
    const builtinInputs = inputPaths.filter((path) => NODE_BUILTIN.test(path));
    expect(builtinInputs).toEqual([]);

    // The Node-only span context must never be pulled in via the "#span" subpath import.
    expect(inputPaths.some((path) => path.endsWith("core/span.ts"))).toBe(false);
    expect(inputPaths.some((path) => path.endsWith("core/span-browser.ts"))).toBe(true);

    const bundle = result.outputFiles[0]?.text ?? "";
    expect(bundle).not.toMatch(/\bnode:/);
    expect(bundle).not.toMatch(/require\(/);
  });
});
