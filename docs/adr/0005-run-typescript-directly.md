# 0005: run TypeScript directly with Node type stripping

## Status

Accepted

## Date

2026-10-20

## Context

The initial launcher already used native TypeScript execution to avoid ts-node or
a build step. It keeps its own source and dependencies beside `pr.sh` while running
against the caller's Azure Repos checkout. The restructure retains this model.

## Decision

Run source directly with Node >= 22.6 and `--experimental-strip-types`. Use ESM
with explicit `.ts` imports and `tsc --noEmit` for separate typechecking. Do not
add a transpilation or bundling step. The launcher resolves its own `src/pr.ts`
path and preserves the caller's working directory.

## Consequences

There are no generated JavaScript artifacts to build or keep current. Runtime
execution does not typecheck, so contributors must run the separate checks.
Source must stay compatible with Node type stripping, and callers need the
supported Node version plus the CLI's installed dependencies.
