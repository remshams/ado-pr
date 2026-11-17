# 0008: follow the shared architecture-docs standard

## Status

Proposed

## Date

2026-11-17

## Context

ado-pr kept its architecture document in `docs/architecture.md`, a hand-written
HTML copy in `docs/architecture.html` and its ADRs in `docs/adr/`, as
[ADR 0001](0001-record-architecture-decisions.md) decided. The two formats had to
be kept in sync by hand, and the layout differed from the maintainer's other
projects. The `architecture-docs` skill now defines one layout for all of them:
a fixed section outline, Mermaid views with a shared vocabulary, a checker, and an
HTML page generated from the Markdown.

## Decision

Follow the `architecture-docs` standard:

- Keep the architecture document in `docs/architecture/architecture.md` and the
  ADRs in `docs/architecture/adr/`.
- Generate `docs/architecture/architecture.html` with the skill's `build.ts`. Don't
  edit it by hand.
- Use the standard's section outline and views, and run the skill's `check.ts`
  after each change to the document.

This supersedes the ADR location in ADR 0001, `docs/adr/`. The rest of ADR 0001,
including the record format and the immutability rules, stays in force.

## Consequences

Readers who know another project's architecture document find the same sections
and diagrams here. Only the Markdown is edited, so the HTML can't drift from it.
Building and checking the document needs the skill's dependencies and a Chromium
browser on the contributor's machine; `pnpm check` doesn't run the checker.
