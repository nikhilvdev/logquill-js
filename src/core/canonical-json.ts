const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

// Python's `json.dumps` (ensure_ascii) escapes everything outside space..~.
function pythonString(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be escaped
  return `"${text.replace(/["\\\u0000-\u001f\u007f-￿]/g, (char) => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

// Python's `repr(float)` switches to exponent form below 1e-4 and from 1e16, with a
// two-digit minimum exponent; JS switches at other points. Integral values print as
// ints, so a Python float like `12.0` (hashed as "12.0") can't be told from `12`.
function pythonNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value))
    return Number.isFinite(value) ? String(value) : "null";
  const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
  const exp = Number(exponent);
  if (exp >= -4 && exp < 16) return String(value);
  return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/**
 * Stringifies a value exactly as Python's `json.dumps(value, sort_keys=True)`
 * does — `", "` and `": "` separators, ASCII-only escapes — so text derived from
 * it (a tamper-chain hash, a content-policy digest) is the same in
 * `logquill-python` and here. Keys sort by UTF-16 code unit, which matches
 * Python's code-point order except around astral characters.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return pythonString(value);
  if (typeof value === "number") return pythonNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    return canonicalStringify((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalStringify(entry)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entry]) =>
          entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${pythonString(key)}: ${canonicalStringify(entry)}`).join(", ")}}`;
  }
  return "null"; // functions and symbols: dropped from objects above, null elsewhere
}
