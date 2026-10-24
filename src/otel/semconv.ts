/**
 * LogQuill records -> OpenTelemetry GenAI semantic-convention names.
 *
 * This is the only module in logquill that contains GenAI attribute names, span
 * names or operation names. Everything else asks it: a transport passes a record
 * in and gets a span name, a span kind and a set of attributes back.
 *
 * The GenAI conventions are still marked *Development* upstream, and the names
 * have already changed more than once (`gen_ai.system` became
 * `gen_ai.provider.name`; `prompt_tokens`/`completion_tokens` became
 * `input_tokens`/`output_tokens`). So the names live in one table per convention
 * generation, pinned to a named release, and moving to a newer release is an edit
 * to this file and nothing else. It never imports OpenTelemetry, so it can be
 * tested, and read, on its own. It is the same table `logquill-python` uses.
 *
 * Pinned to the GenAI conventions as published with semantic-conventions
 * {@link CONVENTION_VERSION}.
 */
import type { LogRecord } from "../core/records.js";

/** The semantic-conventions release the `latest` names below come from. */
export const CONVENTION_VERSION = "1.44.0";

/** The environment variable OpenTelemetry uses to opt in to newer experimental conventions. */
export const OPT_IN_ENV = "OTEL_SEMCONV_STABILITY_OPT_IN";
/** The value of {@link OPT_IN_ENV} that asks for the latest experimental GenAI conventions. */
export const OPT_IN_LATEST = "gen_ai_latest_experimental";
/** `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` turns on prompt and completion capture, the same switch other GenAI instrumentation uses. */
export const CAPTURE_CONTENT_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

// Attributes LogQuill adds that no convention defines. Namespaced so they can't
// collide with anything upstream adds later.
const EXT = "logquill.";
const ERROR_TYPE = "error.type";

/** Operation name for an agent run. */
export const INVOKE_AGENT = "invoke_agent";
/** Operation name for a tool call. */
export const EXECUTE_TOOL = "execute_tool";
/** Operation name for a chat-style model call. */
export const CHAT = "chat";
/** Operation name for a plain text-completion model call. */
export const TEXT_COMPLETION = "text_completion";

/** `provider` when nothing says which one: the attribute is required upstream. */
export const UNKNOWN_PROVIDER = "unknown";

/** A span attribute value as OpenTelemetry accepts it. */
export type AttributeValue = string | number | boolean | string[];

/** The concepts a {@link Convention} names: each maps to one attribute name per generation. */
export type NameKey =
  | "operation"
  | "provider"
  | "request_model"
  | "response_model"
  | "input_tokens"
  | "output_tokens"
  | "finish_reasons"
  | "agent_name"
  | "agent_id"
  | "conversation_id"
  | "tool_name"
  | "tool_call_id"
  | "input_messages"
  | "output_messages";

/** One generation of GenAI attribute names: LogQuill's own keys mapped to what a backend receives. */
export interface Convention {
  /** The semantic-conventions release for `latest`, or `"legacy"` for the earlier generation. */
  readonly version: string;
  /** LogQuill's key for each concept, mapped to the attribute name this generation uses. */
  readonly names: Readonly<Record<NameKey, string>>;
}

const LATEST: Convention = {
  version: CONVENTION_VERSION,
  names: {
    operation: "gen_ai.operation.name",
    provider: "gen_ai.provider.name",
    request_model: "gen_ai.request.model",
    response_model: "gen_ai.response.model",
    input_tokens: "gen_ai.usage.input_tokens",
    output_tokens: "gen_ai.usage.output_tokens",
    finish_reasons: "gen_ai.response.finish_reasons",
    agent_name: "gen_ai.agent.name",
    agent_id: "gen_ai.agent.id",
    conversation_id: "gen_ai.conversation.id",
    tool_name: "gen_ai.tool.name",
    tool_call_id: "gen_ai.tool.call.id",
    input_messages: "gen_ai.input.messages",
    output_messages: "gen_ai.output.messages",
  },
};

// The names in use before the provider and token-count renames: for a backend or
// dashboard that hasn't caught up. Only ever chosen explicitly.
const LEGACY: Convention = {
  version: "legacy",
  names: {
    ...LATEST.names,
    provider: "gen_ai.system",
    input_tokens: "gen_ai.usage.prompt_tokens",
    output_tokens: "gen_ai.usage.completion_tokens",
  },
};

const CONVENTIONS: Readonly<Record<string, Convention>> = { latest: LATEST, legacy: LEGACY };

// What is used when neither the caller nor the environment says. Kept separate from
// `LATEST` on purpose: when a newer generation is added, the default can stay on the
// one people already export while `gen_ai_latest_experimental` opts in to the new one,
// which is how OpenTelemetry asks for this to work.
const DEFAULT: Convention = LATEST;

/** An environment-variable map, `process.env` by default. */
export type Env = Readonly<Record<string, string | undefined>>;

// Isomorphic guard: `process` doesn't exist in a browser bundle.
function defaultEnv(): Env {
  return typeof process === "undefined" ? {} : process.env;
}

const warnedOptIn = new Set<string>();

/**
 * Chooses the naming generation. An explicit `"latest"` or `"legacy"` wins;
 * otherwise `OTEL_SEMCONV_STABILITY_OPT_IN` is read (a comma-separated list, of
 * which `gen_ai_latest_experimental` selects the latest names); otherwise the
 * default is used.
 *
 * Old and new names are never emitted together: an opt-in value asking for that
 * (anything ending `/dup`) is ignored with a one-time warning, and exactly one
 * generation is used.
 */
export function resolveConvention(explicit?: string, environ: Env = defaultEnv()): Convention {
  if (explicit !== undefined) {
    const found = CONVENTIONS[explicit];
    if (!found) {
      throw new Error(
        `semconvVersion must be one of ${Object.keys(CONVENTIONS).sort().join(", ")}, got ${JSON.stringify(explicit)}`,
      );
    }
    return found;
  }
  const tokens = (environ[OPT_IN_ENV] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token.endsWith("/dup") && !warnedOptIn.has(token)) {
      warnedOptIn.add(token);
      console.warn(
        `${OPT_IN_ENV}=${token}: LogQuill never emits old and new GenAI attribute names together — using one generation only`,
      );
    }
  }
  return tokens.includes(OPT_IN_LATEST) ? LATEST : DEFAULT;
}

/** Whether the environment switches on prompt/completion capture. */
export function captureContentEnabled(environ: Env = defaultEnv()): boolean {
  return (environ[CAPTURE_CONTENT_ENV] ?? "").trim().toLowerCase() === "true";
}

/** Whether a span should be exported as a client or an internal span. */
export type SpanKindName = "client" | "internal";

/**
 * A span a record describes: its name, kind, attributes, and (because a record is
 * written when the work *ends*) how long it lasted.
 */
export interface SpanSpec {
  /** The span's name, e.g. `chat gpt-4o`. */
  readonly name: string;
  /** Client for model and agent calls, internal for everything else. */
  readonly kind: SpanKindName;
  /** The span's attributes, already named for the chosen convention. */
  readonly attributes: Record<string, AttributeValue>;
  /** How long the work lasted, if the record says. */
  readonly durationMs: number | undefined;
  /** Whether the span should be marked as an error. */
  readonly isError: boolean;
  /** Events to add to the span, each a name and its attributes. */
  readonly events: readonly (readonly [name: string, attributes: Record<string, AttributeValue>])[];
}

type Meta = Readonly<Record<string, unknown>>;

function metaOf(record: LogRecord): Meta {
  return typeof record.meta === "object" ? record.meta : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

function errorType(meta: Meta): string | undefined {
  const error = str(meta.error);
  if (error === undefined) return undefined;
  const head = (error.split(":", 1)[0] ?? "").trim();
  return head !== "" && !head.includes(" ") ? head : "_OTHER";
}

/** A record `Logger.span()` wrote on exit. */
export function isSpanRecord(record: LogRecord): boolean {
  const meta = metaOf(record);
  return meta.kind === "span" && typeof meta.span_id === "string";
}

/** A record carrying an `llm` block. */
export function isLlmRecord(record: LogRecord): boolean {
  return typeof record.llm === "object";
}

/** An `.action()` naming the tool it called, in `meta.tool`. */
export function isToolRecord(record: LogRecord): boolean {
  const meta = metaOf(record);
  return meta.kind === "action" && str(meta.tool) !== undefined;
}

function common(
  convention: Convention,
  meta: Meta,
  attributes: Record<string, AttributeValue>,
): void {
  const { names } = convention;
  const threadId = str(meta.thread_id);
  if (threadId) attributes[names.conversation_id] = threadId;
  const agentName = str(meta.agent_name);
  if (agentName) attributes[names.agent_name] = agentName;
  const runId = str(meta.run_id);
  if (runId) attributes[`${EXT}run_id`] = runId;
  const node = str(meta.node_name);
  if (node) attributes[`${EXT}node_name`] = node;
  if (typeof meta.retry_count === "number" && Number.isInteger(meta.retry_count)) {
    attributes[`${EXT}retry_count`] = meta.retry_count;
  }
  const type = errorType(meta);
  if (type) attributes[ERROR_TYPE] = type;
}

function events(meta: Meta): SpanSpec["events"] {
  const diff = meta.state_diff;
  return typeof diff === "object" && diff !== null
    ? [[`${EXT}state_diff`, { [`${EXT}state`]: json(diff) }]]
    : [];
}

/** Options for {@link llmSpec}. */
export interface LlmSpecOptions {
  /** `gen_ai.provider.name` for records without `meta.provider`. Default `"unknown"`. */
  defaultProvider?: string;
  /** Add prompt and completion text (`meta.input_messages`/`output_messages`). Default `false`. */
  captureContent?: boolean;
}

/**
 * The inference span for a record with an `llm` block: `chat {model}`, or
 * `text_completion {model}` when `meta.operation` says so. Prompt and completion
 * text are added only if `captureContent` is true.
 */
export function llmSpec(
  record: LogRecord,
  convention: Convention,
  options: LlmSpecOptions = {},
): SpanSpec {
  const { names } = convention;
  const llm = record.llm ?? {};
  const meta = metaOf(record);

  const operation = meta.operation === TEXT_COMPLETION ? TEXT_COMPLETION : CHAT;
  const model = str(llm.model);
  const attributes: Record<string, AttributeValue> = {
    [names.operation]: operation,
    [names.provider]: str(meta.provider) ?? options.defaultProvider ?? UNKNOWN_PROVIDER,
  };
  if (model) attributes[names.request_model] = model;
  const responseModel = str(meta.response_model);
  if (responseModel) attributes[names.response_model] = responseModel;
  if (Number.isInteger(llm.tokens_in)) attributes[names.input_tokens] = llm.tokens_in as number;
  if (Number.isInteger(llm.tokens_out)) attributes[names.output_tokens] = llm.tokens_out as number;
  const finishReason = str(llm.finish_reason);
  if (finishReason) attributes[names.finish_reasons] = [finishReason];
  if (typeof llm.cost_usd === "number") attributes[`${EXT}cost_usd`] = llm.cost_usd;
  if (options.captureContent) {
    for (const key of ["input_messages", "output_messages"] as const) {
      if (meta[key] !== undefined && meta[key] !== null) attributes[names[key]] = json(meta[key]);
    }
  }
  common(convention, meta, attributes);

  return {
    name: model ? `${operation} ${model}` : operation,
    kind: "client",
    attributes,
    durationMs: num(llm.latency_ms),
    isError: errorType(meta) !== undefined || record.level === "ERROR" || record.level === "FATAL",
    events: events(meta),
  };
}

/** The `execute_tool {tool}` span for an `.action()` that names its tool. */
export function toolSpec(record: LogRecord, convention: Convention): SpanSpec {
  const { names } = convention;
  const meta = metaOf(record);
  const tool = String(meta.tool);
  const attributes: Record<string, AttributeValue> = {
    [names.operation]: EXECUTE_TOOL,
    [names.tool_name]: tool,
  };
  const callId = str(meta.tool_call_id);
  if (callId) attributes[names.tool_call_id] = callId;
  common(convention, meta, attributes);
  return {
    name: `${EXECUTE_TOOL} ${tool}`,
    kind: "internal",
    attributes,
    durationMs: num(meta.duration_ms),
    isError: errorType(meta) !== undefined,
    events: events(meta),
  };
}

/**
 * The span for a `Logger.span()` record. A span that says it is an agent run
 * (`meta.operation = "invoke_agent"`, or it names an `agent_name`) is an
 * `invoke_agent {agent}` span; any other span keeps its own name and carries no
 * GenAI operation. (A span isn't assumed to be an agent run just because it is
 * the outermost one: that would rename ordinary spans.)
 */
export function spanSpec(
  record: LogRecord,
  convention: Convention,
  options: Pick<LlmSpecOptions, "defaultProvider"> = {},
): SpanSpec {
  const { names } = convention;
  const meta = metaOf(record);
  const attributes: Record<string, AttributeValue> = {};
  common(convention, meta, attributes);

  let name = record.message;
  let kind: SpanKindName = "internal";
  if (meta.operation === INVOKE_AGENT || str(meta.agent_name)) {
    const agent = str(meta.agent_name) ?? record.logger;
    attributes[names.operation] = INVOKE_AGENT;
    attributes[names.provider] = str(meta.provider) ?? options.defaultProvider ?? UNKNOWN_PROVIDER;
    attributes[names.agent_name] = agent;
    const agentId = str(meta.agent_id);
    if (agentId) attributes[names.agent_id] = agentId;
    name = `${INVOKE_AGENT} ${agent}`;
    kind = "client";
  }

  return {
    name,
    kind,
    attributes,
    durationMs: num(meta.duration_ms),
    isError: record.level === "ERROR" || record.level === "FATAL",
    events: events(meta),
  };
}

/**
 * The GenAI attributes to put on a *log* record: the `llm` block's usage and
 * model, so a log line about an LLM call is queryable by the same names as its span.
 */
export function logAttributes(
  record: LogRecord,
  convention: Convention,
): Record<string, AttributeValue> {
  const { llm } = record;
  if (typeof llm !== "object") return {};
  const { names } = convention;
  const attributes: Record<string, AttributeValue> = { [names.operation]: CHAT };
  const model = str(llm.model);
  if (model) attributes[names.request_model] = model;
  if (Number.isInteger(llm.tokens_in)) attributes[names.input_tokens] = llm.tokens_in as number;
  if (Number.isInteger(llm.tokens_out)) attributes[names.output_tokens] = llm.tokens_out as number;
  const finishReason = str(llm.finish_reason);
  if (finishReason) attributes[names.finish_reasons] = [finishReason];
  if (typeof llm.cost_usd === "number") attributes[`${EXT}cost_usd`] = llm.cost_usd;
  return attributes;
}

/** OpenTelemetry's `HrTime`: `[seconds, nanoseconds]` since the Unix epoch. */
export type HrTime = [seconds: number, nanoseconds: number];

/** A record's ISO 8601 timestamp as an `HrTime`. */
export function epochHr(timestamp: string): HrTime {
  const ms = Date.parse(timestamp);
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
}

/** `end` minus `durationMs`, as an `HrTime`. */
export function hrMinusMs(end: HrTime, durationMs: number): HrTime {
  const total = Math.round(durationMs * 1_000_000);
  let seconds = end[0] - Math.floor(total / 1_000_000_000);
  let nanos = end[1] - (total % 1_000_000_000);
  if (nanos < 0) {
    nanos += 1_000_000_000;
    seconds -= 1;
  }
  return [seconds, nanos];
}
