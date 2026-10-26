import {
	BATCH_COMMANDS,
	BATCH_FIELD_DEFINITIONS,
	type BatchCommand,
	COMMAND_IDS,
	COMMAND_REGISTRY,
	FLAG_DEFINITIONS,
	getBatchFields,
} from "../shared/command-contracts.ts";

function formatBatchShape(command: BatchCommand): string {
	const fields = getBatchFields(command).map((field) => {
		if (field === "command") {
			return `"command":"${command}"`;
		}
		const definition = BATCH_FIELD_DEFINITIONS[field];
		return `"${field}"${definition.required ? "" : "?"}:${definition.example}`;
	});
	return `{${fields.join(",")}}`;
}

function formatHelpRows(
	rows: readonly (readonly [string, string])[],
	minimumWidth = 0,
): string {
	const width = Math.max(
		minimumWidth,
		...rows.map(([label]) => label.length + 2),
	);
	return rows
		.map(([label, description]) => `  ${label.padEnd(width)}${description}`)
		.join("\n");
}

export function formatHelp(): string {
	const commands = COMMAND_IDS.map((id) => COMMAND_REGISTRY[id]);
	const usage = commands
		.map(
			(definition, index) =>
				`${index === 0 ? "Usage:" : "      "} pr.sh ${definition.usage}`,
		)
		.join("\n");
	const commandList = formatHelpRows(
		commands.map((definition): [string, string] => [
			`${definition.resource} ${definition.command}`,
			definition.summary,
		]),
		25,
	);
	const batchShapes = BATCH_COMMANDS.map(
		(command) => `    ${formatBatchShape(command)}`,
	).join("\n");
	const options = formatHelpRows(
		Object.values(FLAG_DEFINITIONS).map((definition): [string, string] => [
			definition.usage,
			definition.description,
		]),
	);

	return `${usage}

Commands:
${commandList}

Batch input:
  Each array element must have exactly one of these shapes (fields marked ? are optional):
${batchShapes}
  Per-operation "pr" overrides the command's --pr/default PR for that operation. Unknown fields and
  fields irrelevant to the selected command are invalid. Operations execute sequentially in array
  order. A failed operation is reported and later operations still run; after all operations finish,
  the process exits nonzero if any operation failed.

Options:
${options}

Pull request diff:
  \`pr diff\` prints a unified diff read from Azure DevOps. The first line names the latest iteration
  and what it is compared with: the merge base, or the iteration given with --since-iteration.
  Binary files are listed without content. Output stops after 100,000 bytes and ends with a
  notice naming where it was cut.
  --since-last-review is a heuristic. It compares with the latest iteration created before your
  newest comment or vote. Votes come from the system entries Azure posts in the PR threads, such
  as "<name> voted 10". It fails when you have no such activity or no iteration predates it; pass
  --since-iteration then. It cannot be combined with --since-iteration.
  --name-only prints only one line per file: the change, a tab and the path, with
  "<original> -> <path>" for renames. Changes are add, edit, delete or rename. It reads no content.
  A path with control or bidi characters is quoted, with those characters as \\uXXXX escapes.
  --json prints {pullRequestId, iteration, baseIteration, lastReview, files, truncated}.
  baseIteration is null for the merge base; lastReview is the --since-last-review cutoff or null.
  Each file has path, originalPath, change, content and blocks. content is text, binary, none (a
  pure rename) or omitted (did not fit the 100,000-byte limit, which sets truncated). Each block
  has originalStart, originalCount, modifiedStart, modifiedCount and the removed and added lines;
  an empty side starts at the line the change comes before. With --name-only, files have only
  path, originalPath and change. The limit covers the printed JSON, but every file is listed, so
  a pull request with thousands of files can exceed it.

Comment attachments:
  \`comment create\` and \`comment reply\` accept one --attachment. Azure DevOps has no comment
  attachments, so the file is uploaded as a pull request attachment (like \`pr attach\`) and its
  Markdown link is added to the comment after a blank line. If posting fails after the upload,
  the error includes the link so it can be reused instead of uploading again.

Pull request completion:
  \`pr complete\` reads the PR and completes it at the head commit it just read. Check \`pr status\`
  first. --merge-strategy is required, because Azure DevOps does not apply the repository default
  when no strategy is sent. Completion options set earlier, for example in the web UI, are kept,
  and the flags given replace only their own options. Azure may still be merging when the command
  returns; it then says so and exits 0. A merge that fails afterwards with conflicts, a policy
  rejection or another failure prints Azure's reason and exits 1. --auto only sets auto-complete
  for the authenticated user. Azure then completes the PR once the required policies pass, at
  whatever head passes them, including later pushes. There is no pre-check. When Azure rejects
  the request, the command prints Azure's message and suggests \`pr status\`. After a timeout, a
  network failure or a 5xx response the request may have been applied, so check \`pr status\`
  before retrying.

Build selection:
  \`build show\` and \`build wait\` require exactly one of --build <id> or --latest.
  --latest selects the newest build by queue time that validates the current PR head. It checks
  pullRequest runs on the PR merge ref against lastMergeCommit and runs of any reason on the PR
  source branch against lastMergeSourceCommit. Output labels them pr-merge or branch-head.
  Manual runs on the PR merge ref are unsupported. If no build validates the head, show prints
  the newest associated build marked stale with its commit and exits 1; wait fails naming the head.
  --build accepts current or historical associated builds.

Build list:
  \`build list\` merges PR merge runs and source-branch runs, newest first, each labelled pr-merge or
  branch-head. Builds validating the current PR head are marked current (same rule as --latest). The
  default view shows only those and fails for inactive PRs; --history shows every associated build
  and marks none current for an inactive PR. An empty default view reports how many stale builds it
  hides. --json adds association and current to each build and hiddenBuilds to the result.

Build wait:
  \`build wait\` monitors validation metadata for the selected build. --pr only selects or resolves
  the associated pull request. After bounded PR resolution, polling runs every 60 seconds for up to
  1 hour by default; --interval accepts 10–3600 seconds and --timeout accepts 10–86400 seconds.
  Five-minute heartbeats and progress go to stderr. Completed and timed-out waits emit one final
  human or pretty JSON result to stdout; operational failures and signals emit none. JSON includes
  the selected PR summary, requested build ID, raw Azure build metadata (or null before
  observation), counters, elapsed polling time, timeout state, and outcome; inspect raw metadata
  before persisting it.
  Exit codes are 0 for succeeded, 124 for timeout, 1 for other outcomes/errors, 130 for SIGINT, and
  143 for SIGTERM. Transient poll requests retry, but a third consecutive transient failure aborts.
  Waiting never retries/requeues the build, fetches logs, retries individual work, or mutates builds;
  use \`build show\` afterward for diagnostics.

Build queue:
  \`build queue\` requires exactly one of --pr <id> or --branch <name>. PR builds requeue the PR's
  build policy evaluation; branch builds use the build pipeline of the repository's build policy.
  Both print the queued build ID, build pipeline and URL. A PR requeue may not return the build ID;
  it then prints the requeued evaluation ID and how to find the new build. Queued builds print a
  ready-to-run \`build wait\` line; a branch build gets one only when the branch has an active pull
  request, because \`build wait\` needs one. --definition <id> picks the build pipeline. With --pr
  it selects the build policy evaluation for that build pipeline and fails, listing the candidates,
  when none matches; it never queues a plain build. With --branch it queues that build pipeline
  directly, even when the repository has no build policy. Without it, several matching policies or
  evaluations are reported for manual resolution. A 401, 403, 400 or 404 means nothing was queued;
  401 and 403 name the Build (Read & execute) scope. Any other failed queue request may still have
  queued a build; inspect before trying again.

Pull request status:
  \`pr status\` reports the head and merge commits, the latest iteration, the draft state, the build
  validating the head (or a stale marker), the unresolved thread count, the merge status with
  conflicts, the blocking policies and the reviewer votes with required flags in one call. The
  "Blocked by" line lists blocking policies that are neither approved nor not applicable, or none.
  The build lookup needs Build (Read). The Copilot review line is best effort: it reports the newest
  PR timeline entry that mentions a Copilot review as requested or completed with its date, or none.
  Other wording, such as a cancellation, is shown as quoted text with its date. Copilot never votes,
  so reviewer votes do not show it. --json prints the same fields as one JSON document.

Pull request votes and status:
  \`pr vote\` sets your vote with PUT to the reviewers endpoint and adds you as a reviewer if you are
  not one yet. \`pr abandon\` and \`pr reactivate\` set the pull request status to abandoned or active.
  Abandoned pull requests are not found from the current branch, so \`pr reactivate\` requires
  --pr <id>. If Azure rejects a request, for example when reactivating a completed pull request,
  the error includes Azure's status and message.

Requires:
  - A git checkout whose origin remote points at Azure Repos.
  - AZURE_DEVOPS_PAT exported by the caller or set in .env.
  - PAT Code (Read & Write) for PR/comment mutations; Code (Read) is sufficient for build commands.
  - Build (Read), also named vso.build, for build queries; Build (Read & execute), also named
    vso.build_execute, for build retries and queueing. The policy evaluation requeue scope has not
    been verified with a real PAT.
  - Build commands support YAML and classic Build API validation runs, not Releases, external status
    checks, or individual stage/job/task retries.
  - Identity (Read), also named vso.identity, only for --reviewer additions on pr create/edit.
    --remove-reviewer resolves current PR reviewers and needs only Code (Read & Write).

Image notes:
  Every --image path needs a matching {{image:<basename>}} in the effective description, and every
  such placeholder needs a corresponding --image. Existing attachment displayName collisions are
  rejected before upload using case-sensitive filename matching; replacement is not supported.
  Upload failures before the description update trigger best-effort cleanup of new attachments. If
  the final update fails, its outcome is uncertain, so uploads are retained and may be orphaned.
  Generated image Markdown has an adjacent invisible ownership marker. Keep the marker unchanged for
  automatic reference removal. If it is edited or removed, attachment deletion retains the custom
  reference, which may then be broken.`;
}
