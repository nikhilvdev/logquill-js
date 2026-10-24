// Copy-on-write: writers swap in a new Map, readers just read the current
// reference. With no rules set, `isEnabled` on the hot path is one size check.
let rules: ReadonlyMap<string, boolean> = new Map();

function setRule(name: string, enabled: boolean): void {
  if (typeof name !== "string") {
    throw new TypeError(
      `disable()/enable() take a logger name such as "mylib", got ${typeof name}`,
    );
  }
  rules = new Map(rules).set(name, enabled);
}

/**
 * Turns off every `Logger` whose name is `name` or nested under it (`"mylib"`
 * covers `"mylib"` and `"mylib.http"`, not `"mylib2"`), so its log calls become
 * no-ops. `disable("")` turns off everything.
 *
 * For libraries that use LogQuill internally: call it once at import so the
 * library is silent by default instead of polluting its host application's
 * logs, and let the application opt back in with `enable("mylib")`. The most
 * specific rule wins: `disable("mylib")` then `enable("mylib.http")` silences
 * mylib except `mylib.http`.
 */
export function disable(name = ""): void {
  setRule(name, false);
}

/** Undoes {@link disable} for `name` and everything nested under it. Rules combine as described there. */
export function enable(name = ""): void {
  setRule(name, true);
}

/** Whether a logger called `name` currently emits records: the most specific `enable()`/`disable()` rule covering it, or `true` if none does. */
export function isEnabled(name: string): boolean {
  if (rules.size === 0) return true;
  let candidate = name;
  for (;;) {
    const verdict = rules.get(candidate);
    if (verdict !== undefined) return verdict;
    if (candidate === "") return true;
    const dot = candidate.lastIndexOf(".");
    candidate = dot === -1 ? "" : candidate.slice(0, dot);
  }
}

/** Drops every rule. For tests. */
export function resetToggleRules(): void {
  rules = new Map();
}
