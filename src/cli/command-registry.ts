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
  build policy evaluation; branch builds use the repository's build policy definition. Branch builds
  print the queued build ID and URL. PR builds print them when Azure returns the build ID, and
  otherwise print the requeued evaluation ID. Multiple matching policies are reported for manual
  resolution. A failed queue request may still have queued a build; inspect before trying again.

Pull request status:
  \`pr status\` reports the head and merge commits, the latest iteration, the draft state, the build
  validating the head (or a stale marker), the unresolved thread count, the merge status with
  conflicts, the blocking policies and the reviewer votes with required flags in one call. The
  "Blocked by" line lists blocking policies that are neither approved nor not applicable, or none.
  The build lookup needs Build (Read). The Copilot review line is best effort: it reports the newest
  PR timeline entry that mentions a Copilot review as requested or completed with its date, or none.
  Other wording, such as a cancellation, is shown as quoted text with its date. Copilot never votes,
  so reviewer votes do not show it. --json prints the same fields as one JSON document.

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
