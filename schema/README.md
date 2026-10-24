# LogQuill record schema

`record.schema.json` (JSON Schema draft 2020-12) and `golden_records.json` are
copied from `logquill-python`'s `schema/` directory, where they are authored.
Both packages run their tests against them; that is what keeps the two writing
the same record shape. Edit them there first, then re-copy here in the same
release cycle (`test/contract.test.ts` fails if this copy and the version this
package writes drift apart).

`golden_chain.json` is a hash chain written by `logquill-python`'s `TamperEvidentPlugin`
over awkward values (non-ASCII, control characters, small floats, an `llm` block).
Both packages verify it, which is what proves they hash the same canonical JSON.

Field names in `meta` are snake_case (`run_id`, `span_id`, `duration_ms`) on
the wire, in both languages. This package's JS API options stay camelCase
(`llmCall({ tokensIn })`, `span(name, fn, { spanId })`).
