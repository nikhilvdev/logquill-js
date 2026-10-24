// Run inside a project that has the packed logquill and ONE OpenTelemetry combination installed.
// Exercises the real SDK: the exact span tree, one trace, gen_ai.usage.* attributes, and the log records.
const { Logger, OTLPTransport, OTelLogsTransport, RunPlugin } = require("logquill");
const traceBase = (() => { try { return require("@opentelemetry/sdk-trace-base"); } catch { return require("@opentelemetry/sdk-trace"); } })();
const { InMemoryLogRecordExporter } = require("@opentelemetry/sdk-logs");
(async () => {
  const spans = new traceBase.InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const logger = new Logger("smoke", {
    transports: [new OTLPTransport({ spanExporter: spans, processor: "simple" }), new OTelLogsTransport({ logExporter: logs, processor: "simple" })],
    plugins: [new RunPlugin({ runId: "run-1" })],
  });
  await logger.span("run", async () => {
    logger.llmCall({ model: "gpt-4o", tokensIn: 10, tokensOut: 5, finishReason: "stop", latencyMs: 40 });
    logger.action("tool", { tool: "search" });
  }, { operation: "invoke_agent", agent_name: "planner" });
  await logger.flush();
  for (const t of logger.transports) await t.flush();
  const got = spans.getFinishedSpans();
  const run = got.find((s) => s.name === "invoke_agent planner");
  const chat = got.find((s) => s.name === "chat gpt-4o");
  const parentOf = (s) => (s.parentSpanContext ?? { spanId: s.parentSpanId })?.spanId;
  const checks = {
    names: got.map((s) => s.name).join("|") === "chat gpt-4o|execute_tool search|invoke_agent planner",
    oneTrace: new Set(got.map((s) => s.spanContext().traceId)).size === 1,
    tree: !!run && !!chat && parentOf(chat) === run.spanContext().spanId && !parentOf(run),
    usage: chat?.attributes["gen_ai.usage.input_tokens"] === 10 && chat?.attributes["gen_ai.usage.output_tokens"] === 5,
    logs: logs.getFinishedLogRecords().length === 3,
  };
  const ok = Object.values(checks).every(Boolean);
  console.log((ok ? "PASS " : "FAIL ") + JSON.stringify(checks));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("ERROR " + e.message); process.exit(2); });
