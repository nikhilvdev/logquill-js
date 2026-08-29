# Contributing

Thanks for considering a contribution to `logquill`. This project also
follows a [Code of Conduct](CODE_OF_CONDUCT.md) — participation in issues,
PRs, and discussions means agreeing to abide by it.

## Setup

```bash
npm install

npm run lint
npm run typecheck
npm run coverage
npm run build
```

## Pull request strategy

- **Branch from `main`**, name branches by intent: `feat/…`, `fix/…`,
  `docs/…`, `chore/…` (e.g. `feat/rotating-file-transport`).
- **Keep PRs scoped to one concern** where possible. A PR that mixes an
  unrelated refactor with a feature is harder to review and harder to revert.
- **Every PR must satisfy this definition of done** before it's ready for
  review:
  1. Full TypeScript strict-mode coverage — no `any` in the public API
  2. Unit tests cover the new surface; existing tests still pass
  3. Public API additions documented in the README with a runnable example
  4. `CHANGELOG.md` has an entry under `Unreleased`
  5. Nothing in the cross-language contract table silently diverged from `logquill-python`
     (open a tracking issue there if it changed)
- **CI must be green** (`eslint`, `tsc --noEmit`, `vitest run --coverage`,
  `npm run build`) and **at least one review approval** is required before
  merge — enforced by branch protection on `main`.
- **Squash-merge** into `main` — keep the squash commit message a clear
  summary of the change; per-commit history within a PR branch doesn't need
  to be clean.
- Commit messages and PR titles: imperative mood, e.g. "Add rotating file
  transport" not "Added" or "Adds".

## Reporting issues

Bug reports and feature requests are welcome via GitHub issues.
