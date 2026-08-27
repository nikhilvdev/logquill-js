# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

- Phase 0 repo scaffolding: TypeScript (strict mode), `tsup` dual ESM+CJS+`.d.ts`
  build, `eslint` (flat config, type-checked, `no-explicit-any`) + `prettier`,
  `vitest` with coverage, and a CI workflow (`lint` → `typecheck` → `coverage` → `build`).
