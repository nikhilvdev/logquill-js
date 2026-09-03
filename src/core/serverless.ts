import { hasFlush } from "../transports/transport.js";
import type { Logger } from "./logger.js";

async function flushEverything(logger: Logger): Promise<void> {
  await logger.flush();
  // logger.flush() only guarantees records reached each transport's write()
  // — a batching transport (SQL, a queue, HTTPTransport, ...) may still be
  // sitting on a batch under its own threshold. Force those out too: a
  // frozen/recycled execution environment may never come back to finish it.
  for (const transport of logger.transports) {
    if (!hasFlush(transport)) {
      continue;
    }
    try {
      await transport.flush();
    } catch (error) {
      console.error(`${transport.constructor.name}: failed to flush`, error);
    }
  }
}

/**
 * Wraps a serverless handler so `logger.flush()` is awaited before the
 * wrapped function returns or throws. A serverless runtime can freeze or
 * recycle its execution environment the instant a handler settles, so
 * anything still sitting in the dispatch queue — or a batching transport's
 * own buffer — needs to be sent before that happens, not left for an
 * invocation that may not come for a while (or ever, if the environment is
 * torn down instead of frozen).
 *
 * The handler shape itself doesn't matter here — only that `fn` is an async
 * function whose settling is the runtime's cue to freeze — so the same
 * wrapper covers AWS Lambda, GCP Cloud Functions, and Azure Functions
 * equally; `withLambda`/`withCloudFunction`/`withAzureFunction` are the same
 * function under names that match each platform's docs.
 *
 * ```ts
 * export const handler = withLambda(logger, async (event) => {
 *   logger.info("handling request", { requestId: event.requestId });
 *   return { statusCode: 200 };
 * });
 * ```
 */
export function withFlush<Args extends unknown[], TResult>(
  logger: Logger,
  fn: (...args: Args) => Promise<TResult>,
): (...args: Args) => Promise<TResult> {
  return async (...args: Args): Promise<TResult> => {
    try {
      return await fn(...args);
    } finally {
      await flushEverything(logger);
    }
  };
}

/** `withFlush`, named for an AWS Lambda handler. */
export const withLambda = withFlush;
/** `withFlush`, named for a GCP Cloud Functions handler. */
export const withCloudFunction = withFlush;
/** `withFlush`, named for an Azure Functions handler. */
export const withAzureFunction = withFlush;
