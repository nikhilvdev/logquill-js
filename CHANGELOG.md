# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Phase 0 repo scaffolding: TypeScript (strict mode), `tsup` dual ESM+CJS+`.d.ts`
  build, `eslint` (flat config, type-checked, `no-explicit-any`) + `prettier`,
  `vitest` with coverage, and a CI workflow (`lint` → `typecheck` → `coverage` → `build`).
