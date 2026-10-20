# 0002: organise code by feature with explicit dependency rules

## Status

Accepted

## Date

2026-10-20

## Context

PRs, review comments and validation builds have distinct responsibilities but share
Azure HTTP and Git context. Splitting by technical layer would scatter feature
changes and make dependencies harder to follow.

## Decision

Group source and adjacent `.test.mjs` tests under `src/pull-requests/`,
`src/comments/` and `src/builds/`. Put shared HTTP, Git, contracts and types in
`src/shared/`, CLI parsing/help in `src/cli/`, and composition in `src/pr.ts`.

Features may import shared code. Builds may also import pull requests for PR
resolution and association metadata. Only the CLI and entrypoint may wire
features together. Features cannot import the CLI; shared code cannot import
features. Fallow architecture boundary zones enforce these allowed dependencies,
including type-only imports.

## Consequences

Feature changes and their tests stay together. Shared test helpers and launcher
fixtures remain in `tests/`. New cross-feature dependencies require a deliberate
boundary change and a superseding record. The allowed graph is in the
[architecture document](../architecture.md).
