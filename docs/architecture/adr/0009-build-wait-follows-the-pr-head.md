# 0009: build wait follows the PR head

## Status

Proposed

## Date

2026-11-17

## Context

[ADR 0006](0006-match-builds-to-the-pr-head.md) made `build wait --latest` select
the build that validates the PR head once, at the start, and follow that build ID.
Agents use the command after a push to learn whether the pull request's current
head passes. Two failures came out of that:

- Run right after a push, it failed at once with "No build validates PR #N head",
  because Azure queues the build a few seconds after the push.
- Run before a push, it kept waiting on the build for the old head until that
  build finished, so agents killed the wait and started another.

## Decision

With `--latest`, `build wait` waits for the build that validates the current PR
head:

- Each poll after the first reads the pull request again. When the source commit
  (`lastMergeSourceCommit`) changes, the wait drops the selected build and selects
  the newest build that validates the new head. A change of the merge commit alone,
  for example when the target branch moves, keeps the selected build.
- While no build validates the head, the wait keeps polling. After 10 minutes
  without one, counted from the last head change, it ends with outcome `no-build`
  and exit code 1, and the result's `buildId` is `null`. If `--timeout` ends first,
  the outcome is `timeout`.
- Progress on stderr names the selected build and the build it replaces.

`--build <id>` keeps waiting for that build. When that build no longer validates
the head of an active pull request at the end, the result marks it superseded and
names the newest build that validates the head. `build queue --pr` suggests a wait
with `--latest`, since the build it queued is the newest one for the head.
`build show --latest` still reports a stale build at once.

This supersedes two clauses of ADR 0006: that wait fails with an error naming the
head commit when no build validates it, and that waiting follows the selected build
ID and doesn't switch builds when the PR changes. The rest of ADR 0006 stands.

## Consequences

One wait started after a push covers later pushes too, and a wait started right
after a push no longer fails. Each poll with `--latest` costs one more GET, and a
poll without a selected build costs the two build list queries instead of the
build GET. The 10-minute wait has no flag. If Azure never queues a build for the
head, for example when a build policy skips draft pull requests, the agent learns
it only after those 10 minutes.
