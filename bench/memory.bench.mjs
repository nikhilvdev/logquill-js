/**
 * Memory benchmark for the core Logger/plugin pipeline: tracked in CI
 * (`npm run bench`, wired into `.github/workflows/ci.yml`), not just run
 * manually, and fails the build on a meaningful regression in
 * allocations-per-log-call or peak memory under a sustained burst.
 *
 * Plain JS against the *built* package (`../dist/index.mjs`), run with
 * `node --expose-gc` (see the `bench` script in package.json, which builds
 * first) so measurements are taken around a forced GC rather than whatever
 * the engine happens to have collected on its own. Uses `CollectingTransport`
 * throughout — an in-memory no-op sink — so what's measured is the
 * framework's own overhead (record creation, the plugin pipeline, the
 * dispatch queue), not unrelated I/O cost.
 *
 * Thresholds here are deliberately generous (several times the measured
 * baseline on the machine this was calibrated on) to avoid flaking on
 * normal GC/JIT/CI-runner variance, while still catching a genuine
 * regression — e.g. an accidental deep clone creeping into the pipeline,
 * or a backpressure policy that stops actually bounding the queue.
 */
import { CollectingTransport, ContextPlugin, Logger, RedactPlugin } from "../dist/index.mjs";

function forceGc() {
  if (typeof global.gc !== "function") {
    throw new Error(
      "bench/memory.bench.mjs requires --expose-gc (run via `npm run bench`, not `node bench/memory.bench.mjs` directly)",
    );
  }
  global.gc();
}

function heapUsedBytes() {
  return process.memoryUsage().heapUsed;
}

function sampleMeta(i) {
  return {
    userId: `user-${i}`,
    requestId: `req-${i}-${i * 7}`,
    nested: { a: i, b: [1, 2, 3], c: { d: "e" } },
    password: "should-be-redacted",
  };
}

const WARMUP_CALLS = 20_000;
const MEASURED_CALLS = 100_000;
// Comfortably above MEASURED_CALLS so nothing is dropped mid-measurement —
// this benchmark measures steady-state cost per fully-written record, not
// backpressure (that's benchBackpressureUnderBurst's job, below).
const AMPLE_QUEUE_SIZE = MEASURED_CALLS * 2;
// Generous: measured baseline is ~640 bytes/call (one retained LogRecord +
// its formatted JSON string); this budget is ~3x that, loose headroom
// rather than a tight target, to avoid flaking on normal V8/CI variance
// while still catching a genuine regression (e.g. an accidental deep clone
// creeping into the plugin pipeline).
const MAX_BYTES_PER_CALL = 2_000;

async function benchAllocationsPerCall() {
  const transport = new CollectingTransport();
  const logger = new Logger("bench.alloc", {
    transports: [transport],
    plugins: [new ContextPlugin({ service: "bench" }), new RedactPlugin()],
    queue: { maxSize: AMPLE_QUEUE_SIZE },
  });

  for (let i = 0; i < WARMUP_CALLS; i++) {
    logger.info("warmup", sampleMeta(i));
  }
  await logger.flush();
  transport.records.length = 0;
  transport.formatted.length = 0;

  forceGc();
  const before = heapUsedBytes();

  for (let i = 0; i < MEASURED_CALLS; i++) {
    logger.info("measured call", sampleMeta(i));
  }
  // logger.info() only enqueues the write (dispatched via setImmediate) —
  // flush() waits for every one of them to actually reach the transport
  // before this measures what they cost.
  await logger.flush();

  forceGc();
  const after = heapUsedBytes();

  const bytesPerCall = (after - before) / MEASURED_CALLS;
  console.log(
    `[bench] allocations: ${bytesPerCall.toFixed(1)} bytes/call over ${MEASURED_CALLS} calls (budget: ${MAX_BYTES_PER_CALL})`,
  );

  if (bytesPerCall > MAX_BYTES_PER_CALL) {
    throw new Error(
      `[bench] FAIL: ${bytesPerCall.toFixed(1)} bytes/call exceeds the ${MAX_BYTES_PER_CALL}-byte budget — ` +
        `check for a regression (e.g. an accidental deep clone in the plugin pipeline).`,
    );
  }
}

const BURST_CALLS = 50_000;
const QUEUE_MAX_SIZE = 1_000;
// Generous: bounded by maxSize regardless of how many calls come in, plus
// headroom for the burst's own transient allocations (sampleMeta objects,
// V8 bookkeeping). A real leak (queue not actually bounded) would blow far
// past this, not sit just over it.
const MAX_BURST_HEAP_GROWTH_BYTES = 50 * 1024 * 1024;

async function benchBackpressureUnderBurst() {
  const transport = new CollectingTransport();
  const logger = new Logger("bench.burst", {
    transports: [transport],
    queue: { maxSize: QUEUE_MAX_SIZE, policy: "dropOldest" },
  });

  forceGc();
  const before = heapUsedBytes();

  // Fully synchronous burst: every call is enqueued before the dispatch
  // queue's setImmediate-scheduled drain gets a chance to run even once,
  // simulating a transport that can't keep up without needing to actually
  // block real wall-clock time.
  for (let i = 0; i < BURST_CALLS; i++) {
    logger.info("burst", sampleMeta(i));
  }

  const peakDuringBurst = heapUsedBytes();
  const queueSizeDuringBurst = logger.queueSize;

  await logger.flush();
  forceGc();
  const afterFlush = heapUsedBytes();

  const growthDuringBurst = peakDuringBurst - before;
  console.log(
    `[bench] backpressure: queue size during burst ${queueSizeDuringBurst} (max ${QUEUE_MAX_SIZE}), ` +
      `heap growth during burst ${(growthDuringBurst / 1024 / 1024).toFixed(2)} MB ` +
      `(budget ${(MAX_BURST_HEAP_GROWTH_BYTES / 1024 / 1024).toFixed(0)} MB), ` +
      `heap after flush+gc ${((afterFlush - before) / 1024 / 1024).toFixed(2)} MB`,
  );

  if (queueSizeDuringBurst > QUEUE_MAX_SIZE) {
    throw new Error(
      `[bench] FAIL: queue grew to ${queueSizeDuringBurst}, past its configured maxSize of ${QUEUE_MAX_SIZE} — backpressure is not bounding the queue.`,
    );
  }
  if (growthDuringBurst > MAX_BURST_HEAP_GROWTH_BYTES) {
    throw new Error(
      `[bench] FAIL: heap grew ${(growthDuringBurst / 1024 / 1024).toFixed(2)} MB during a ${BURST_CALLS}-call burst against a queue capped at ${QUEUE_MAX_SIZE} — check for an unbounded buffer somewhere in the burst path.`,
    );
  }
}

async function main() {
  await benchAllocationsPerCall();
  await benchBackpressureUnderBurst();
  console.log("[bench] all benchmarks within budget");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
