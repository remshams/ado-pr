import assert from "node:assert/strict";
import test from "node:test";
import {
	BATCH_COMMANDS,
	BATCH_FIELD_DEFINITIONS,
	COMMAND_IDS,
	COMMAND_REGISTRY,
	FLAG_DEFINITIONS,
	getBatchFields,
	getCommandDefinition,
	REPEATABLE_STRING_FLAG_NAMES,
} from "../shared/command-contracts.ts";
import { formatHelp } from "./command-registry.ts";

test("registry keys, routes, and command-local schemas stay coherent", () => {
	for (const id of COMMAND_IDS) {
		const definition = COMMAND_REGISTRY[id];
		assert.equal(id, `${definition.resource}.${definition.command}`);
		assert.equal(
			getCommandDefinition(definition.resource, definition.command),
			definition,
		);

		for (const flag of definition.flags) {
			assert.ok(
				Object.hasOwn(FLAG_DEFINITIONS, flag),
				`${id} references unknown flag ${flag}`,
			);
		}
		for (const required of definition.requiredFlags ?? []) {
			assert.ok(
				definition.flags.includes(required),
				`${id} requires disallowed flag ${required}`,
			);
		}
	}
});

test("registers resource-first build routes and keeps them out of batch schemas", () => {
	assert.deepEqual(COMMAND_REGISTRY["build.list"].flags, [
		"pr",
		"history",
		"json",
	]);
	assert.deepEqual(COMMAND_REGISTRY["build.show"].validationRules, [
		"buildSelection",
	]);
	assert.deepEqual(COMMAND_REGISTRY["build.retry"].requiredFlags, ["build"]);
	assert.deepEqual(COMMAND_REGISTRY["build.wait"].flags, [
		"build",
		"latest",
		"pr",
		"interval",
		"timeout",
		"json",
	]);
	assert.deepEqual(COMMAND_REGISTRY["build.wait"].validationRules, [
		"buildSelection",
		"buildWaitBounds",
	]);
	assert.equal(
		COMMAND_REGISTRY["build.wait"].usage,
		"build wait (--build <id> | --latest) [--pr <id>] [--interval <seconds>] [--timeout <seconds>] [--json]",
	);
	assert.ok(!BATCH_COMMANDS.some((command) => command.startsWith("build.")));
	assert.equal(FLAG_DEFINITIONS.build.kind, "positiveInteger");
	assert.equal(FLAG_DEFINITIONS.history.kind, "boolean");
	assert.equal(FLAG_DEFINITIONS["full-logs"].kind, "boolean");
});

test("only image and reviewer mutation flags are repeatable strings", () => {
	assert.deepEqual(REPEATABLE_STRING_FLAG_NAMES, [
		"image",
		"remove-image",
		"reviewer",
		"remove-reviewer",
	]);
	assert.equal(FLAG_DEFINITIONS.image.kind, "repeatableString");
	assert.ok(COMMAND_REGISTRY["pr.create"].flags.includes("image"));
	assert.ok(COMMAND_REGISTRY["pr.create"].flags.includes("reviewer"));
	assert.ok(!COMMAND_REGISTRY["pr.create"].flags.includes("remove-image"));
	assert.ok(COMMAND_REGISTRY["pr.edit"].flags.includes("remove-image"));
	assert.ok(COMMAND_REGISTRY["pr.edit"].flags.includes("remove-reviewer"));
});

test("batch schemas contain only registered fields and identify their command", () => {
	for (const command of BATCH_COMMANDS) {
		const fields = getBatchFields(command);
		assert.equal(fields[0], "command");
		assert.equal(
			new Set(fields).size,
			fields.length,
			`${command} contains duplicate batch fields`,
		);
		for (const field of fields) {
			assert.ok(
				Object.hasOwn(BATCH_FIELD_DEFINITIONS, field),
				`${command} references unknown batch field ${field}`,
			);
		}
	}
});

test("help is generated from every registered command and batch schema", () => {
	const help = formatHelp();
	for (const id of COMMAND_IDS) {
		const definition = COMMAND_REGISTRY[id];
		assert.ok(help.includes(`pr.sh ${definition.usage}`));
		assert.ok(help.includes(definition.summary));
	}
	for (const command of BATCH_COMMANDS) {
		assert.ok(help.includes(`"command":"${command}"`));
	}

	const optionWidth =
		Math.max(
			...Object.values(FLAG_DEFINITIONS).map(
				(definition) => definition.usage.length,
			),
		) + 2;
	for (const definition of Object.values(FLAG_DEFINITIONS)) {
		assert.ok(
			help
				.split("\n")
				.includes(
					`  ${definition.usage.padEnd(optionWidth)}${definition.description}`,
				),
			`help does not clearly separate ${definition.usage} from its description`,
		);
	}

	assert.match(
		help,
		/Identity \(Read\), also named vso\.identity, only for --reviewer additions on pr create\/edit\./,
	);
	assert.match(
		help,
		/--remove-reviewer resolves current PR reviewers and needs only Code \(Read & Write\)\./,
	);
	assert.match(help, /--build accepts current or historical associated builds/);
	assert.match(
		help,
		/--pr only selects or resolves\s+the associated pull request/,
	);
	assert.match(help, /polling runs every 60 seconds for up to\s+1 hour/);
	assert.match(help, /10–3600 seconds/);
	assert.match(help, /10–86400 seconds/);
	assert.match(help, /operational failures and signals emit none/);
	assert.match(help, /raw Azure build metadata/);
	assert.match(help, /130 for SIGINT[\s\S]*143 for SIGTERM/);
	assert.match(help, /Transient poll requests retry/);
	assert.match(help, /never retries\/requeues the build/);
});

test("help preserves the documented commands, options, and output layout", () => {
	assert.equal(
		formatHelp(),
		[
			"Usage: pr.sh pr list [--reviewing | --all] [--target <branch>] [--json]",
			"       pr.sh pr show [--pr <id>] [--json]",
			"       pr.sh pr status [--pr <id>] [--json]",
			"       pr.sh pr diff [--pr <id>] [--since-iteration <n> | --since-last-review] [--name-only] [--json]",
			'       pr.sh pr create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft] [--image <path>]... [--reviewer <email-or-display-name>]...',
			'       pr.sh pr edit [--description "..."] [--draft | --no-draft] [--image <path>]... [--remove-image <filename>]... [--reviewer <email-or-display-name>]... [--remove-reviewer <email-or-display-name>]... [--pr <id>]',
			"       pr.sh pr attach <path> [--name <file name>] [--pr <id>]",
			"       pr.sh build list [--pr <id>] [--history] [--json]",
			"       pr.sh build show (--build <id> | --latest) [--pr <id>] [--full-logs] [--json]",
			"       pr.sh build retry --build <id> [--pr <id>]",
			"       pr.sh build queue (--pr <id> | --branch <name>)",
			"       pr.sh build wait (--build <id> | --latest) [--pr <id>] [--interval <seconds>] [--timeout <seconds>] [--json]",
			"       pr.sh comment list [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]",
			'       pr.sh comment create --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]',
			'       pr.sh comment reply --thread <id> --message "..." [--pr <id>] [--status fixed|wontFix|byDesign|closed]',
			'       pr.sh comment edit --thread <id> --comment <id> --message "..." [--pr <id>]',
			"       pr.sh comment delete --thread <id> --comment <id> [--pr <id>]",
			"       pr.sh comment resolve --thread <id> [--pr <id>] [--status fixed|wontFix|byDesign|closed]",
			"       pr.sh comment reopen --thread <id> [--pr <id>]",
			"       pr.sh comment batch [--pr <id>] < operations.json",
			"",
			"Commands:",
			"  pr list                  List active pull requests with optional review and target filters.",
			"  pr show                  Show pull request details. Use --json for raw data.",
			"  pr status                Show head and merge commit, iteration, draft state, validating build, Copilot review, unresolved threads, merge state, blocking policies and votes.",
			"  pr diff                  Print the pull request diff from Azure DevOps as a unified diff, changed paths or JSON.",
			"  pr create                Create a pull request, optionally uploading images and adding reviewers.",
			"  pr edit                  Change PR fields, images, and/or reviewers.",
			"  pr attach                Upload any file as a pull request attachment.",
			"  build list               List PR-associated Azure Pipelines validation builds.",
			"  build show               Inspect a PR validation build, timeline, issues, and diagnostic logs.",
			"  build retry              Retry an eligible failed PR validation build at the whole-build level.",
			"  build queue              Queue a validation build for a pull request or branch.",
			"  build wait               Wait for a PR validation build to reach a terminal outcome without mutating it.",
			"  comment list             List comment threads, optionally filtering or printing JSON.",
			"  comment create           Create a general or file-anchored comment thread.",
			"  comment reply            Reply to an existing thread, optionally setting its status.",
			"  comment edit             Edit an existing comment.",
			"  comment delete           Delete an existing comment.",
			"  comment resolve          Mark an existing thread as resolved.",
			"  comment reopen           Reopen an existing thread.",
			"  comment batch            Run comment operations from a JSON array read from stdin.",
			"",
			"Batch input:",
			"  Each array element must have exactly one of these shapes (fields marked ? are optional):",
			'    {"command":"comment.create","message":"...","pr"?:n,"file"?:"...","line"?:n,"endLine"?:n}',
			'    {"command":"comment.reply","thread":n,"message":"...","pr"?:n,"status"?:"fixed"}',
			'    {"command":"comment.edit","thread":n,"comment":n,"message":"...","pr"?:n}',
			'    {"command":"comment.delete","thread":n,"comment":n,"pr"?:n}',
			'    {"command":"comment.resolve","thread":n,"pr"?:n,"status"?:"fixed"}',
			'    {"command":"comment.reopen","thread":n,"pr"?:n}',
			'  Per-operation "pr" overrides the command\'s --pr/default PR for that operation. Unknown fields and',
			"  fields irrelevant to the selected command are invalid. Operations execute sequentially in array",
			"  order. A failed operation is reported and later operations still run; after all operations finish,",
			"  the process exits nonzero if any operation failed.",
			"",
			"Options:",
			"  --pr <id>                                  Use a specific pull request instead of the current branch's active PR.",
			"  --build <id>                               Build ID. Required for `build retry`; choose --build or --latest for show/wait.",
			"  --branch <name>                            Queue a validation build for this source branch.",
			"  --latest                                   Select the newest build validating the PR head by queue time.",
			"  --since-iteration <n>                      Show only what changed since this pull request iteration; `pr diff` only.",
			"  --since-last-review                        Heuristic: show what changed since your last comment or vote; `pr diff` only.",
			"  --name-only                                List changed paths with their change type and no content; `pr diff` only.",
			"  --reviewing                                List active pull requests assigned to you for review.",
			"  --all                                      List all active pull requests in the repository.",
			"  --interval <seconds>                       Polling interval for `build wait` (default 60 seconds; range 10–3600).",
			"  --timeout <seconds>                        Maximum polling time after PR resolution for `build wait` (default 3600 seconds/1 hour; range 10–86400).",
			"  --title <text>                             Pull request title (required for `pr create`).",
			"  --description <text>                       Pull request description (maximum 4,000 characters). Empty clears it.",
			"  --image <path>                             Upload an image for a matching {{image:<filename>}} description placeholder.",
			"  --name <file name>                         Attachment filename used by `pr attach` (defaults to the path basename).",
			"  --remove-image <filename>                  Remove an attachment and its exact generated Markdown references; `pr edit` only.",
			"  --reviewer <email-or-display-name>         Add a uniquely resolved active reviewer. Repeat to add multiple reviewers.",
			"  --remove-reviewer <email-or-display-name>  Remove a uniquely resolved reviewer; valid only for `pr edit`.",
			"  --source <branch>                          Source branch for `pr create` (defaults to the current branch).",
			"  --target <branch>                          Target branch for `pr create`, or filter `pr list` by target branch.",
			"  --draft                                    Create a draft PR or mark an existing PR as draft.",
			"  --no-draft                                 Mark an existing PR as ready; valid only for `pr edit`.",
			"  --thread <id>                              Thread ID for reply/edit/delete/resolve/reopen.",
			"  --status <status>                          Thread status for `comment resolve` (default fixed) or `comment reply`: fixed, wontFix, byDesign, closed (case-insensitive).",
			"  --comment <id>                             Comment ID for edit/delete.",
			"  --message <text>                           Comment text for create/reply/edit.",
			"  --file <path>                              Anchor a new comment thread to a repository-relative file.",
			"  --line <n>                                 Anchor to a line in --file. Requires --file.",
			"  --end-line <n>                             End an anchored range. Requires --line and must be >= --line.",
			"  --exclude-own                              Hide threads where the current identity is the only commenter.",
			"  --exclude-resolved                         Hide resolved threads.",
			"  --history                                  Include historical PR validation builds instead of only the current merge version.",
			"  --full-logs                                Fetch complete potentially sensitive problem logs instead of the final 200 lines.",
			"  --json                                     Print normalized build output, the PR status document and PR diffs, or raw JSON for PR/comment list and PR show.",
			"  -h, --help                                 Show this help.",
			"",
			"Pull request diff:",
			"  `pr diff` prints a unified diff read from Azure DevOps. The first line names the latest iteration",
			"  and what it is compared with: the merge base, or the iteration given with --since-iteration.",
			"  Binary files are listed without content. Output stops after 100,000 bytes and ends with a",
			"  notice naming where it was cut.",
			"  --since-last-review is a heuristic. It compares with the latest iteration created before your",
			"  newest comment or vote. Votes come from the system entries Azure posts in the PR threads, such",
			'  as "<name> voted 10". It fails when you have no such activity or no iteration predates it; pass',
			"  --since-iteration then. It cannot be combined with --since-iteration.",
			"  --name-only prints only one line per file: the change, a tab and the path, with",
			'  "<original> -> <path>" for renames. Changes are add, edit, delete or rename. It reads no content.',
			"  A path with control or bidi characters is quoted, with those characters as \\uXXXX escapes.",
			"  --json prints {pullRequestId, iteration, baseIteration, lastReview, files, truncated}.",
			"  baseIteration is null for the merge base; lastReview is the --since-last-review cutoff or null.",
			"  Each file has path, originalPath, change, content and blocks. content is text, binary, none (a",
			"  pure rename) or omitted (did not fit the 100,000-byte limit, which sets truncated). Each block",
			"  has originalStart, originalCount, modifiedStart, modifiedCount and the removed and added lines;",
			"  an empty side starts at the line the change comes before. With --name-only, files have only",
			"  path, originalPath and change. The limit covers the printed JSON, but every file is listed, so",
			"  a pull request with thousands of files can exceed it.",
			"",
			"Build selection:",
			"  `build show` and `build wait` require exactly one of --build <id> or --latest.",
			"  --latest selects the newest build by queue time that validates the current PR head. It checks",
			"  pullRequest runs on the PR merge ref against lastMergeCommit and runs of any reason on the PR",
			"  source branch against lastMergeSourceCommit. Output labels them pr-merge or branch-head.",
			"  Manual runs on the PR merge ref are unsupported. If no build validates the head, show prints",
			"  the newest associated build marked stale with its commit and exits 1; wait fails naming the head.",
			"  --build accepts current or historical associated builds.",
			"",
			"Build list:",
			"  `build list` merges PR merge runs and source-branch runs, newest first, each labelled pr-merge or",
			"  branch-head. Builds validating the current PR head are marked current (same rule as --latest). The",
			"  default view shows only those and fails for inactive PRs; --history shows every associated build",
			"  and marks none current for an inactive PR. An empty default view reports how many stale builds it",
			"  hides. --json adds association and current to each build and hiddenBuilds to the result.",
			"",
			"Build wait:",
			"  `build wait` monitors validation metadata for the selected build. --pr only selects or resolves",
			"  the associated pull request. After bounded PR resolution, polling runs every 60 seconds for up to",
			"  1 hour by default; --interval accepts 10–3600 seconds and --timeout accepts 10–86400 seconds.",
			"  Five-minute heartbeats and progress go to stderr. Completed and timed-out waits emit one final",
			"  human or pretty JSON result to stdout; operational failures and signals emit none. JSON includes",
			"  the selected PR summary, requested build ID, raw Azure build metadata (or null before",
			"  observation), counters, elapsed polling time, timeout state, and outcome; inspect raw metadata",
			"  before persisting it.",
			"  Exit codes are 0 for succeeded, 124 for timeout, 1 for other outcomes/errors, 130 for SIGINT, and",
			"  143 for SIGTERM. Transient poll requests retry, but a third consecutive transient failure aborts.",
			"  Waiting never retries/requeues the build, fetches logs, retries individual work, or mutates builds;",
			"  use `build show` afterward for diagnostics.",
			"",
			"Build queue:",
			"  `build queue` requires exactly one of --pr <id> or --branch <name>. PR builds requeue the PR's",
			"  build policy evaluation; branch builds use the repository's build policy definition. Branch builds",
			"  print the queued build ID and URL. PR builds print them when Azure returns the build ID, and",
			"  otherwise print the requeued evaluation ID. Multiple matching policies are reported for manual",
			"  resolution. A failed queue request may still have queued a build; inspect before trying again.",
			"",
			"Pull request status:",
			"  `pr status` reports the head and merge commits, the latest iteration, the draft state, the build",
			"  validating the head (or a stale marker), the unresolved thread count, the merge status with",
			"  conflicts, the blocking policies and the reviewer votes with required flags in one call. The",
			'  "Blocked by" line lists blocking policies that are neither approved nor not applicable, or none.',
			"  The build lookup needs Build (Read). The Copilot review line is best effort: it reports the newest",
			"  PR timeline entry that mentions a Copilot review as requested or completed with its date, or none.",
			"  Other wording, such as a cancellation, is shown as quoted text with its date. Copilot never votes,",
			"  so reviewer votes do not show it. --json prints the same fields as one JSON document.",
			"",
			"Requires:",
			"  - A git checkout whose origin remote points at Azure Repos.",
			"  - AZURE_DEVOPS_PAT exported by the caller or set in .env.",
			"  - PAT Code (Read & Write) for PR/comment mutations; Code (Read) is sufficient for build commands.",
			"  - Build (Read), also named vso.build, for build queries; Build (Read & execute), also named",
			"    vso.build_execute, for build retries and queueing. The policy evaluation requeue scope has not",
			"    been verified with a real PAT.",
			"  - Build commands support YAML and classic Build API validation runs, not Releases, external status",
			"    checks, or individual stage/job/task retries.",
			"  - Identity (Read), also named vso.identity, only for --reviewer additions on pr create/edit.",
			"    --remove-reviewer resolves current PR reviewers and needs only Code (Read & Write).",
			"",
			"Image notes:",
			"  Every --image path needs a matching {{image:<basename>}} in the effective description, and every",
			"  such placeholder needs a corresponding --image. Existing attachment displayName collisions are",
			"  rejected before upload using case-sensitive filename matching; replacement is not supported.",
			"  Upload failures before the description update trigger best-effort cleanup of new attachments. If",
			"  the final update fails, its outcome is uncertain, so uploads are retained and may be orphaned.",
			"  Generated image Markdown has an adjacent invisible ownership marker. Keep the marker unchanged for",
			"  automatic reference removal. If it is edited or removed, attachment deletion retains the custom",
			"  reference, which may then be broken.",
		].join("\n"),
	);
});
