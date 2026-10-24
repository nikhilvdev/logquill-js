/** Marks a snapshot that could not be taken, as distinct from a state that is `undefined`. */
export const UNCAPTURED: unique symbol = Symbol("uncaptured");

/**
 * A deep copy of the captured state — a copy, because state usually mutates in
 * place and a reference would show "after" for both. Returns {@link UNCAPTURED}
 * if the callback throws or the value can't be cloned (a function inside it,
 * say), so a broken snapshot never breaks the code being traced.
 */
export function snapshot(capture: () => unknown): unknown {
  try {
    return structuredClone(capture());
  } catch {
    return UNCAPTURED;
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality for JSON-like values (plain objects, arrays, primitives, dates). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * What changed between two snapshots, or `undefined` if nothing did. For two
 * plain objects, only the keys that differ (a key added shows only under
 * `after`, one removed only under `before`); otherwise the two whole values.
 */
export function stateDiff(
  before: unknown,
  after: unknown,
): { before: unknown; after: unknown } | undefined {
  if (isPlain(before) && isPlain(after)) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => !(key in before) || !(key in after) || !deepEqual(before[key], after[key]),
    );
    if (changed.length === 0) return undefined;
    const pick = (source: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(changed.filter((key) => key in source).map((key) => [key, source[key]]));
    return { before: pick(before), after: pick(after) };
  }
  return deepEqual(before, after) ? undefined : { before, after };
}
