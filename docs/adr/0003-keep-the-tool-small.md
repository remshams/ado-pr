# 0003: keep the tool small and handle realistic failures

## Status

Accepted

## Date

2026-10-20

## Context

ado-pr is a CLI for developers' coding agents. It needs predictable commands and
useful errors, while speculative edge cases and race recovery can add more code
than the workflow warrants.

## Decision

Keep the implementation small and simple. Split by feature where that helps.
Handle realistic failure modes; do not add speculative edge-case or race-condition
hardening. Add recovery behavior when the actual workflow justifies it.

The quality bar stays the same: correct behavior, clear errors, tests and the
[required checks](0004-quality-gates.md).

## Consequences

Changes need a concrete failure or user workflow to justify added complexity.
Some uncommon failures can stop with an actionable error. Simplicity does not
justify skipping validation or removing handling for known failures.
