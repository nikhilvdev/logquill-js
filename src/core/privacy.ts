import { canonicalStringify } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

/** What a well-known `meta` key holds, for rules that act on a whole class at once. */
export type FieldClass = "secret" | "pii" | "content";

/**
 * Which class a well-known `meta` key belongs to. `secret`: always-redact
 * credentials. `pii`: personal data. `content`: prompt, completion and
 * tool-call data, governed by {@link ContentCapturePolicy} rather than a flat
 * redact-or-don't rule. The same registry `logquill-python` uses.
 */
export const FIELD_CLASSES: Readonly<Record<string, FieldClass>> = {
  password: "secret",
  token: "secret",
  secret: "secret",
  api_key: "secret",
  authorization: "secret",
  email: "pii",
  ssn: "pii",
  phone: "pii",
  input_messages: "content",
  output_messages: "content",
  system_instructions: "content",
  tool_arguments: "content",
  tool_result: "content",
  state_diff: "content",
};

/** The `meta` keys `Logger`'s `contentPolicy` governs. */
export const CONTENT_FIELDS: readonly string[] = Object.entries(FIELD_CLASSES)
  .filter(([, fieldClass]) => fieldClass === "content")
  .map(([key]) => key);

/**
 * What happens to a content field on its way to a transport:
 * `"off"` (the default) replaces it with a fixed placeholder; `"hash"` with a
 * stable `sha256:` digest, so two records can be confirmed to share a prompt
 * without either exposing it; `"truncate"` keeps the first
 * {@link TRUNCATE_CHARS} characters; `"full"` passes it through.
 */
export type ContentCapturePolicy = "off" | "hash" | "truncate" | "full";

const POLICIES: readonly string[] = ["off", "hash", "truncate", "full"];

/** How much of a `truncate`-policy value's JSON text survives. */
export const TRUNCATE_CHARS = 200;

const OFF_PLACEHOLDER = "<content capture is off — see Logger's contentPolicy option>";

/** Validates `policy`, throwing an error that names the valid choices if it isn't one of them. */
export function parseContentPolicy(policy: string): ContentCapturePolicy {
  if (!POLICIES.includes(policy)) {
    throw new Error(
      `contentPolicy must be one of ${POLICIES.map((p) => JSON.stringify(p)).join(", ")}, got ${JSON.stringify(policy)}`,
    );
  }
  return policy as ContentCapturePolicy;
}

// A circular reference or a throwing getter must not crash the caller that is only logging.
function safeText(value: unknown): string {
  try {
    return canonicalStringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unrepresentable>";
    }
  }
}

function applyOne(value: unknown, policy: ContentCapturePolicy): unknown {
  if (policy === "full") return value;
  if (policy === "off") return OFF_PLACEHOLDER;
  const text = safeText(value);
  if (policy === "hash") return `sha256:${sha256Hex(text)}`;
  if (text.length <= TRUNCATE_CHARS) return text;
  return `${text.slice(0, TRUNCATE_CHARS)}...(truncated, ${String(text.length)} chars total)`;
}

/**
 * Applies `policy` to every content field present in `meta`, in place.
 * `"full"` returns immediately. The value is never silently dropped under
 * `"off"`: a reader can tell capture was configured off rather than wondering
 * why the field is missing. Text for `"hash"`/`"truncate"` is the same
 * canonical JSON `logquill-python` uses, so the digests match across the two.
 */
export function applyContentPolicy(
  meta: Record<string, unknown>,
  policy: ContentCapturePolicy,
  fields: readonly string[] = CONTENT_FIELDS,
): void {
  if (policy === "full") return;
  for (const field of fields) {
    if (field in meta) meta[field] = applyOne(meta[field], policy);
  }
}
