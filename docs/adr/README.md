# Architecture decision records

This directory holds ado-pr's architecture decisions. Each record is one Markdown
file named `NNNN-kebab-title.md`, numbered in decision order. Use the
[template](template.md), with five sections: Status, Date, Context, Decision and
Consequences. No front matter is needed.

## When to write a record

Record decisions that change module responsibilities or dependencies, runtime or
CLI contracts, credential handling, or the quality gates contributors must follow.
Explain the constraint, choice and tradeoff. Test names, routine dependency bumps
and implementation details within an existing boundary belong in commits and code
review.

## Rules

- A record starts as Proposed. Once approved, its status becomes Accepted.
- Accepted records are immutable. Fixing a typo is fine; changing the decision
  requires a new record.
- If a whole decision changes, retain the old content and update only its Status
  to `Superseded by ADR NNNN`, linking the replacement.
- If only part changes, use `Partially superseded by ADR NNNN; all other decisions
  remain accepted.` The replacement must name the clauses it supersedes and link
  the old record.
- Add each record to the index and keep its status current.

## Index

| Record | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-organise-code-by-feature.md) | Organise code by feature with explicit dependency rules | Accepted |
| [0003](0003-keep-the-tool-small.md) | Keep the tool small and handle realistic failures | Accepted |
| [0004](0004-quality-gates.md) | Check quality with Biome and Fallow | Accepted |
| [0005](0005-run-typescript-directly.md) | Run TypeScript directly with Node type stripping | Accepted |
| [0006](0006-match-builds-to-the-pr-head.md) | Match builds to the PR head | Proposed |
| [0007](0007-report-pr-status-from-a-status-module.md) | Report PR status from a status module | Proposed |
