# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Transports: `ConsoleTransport` (colorized via ANSI, respects `NO_COLOR`,
  writes via `console.log`/`console.error` so it works unmodified in a
  browser bundle), `FileTransport` (appends to a file, rotating to numbered
  backups `.1`, `.2`, … once it exceeds `maxBytes`), and `HTTPTransport`
  (batches formatted lines and POSTs them as newline-delimited JSON via
  `fetch` once `batchSize` is reached or on `.close()`/`.flush()`, with an
  injectable `sender` for tests or alternate backends). Each extends the
  `Transport` base class added in the previous entry. Unit tests per
  transport use `CollectingTransport` and fakes, matching `logquill-python`'s
  behavior (rotation scheme, batching, color routing) test-for-test.

- Core API: `Logger` (`.trace()/.debug()/.info()/.warn()/.error()/.fatal()`,
  `.child()`, `.use()`, `.setLevel()`), `Level`/`parseLevel`/`levelName`,
  `LogRecord`, `Formatter`/`JSONFormatter`, the `Plugin` hook interface
  (`beforeLog`/`afterLog`/`onError`), and the `Transport` base class with an
  in-memory `CollectingTransport` for tests. Record shape and level
  names/weights match the `logquill-python` contract byte-for-byte, verified
  by a schema cross-check test against a Python-produced sample record.

- Added `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `.github/CODEOWNERS`,
  `.github/PULL_REQUEST_TEMPLATE.md`, and `CONTRIBUTING.md` documenting the
  PR workflow (branch naming, scoping, review/CI requirements, squash-merge),
  synced with `logquill-python`.

- Added `.github/SECURITY.md`: supported-versions policy and instructions
  to report vulnerabilities via GitHub's private vulnerability reporting
  instead of public issues. Linked from the README.

- Added `.github/dependabot.yml`: weekly version updates for `npm`
  dependencies and GitHub Actions.

- Added GitHub issue templates: `.github/ISSUE_TEMPLATE/bug_report.yml`,
  `feature_request.yml`, and a `config.yml` that points security reports at
  private vulnerability reporting instead of a public issue.

## [0.1.1] - 2026-08-27

### Changed

- `release.yml` now triggers on every push to `main` (i.e. on PR merge)
  instead of on `v*` tags, publishing only when `package.json`'s `version`
  differs from what's live on npm.

## [0.1.0] - 2026-08-27

### Added

- MIT `LICENSE` file, README badges (CI, npm version, license), expanded
  `package.json` keywords/author, and GitHub repo description/topics for
  discoverability.

- Repo scaffolding: TypeScript (strict mode), `tsup` dual ESM+CJS+`.d.ts`
  build, `eslint` (flat config, type-checked, `no-explicit-any`) + `prettier`,
  `vitest` with coverage, and a CI workflow (`lint` → `typecheck` → `coverage` → `build`).
