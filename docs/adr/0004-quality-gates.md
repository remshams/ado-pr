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
coverage from tests and CLI subprocesses. The current health baseline identifies
existing functions awaiting refactoring; do not add entries.

Use `fallow mutation` with its native node:test runner rather than Stryker/Vitest,
so the tests do not need migration. PRs gate changed code against their base.
`pnpm mutation` does the same locally, defaulting to `origin/main` and accepting
`MUTATION_BASE`. Keep the minimum score at 71 for now and raise it toward 80 as
coverage improves; do not lower it to pass changes. Full runs report the score
through `pnpm mutation:all` and are manual in CI via `workflow_dispatch`.

Run `pnpm check` before committing. It combines typechecking, Biome, tests and all
Fallow gates with fresh coverage. Mutation checks remain separate and optional
locally. GitHub Actions checks Node 22 and 24, lint, Fallow and PR mutations.

## Consequences

One runner supports ordinary tests, coverage and mutation checks. Changed-code
mutation gates keep PR validation focused; manual full runs reveal gaps outside
the diff. A score of 71 permits surviving mutants, so 80 remains a target, not a
claim about current test strength. Existing health exceptions remain visible
until refactored.
