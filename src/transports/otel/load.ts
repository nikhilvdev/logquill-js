import { createRequire } from "node:module";

/**
 * Loads an optional OpenTelemetry package. A `require()` (via `createRequire`)
 * rather than a dynamic `import()` so a transport can build its provider in its
 * constructor, as `logquill-python` does; the OpenTelemetry packages ship CommonJS
 * as well. Throws an error saying which package is missing and how to install it,
 * since all of them are optional peer dependencies.
 */
export function loadOtel(transport: string, packageName: string): unknown {
  try {
    const require = createRequire(import.meta.url);
    return require(packageName) as unknown;
  } catch (error) {
    throw new Error(
      `${transport} requires ${packageName}: install the OpenTelemetry packages with ` +
        "`npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-logs " +
        "@opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http`",
      { cause: error },
    );
  }
}
