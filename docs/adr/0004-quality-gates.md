# 0004: check quality with Biome and Fallow

## Status

Accepted

## Date

2026-10-20

## Context

The CLI already uses node:test. The restructure needs checks for dependency
boundaries and maintainability without migrating tests. Full mutation runs take
too long for routine local checks.

## Decision

Use Biome for lint and formatting. Use Fallow for dead code, duplicates,
architecture boundaries and health, with a CRAP limit of 12 based on fresh V8
coverage from tests and CLI subprocesses.

Use `fallow mutation` with its native node:test runner rather than Stryker/Vitest,
so the tests do not need migration. PRs gate changed code against their base.
`pnpm mutation` does the same locally, defaulting to `origin/main` and accepting
`MUTATION_BASE`. The minimum score lives in the `mutation` script in
`package.json`. Raise it as coverage improves, aiming for at least 80; do not
lower it to pass changes. Full runs report the score
through `pnpm mutation:all` and are manual in CI via `workflow_dispatch`.

Run `pnpm check` before committing. It combines typechecking, Biome, tests and all
Fallow gates with fresh coverage. Mutation checks remain separate and optional
locally. GitHub Actions checks Node 22 and 24, lint, Fallow and PR mutations.

## Consequences

One runner supports ordinary tests, coverage and mutation checks. Changed-code
mutation gates keep PR validation focused; manual full runs reveal gaps outside
the diff. A minimum score still permits surviving mutants; it is a floor, not a
claim that every behaviour is tested.
