# 0006: match builds to the PR head

## Status

Proposed

## Date

2026-10-21

## Context

A successful build may validate an older PR commit. Some repositories also use
source-branch pipelines, including manual runs while a PR is a draft. Restricting
inspection to PR merge builds hides those runs.

## Decision

Associate a build with a PR when its repository matches and either:

- Its reason is `pullRequest` and its branch is `refs/pull/N/merge` for that PR.
- Its branch is the PR source ref, `refs/heads/<source>`, with any reason.

A merge build validates the current version only when its `sourceVersion` equals
`lastMergeCommit.commitId`. A source-branch build validates it only when its
`sourceVersion` equals `lastMergeSourceCommit.commitId`. Keep the existing rule
that only active PRs have current builds. Label the two kinds `pr-merge` and
`branch-head` in output. Manual runs on the PR merge ref remain unsupported.

Require exactly one of `--build <id>` or `--latest` for `build show` and
`build wait`. Explicit IDs allow historical associated builds. `--latest` selects
the validating build with the newest queue time across both kinds. If none
validates the head, show prints the newest associated build marked stale with its
commit and exits 1. Wait fails with an error naming the head commit. If no
associated build exists, show also fails with that error.

Retry uses the same current-version rule and retains its existing status, result
and refresh checks. `build list` merges both kinds, newest first, each labelled, and
marks a build current by the same rule as `--latest`. The default view lists only
current builds and fails for inactive PRs; `--history` lists every associated build
and marks none current for an inactive PR.

## Consequences

Agents can distinguish current validation from stale results and inspect manual
source-branch runs on draft PRs. Latest selection and build listing need a second paged
build query without a reason filter. Both queries use the existing pagination limits.

Build selection uses the PR metadata read at command start. Waiting follows the
selected build ID; it does not switch builds when the PR changes. A branch-head
build validates the source commit, which may differ from the merged result.
