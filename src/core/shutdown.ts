import type { Logger } from "./logger.js";

export interface ShutdownHandlerOptions {
  /** Signals to flush-and-close on (e.g. an orchestrator's SIGTERM). Default `["SIGTERM", "SIGINT"]`. */
  signals?: NodeJS.Signals[];
}

/**
 * Registers listeners so `logger.close()` runs once as the process ends —
 * on `beforeExit` (the event loop draining naturally) and on the given
 * `signals` (a container/orchestrator asking the process to stop) — so
 * whatever is still in the dispatch queue or a batching transport's buffer
 * isn't silently lost. Node-only (uses `process`); don't call this from a
 * browser bundle.
 *
 * Registering a listener for a signal like `SIGTERM` opts this process out
 * of Node's default "terminate immediately" behavior for it, so this
 * function calls `process.exit(0)` itself once `close()` settles — `
 * beforeExit` doesn't need that, since the process is already on its way
 * out there.
 *
 * Returns a function that removes the listeners again — call it in tests,
 * or if the caller wants to manage its own shutdown lifecycle instead.
 */
export function installShutdownHandlers(logger: Logger, options: ShutdownHandlerOptions = {}): () => void {
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let closed = false;

  const shutdown = (exitAfter: boolean): void => {
    if (closed) {
      return;
    }
    closed = true;
    logger
      .close()
      .catch((error: unknown) => {
        console.error("installShutdownHandlers: logger.close() failed during shutdown", error);
      })
      .finally(() => {
        if (exitAfter) {
          process.exit(0);
        }
      });
  };

  const onBeforeExit = (): void => {
    shutdown(false);
  };
  const onSignal = (): void => {
    shutdown(true);
  };

  process.once("beforeExit", onBeforeExit);
  for (const signal of signals) {
    process.once(signal, onSignal);
  }

  return () => {
    process.removeListener("beforeExit", onBeforeExit);
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  };
}
