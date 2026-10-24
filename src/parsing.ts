import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Matches one entry written by `TextFormatter` (single-line entries; a stack
 * printed on the lines after an entry isn't part of the match). Pass with
 * `cast: TEXT_LOG_CASTS` to get `meta` back as an object:
 *
 *     parse("app.log", TEXT_LOG_PATTERN, { cast: TEXT_LOG_CASTS })
 */
export const TEXT_LOG_PATTERN =
  /^(?<timestamp>\S+) (?<level>[A-Z]+)\s+(?<logger>[^:\s]+): (?<message>.*?)(?: (?<meta>\{.*\}))?$/;

/** `cast` mapping that decodes the `meta` group of {@link TEXT_LOG_PATTERN} from JSON. */
export const TEXT_LOG_CASTS: Record<string, (text: string) => unknown> = {
  meta: (text) => JSON.parse(text) as unknown,
};

export interface ParseOptions {
  /** Maps a named group to a function applied to that group's text, e.g. `{ status: Number }`. A group that didn't match is left `undefined`. */
  cast?: Record<string, (text: string) => unknown>;
}

async function* linesOf(
  source: string | Iterable<string> | AsyncIterable<string>,
): AsyncGenerator<string> {
  if (typeof source === "string") {
    const rl = createInterface({ input: createReadStream(source, "utf8"), crlfDelay: Infinity });
    yield* rl;
  } else {
    yield* source;
  }
}

/**
 * Extracts structured fields from a log file with a regex, yielding one object
 * per matching line — including logs LogQuill didn't write (legacy apps,
 * third-party tools):
 *
 *     const re = /(?<when>\S+ \S+) \[(?<level>[A-Z]+)\] (?<code>\d+) (?<message>.*)/;
 *     for await (const entry of parse("legacy.log", re, { cast: { code: Number } })) { ... }
 *
 * `source` is a file path, or any (async) iterable of lines. `pattern` must
 * contain at least one named group. Lines that don't match are skipped.
 * Streams line by line, so memory stays flat however large the file is; a
 * pattern can't span lines.
 *
 * Throws immediately for a pattern with no named groups or a `cast` key that
 * isn't one, and — while iterating — if a `cast` function rejects a value,
 * naming the line number so the entry can be found.
 */
export function parse(
  source: string | Iterable<string> | AsyncIterable<string>,
  pattern: RegExp,
  options: ParseOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const groups = new Set(
    Object.keys(new RegExp(`${pattern.source}|`, pattern.flags).exec("")?.groups ?? {}),
  );
  if (groups.size === 0) {
    throw new Error(
      "parse(): the pattern has no named groups — wrap the fields you want in (?<name>...), e.g. /(?<level>[A-Z]+) (?<message>.*)/",
    );
  }
  const casts = options.cast ?? {};
  const unknown = Object.keys(casts).filter((name) => !groups.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `parse(): cast refers to ${JSON.stringify(unknown)}, which are not named groups in the pattern (groups: ${JSON.stringify([...groups].sort())})`,
    );
  }
  return scan(source, new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")), casts);
}

async function* scan(
  source: string | Iterable<string> | AsyncIterable<string>,
  pattern: RegExp,
  casts: Record<string, (text: string) => unknown>,
): AsyncGenerator<Record<string, unknown>> {
  let number = 0;
  for await (const line of linesOf(source)) {
    number += 1;
    const match = pattern.exec(line.replace(/\r?\n$/, ""));
    if (match === null) continue;
    const fields: Record<string, unknown> = { ...match.groups };
    for (const [name, convert] of Object.entries(casts)) {
      const text = fields[name];
      if (typeof text !== "string") continue;
      try {
        fields[name] = convert(text);
      } catch (error) {
        throw new Error(
          `parse(): line ${String(number)}: cast for '${name}' failed on ${JSON.stringify(text)} (${String(error)}) — make the cast tolerant of this value or tighten the pattern so the group only matches what it can convert`,
          { cause: error },
        );
      }
    }
    yield fields;
  }
}
