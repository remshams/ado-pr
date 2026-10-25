# 0007: report PR status from a status module

## Status

Proposed

## Date

2026-10-25

## Context

An agent checking whether a pull request is ready needs the head commit, the build
that validates it, the merge state, the unresolved review threads and the reviewer
votes. Each lives behind a different module. The builds module already depends on
pull requests, and the comments module depends on neither. Letting one of them
import the others would couple modules that are independent today.

Copilot never votes and never re-reviews on push. Azure records its activity only
as system comments in the PR timeline, for example "Copilot balanced review
requested by branch policy." and "Copilot code review completed". We could not
check these wordings against a live Azure DevOps organisation.

## Decision

Add `src/status/` as an application service for `pr status`. It may depend on
shared code, pull requests, comments and builds. Only the entrypoint wires it.
Those modules expose the lookups it needs: the build validating the PR head under
[ADR 0006](0006-match-builds-to-the-pr-head.md), the policy evaluations that
`build queue --pr` already reads, all threads including system comments, an
unresolved thread count and a reviewer summary with vote and required flag. The
builds module decides whether an evaluation is satisfied, so Azure's policy status
words stay inside it.

The status report lists the head and merge commits, the latest iteration, the draft
state, the validating build or a stale marker, the Copilot review activity, the
unresolved thread count, the merge status with conflicts, the blocking policies
that are not satisfied and the reviewers with their votes and required flags.
`pr status --json` prints the same report as one JSON document made of domain
values, not raw Azure objects. It makes its requests one after another, so the
call count stays small and the mocked responses stay deterministic.

Copilot activity is the newest system comment that mentions a Copilot review,
reported as `completed` or `requested` with its date, or `none`. Any other wording,
such as a cancellation, still counts as the newest entry and is reported as its
quoted text with the date, so an older request is never shown as pending. One small
function in `src/status/` owns this matching, and the help marks the line as best
effort. A fix after live testing stays in that function. There is no iteration
matching and no separate count of Copilot threads, because its review threads
already count as unresolved threads.

The service reads `/conflicts` only when `mergeStatus` is `conflicts`. If that
request fails, the report still shows the merge status and says the conflicts could
not be listed. The iteration and policy lookups are best effort in the same way: a
failure leaves the iteration unknown or says the policies could not be listed.

## Consequences

Agents see the PR state in one call. The feature modules stay independent of each
other, at the cost of a fifth module and a zone in `.fallowrc.json`.

The Copilot line may be wrong if Azure words these entries differently, and it
reports `none` when Copilot activity is not recorded as a system comment. The
conflicts endpoint is a preview API in Azure DevOps 7.1 and has not been tried
against a real organisation. Reading the build needs a PAT with Build (Read), so a
Code-only PAT cannot use `pr status`. Policy evaluations come from the builds
module, which already reads them for `build queue --pr`; `pr status --json` prints
the same report as a JSON document.
