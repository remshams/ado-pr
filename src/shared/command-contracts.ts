type FlagKind = "string" | "repeatableString" | "positiveInteger" | "boolean";

interface FlagDefinition {
	kind: FlagKind;
	usage: string;
	description: string;
}

/** Global flag syntax. Commands opt into these flags through COMMAND_REGISTRY. */
export const FLAG_DEFINITIONS = {
	pr: {
		kind: "positiveInteger",
		usage: "--pr <id>",
		description:
			"Use a specific pull request instead of the current branch's active PR.",
	},
	build: {
		kind: "positiveInteger",
		usage: "--build <id>",
		description:
			"Build ID. Required for `build retry`; choose --build or --latest for show/wait.",
	},
	branch: {
		kind: "string",
		usage: "--branch <name>",
		description: "Queue a validation build for this source branch.",
	},
	definition: {
		kind: "positiveInteger",
		usage: "--definition <id>",
		description:
			"Queue this build pipeline (definition ID) instead of the one found from the repository's build policies; `build queue` only.",
	},
	latest: {
		kind: "boolean",
		usage: "--latest",
		description:
			"Select the newest build validating the PR head by queue time.",
	},
	"since-iteration": {
		kind: "positiveInteger",
		usage: "--since-iteration <n>",
		description:
			"Show only what changed since this pull request iteration; `pr diff` only.",
	},
	"since-last-review": {
		kind: "boolean",
		usage: "--since-last-review",
		description:
			"Heuristic: show what changed since your last comment or vote; `pr diff` only.",
	},
	"name-only": {
		kind: "boolean",
		usage: "--name-only",
		description:
			"List changed paths with their change type and no content; `pr diff` only.",
	},
	reviewing: {
		kind: "boolean",
		usage: "--reviewing",
		description: "List active pull requests assigned to you for review.",
	},
	all: {
		kind: "boolean",
		usage: "--all",
		description: "List all active pull requests in the repository.",
	},
	interval: {
		kind: "positiveInteger",
		usage: "--interval <seconds>",
		description:
			"Polling interval for `build wait` (default 60 seconds; range 10–3600).",
	},
	timeout: {
		kind: "positiveInteger",
		usage: "--timeout <seconds>",
		description:
			"Maximum polling time after PR resolution for `build wait` (default 3600 seconds/1 hour; range 10–86400).",
	},
	title: {
		kind: "string",
		usage: "--title <text>",
		description: "Pull request title (required for `pr create`).",
	},
	description: {
		kind: "string",
		usage: "--description <text>",
		description:
			"Pull request description (maximum 4,000 characters). Empty clears it.",
	},
	image: {
		kind: "repeatableString",
		usage: "--image <path>",
		description:
			"Upload an image for a matching {{image:<filename>}} description placeholder.",
	},
	name: {
		kind: "string",
		usage: "--name <file name>",
		description:
			"Attachment filename used by `pr attach` (defaults to the path basename).",
	},
	"remove-image": {
		kind: "repeatableString",
		usage: "--remove-image <filename>",
		description:
			"Remove an attachment and its exact generated Markdown references; `pr edit` only.",
	},
	reviewer: {
		kind: "repeatableString",
		usage: "--reviewer <email-or-display-name>",
		description:
			"Add a uniquely resolved active reviewer. Repeat to add multiple reviewers.",
	},
	"remove-reviewer": {
		kind: "repeatableString",
		usage: "--remove-reviewer <email-or-display-name>",
		description:
			"Remove a uniquely resolved reviewer; valid only for `pr edit`.",
	},
	source: {
		kind: "string",
		usage: "--source <branch>",
		description:
			"Source branch for `pr create` (defaults to the current branch).",
	},
	target: {
		kind: "string",
		usage: "--target <branch>",
		description:
			"Target branch for `pr create`, or filter `pr list` by target branch.",
	},
	draft: {
		kind: "boolean",
		usage: "--draft",
		description: "Create a draft PR or mark an existing PR as draft.",
	},
	"no-draft": {
		kind: "boolean",
		usage: "--no-draft",
		description: "Mark an existing PR as ready; valid only for `pr edit`.",
	},
	thread: {
		kind: "positiveInteger",
		usage: "--thread <id>",
		description: "Thread ID for reply/edit/delete/resolve/reopen.",
	},
	status: {
		kind: "string",
		usage: "--status <status>",
		description:
			"Thread status for `comment resolve` (default fixed) or `comment reply`: fixed, wontFix, byDesign, closed (case-insensitive).",
	},
	comment: {
		kind: "positiveInteger",
		usage: "--comment <id>",
		description: "Comment ID for edit/delete.",
	},
	message: {
		kind: "string",
		usage: "--message <text>",
		description: "Comment text for create/reply/edit.",
	},
	file: {
		kind: "string",
		usage: "--file <path>",
		description: "Anchor a new comment thread to a repository-relative file.",
	},
	line: {
		kind: "positiveInteger",
		usage: "--line <n>",
		description: "Anchor to a line in --file. Requires --file.",
	},
	"end-line": {
		kind: "positiveInteger",
		usage: "--end-line <n>",
		description:
			"End an anchored range. Requires --line and must be >= --line.",
	},
	attachment: {
		kind: "string",
		usage: "--attachment <path>",
		description:
			"Upload a file and append its Markdown link to the comment; `comment create` and `comment reply`.",
	},
	"attachment-name": {
		kind: "string",
		usage: "--attachment-name <file name>",
		description:
			"Filename for --attachment (defaults to the path basename). Requires --attachment.",
	},
	"exclude-own": {
		kind: "boolean",
		usage: "--exclude-own",
		description:
			"Hide threads where the current identity is the only commenter.",
	},
	"exclude-resolved": {
		kind: "boolean",
		usage: "--exclude-resolved",
		description: "Hide resolved threads.",
	},
	history: {
		kind: "boolean",
		usage: "--history",
		description:
			"Include historical PR validation builds instead of only the current merge version.",
	},
	"full-logs": {
		kind: "boolean",
		usage: "--full-logs",
		description:
			"Fetch complete potentially sensitive problem logs instead of the final 200 lines.",
	},
	json: {
		kind: "boolean",
		usage: "--json",
		description:
			"Print normalized build output, the PR status document and PR diffs, or raw JSON for PR/comment list and PR show.",
	},
	help: {
		kind: "boolean",
		usage: "-h, --help",
		description: "Show this help.",
	},
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAG_DEFINITIONS;
type FlagNameForKind<Kind extends FlagKind> = {
	[Name in FlagName]: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends Kind
		? Name
		: never;
}[FlagName];

export type TextFlagName = FlagNameForKind<"string">;
export type RepeatableStringFlagName = FlagNameForKind<"repeatableString">;
export type PositiveIntegerFlagName = FlagNameForKind<"positiveInteger">;
export type StringFlagName =
	| TextFlagName
	| RepeatableStringFlagName
	| PositiveIntegerFlagName;
type BooleanFlagName = FlagNameForKind<"boolean">;

function flagNamesForKind<Kind extends FlagKind>(
	kind: Kind,
): FlagNameForKind<Kind>[] {
	return Object.entries(FLAG_DEFINITIONS)
		.filter(([, definition]) => definition.kind === kind)
		.map(([name]) => name) as FlagNameForKind<Kind>[];
}

const TEXT_FLAG_NAMES = flagNamesForKind("string");
export const REPEATABLE_STRING_FLAG_NAMES =
	flagNamesForKind("repeatableString");
const POSITIVE_INTEGER_FLAG_NAMES = flagNamesForKind("positiveInteger");

export const STRING_FLAG_NAMES: StringFlagName[] = [
	...TEXT_FLAG_NAMES,
	...REPEATABLE_STRING_FLAG_NAMES,
	...POSITIVE_INTEGER_FLAG_NAMES,
];

export const BOOLEAN_FLAG_NAMES = flagNamesForKind("boolean");

type BatchFieldKind =
	| "command"
	| "positiveInteger"
	| "message"
	| "file"
	| "status";

interface BatchFieldDefinition {
	kind: BatchFieldKind;
	required: boolean;
	example: string;
}

/** Batch field syntax shared by all batch-capable commands. */
export const BATCH_FIELD_DEFINITIONS = {
	command: { kind: "command", required: true, example: "" },
	pr: { kind: "positiveInteger", required: false, example: "n" },
	thread: { kind: "positiveInteger", required: true, example: "n" },
	comment: { kind: "positiveInteger", required: true, example: "n" },
	message: { kind: "message", required: true, example: '"..."' },
	file: { kind: "file", required: false, example: '"..."' },
	line: { kind: "positiveInteger", required: false, example: "n" },
	endLine: { kind: "positiveInteger", required: false, example: "n" },
	status: { kind: "status", required: false, example: '"fixed"' },
} as const satisfies Record<string, BatchFieldDefinition>;

export type BatchFieldName = keyof typeof BATCH_FIELD_DEFINITIONS;

export type CommandValidationRule =
	| "pullRequestList"
	| "pullRequestEdit"
	| "pullRequestDiff"
	| "commentLocation"
	| "commentAttachment"
	| "buildWaitBounds"
	| "buildSelection"
	| "buildQueueTarget";

interface CommandDefinition {
	resource: "pr" | "comment" | "build";
	command: string;
	usage: string;
	summary: string;
	flags: readonly FlagName[];
	requiredFlags?: readonly FlagName[];
	validationRules?: readonly CommandValidationRule[];
	batchFields?: readonly BatchFieldName[];
}

function defineCommandRegistry<
	const Registry extends Record<string, CommandDefinition>,
>(
	registry: Registry & {
		[Id in keyof Registry]: {
			requiredFlags?: readonly Registry[Id]["flags"][number][];
		};
	},
): Registry {
	return registry;
}

/**
 * The authoritative inventory of commands and their external contracts.
 *
 * CLI routes, accepted flags, help text, batch command names, and batch field allowlists are all
 * derived from this registry.
 */
export const COMMAND_REGISTRY = defineCommandRegistry({
	"pr.list": {
		resource: "pr",
		command: "list",
		usage: "pr list [--reviewing | --all] [--target <branch>] [--json]",
		summary:
			"List active pull requests with optional review and target filters.",
		flags: ["reviewing", "all", "target", "json"],
		validationRules: ["pullRequestList"],
	},
	"pr.show": {
		resource: "pr",
		command: "show",
		usage: "pr show [--pr <id>] [--json]",
		summary: "Show pull request details. Use --json for raw data.",
		flags: ["pr", "json"],
	},
	"pr.status": {
		resource: "pr",
		command: "status",
		usage: "pr status [--pr <id>] [--json]",
		summary:
			"Show head and merge commit, iteration, draft state, validating build, Copilot review, unresolved threads, merge state, blocking policies and votes.",
		flags: ["pr", "json"],
	},
	"pr.diff": {
		resource: "pr",
		command: "diff",
		usage:
			"pr diff [--pr <id>] [--since-iteration <n> | --since-last-review] [--name-only] [--json]",
		summary:
			"Print the pull request diff from Azure DevOps as a unified diff, changed paths or JSON.",
		flags: ["pr", "since-iteration", "since-last-review", "name-only", "json"],
		validationRules: ["pullRequestDiff"],
	},
	"pr.create": {
		resource: "pr",
		command: "create",
		usage:
			'pr create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft] [--image <path>]... [--reviewer <email-or-display-name>]...',
		summary:
			"Create a pull request, optionally uploading images and adding reviewers.",
		flags: [
			"title",
			"description",
			"source",
			"target",
			"draft",
			"image",
			"reviewer",
		],
		requiredFlags: ["title"],
	},
	"pr.edit": {
		resource: "pr",
		command: "edit",
		usage:
			'pr edit [--description "..."] [--draft | --no-draft] [--image <path>]... [--remove-image <filename>]... [--reviewer <email-or-display-name>]... [--remove-reviewer <email-or-display-name>]... [--pr <id>]',
		summary: "Change PR fields, images, and/or reviewers.",
		flags: [
			"pr",
			"description",
			"draft",
			"no-draft",
			"image",
			"remove-image",
			"reviewer",
			"remove-reviewer",
		],
		validationRules: ["pullRequestEdit"],
	},
	"pr.attach": {
		resource: "pr",
		command: "attach",
		usage: "pr attach <path> [--name <file name>] [--pr <id>]",
		summary: "Upload any file as a pull request attachment.",
		flags: ["name", "pr"],
	},
	"build.list": {
		resource: "build",
		command: "list",
		usage: "build list [--pr <id>] [--history] [--json]",
		summary: "List PR-associated Azure Pipelines validation builds.",
		flags: ["pr", "history", "json"],
	},
	"build.show": {
		resource: "build",
		command: "show",
		usage:
			"build show (--build <id> | --latest) [--pr <id>] [--full-logs] [--json]",
		summary:
			"Inspect a PR validation build, timeline, issues, and diagnostic logs.",
		flags: ["build", "latest", "pr", "full-logs", "json"],
		validationRules: ["buildSelection"],
	},
	"build.retry": {
		resource: "build",
		command: "retry",
		usage: "build retry --build <id> [--pr <id>]",
		summary:
			"Retry an eligible failed PR validation build at the whole-build level.",
		flags: ["build", "pr"],
		requiredFlags: ["build"],
	},
	"build.queue": {
		resource: "build",
		command: "queue",
		usage: "build queue (--pr <id> | --branch <name>) [--definition <id>]",
		summary: "Queue a validation build for a pull request or branch.",
		flags: ["pr", "branch", "definition"],
		validationRules: ["buildQueueTarget"],
	},
	"build.wait": {
		resource: "build",
		command: "wait",
		usage:
			"build wait (--build <id> | --latest) [--pr <id>] [--interval <seconds>] [--timeout <seconds>] [--json]",
		summary:
			"Wait for a PR validation build to reach a terminal outcome without mutating it.",
		flags: ["build", "latest", "pr", "interval", "timeout", "json"],
		validationRules: ["buildSelection", "buildWaitBounds"],
	},
	"comment.list": {
		resource: "comment",
		command: "list",
		usage:
			"comment list [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]",
		summary: "List comment threads, optionally filtering or printing JSON.",
		flags: ["pr", "json", "exclude-own", "exclude-resolved"],
	},
	"comment.create": {
		resource: "comment",
		command: "create",
		usage:
			'comment create --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]] [--attachment <path> [--attachment-name <file name>]]',
		summary: "Create a general or file-anchored comment thread.",
		flags: [
			"pr",
			"message",
			"file",
			"line",
			"end-line",
			"attachment",
			"attachment-name",
		],
		requiredFlags: ["message"],
		validationRules: ["commentLocation", "commentAttachment"],
		batchFields: ["command", "message", "pr", "file", "line", "endLine"],
	},
	"comment.reply": {
		resource: "comment",
		command: "reply",
		usage:
			'comment reply --thread <id> --message "..." [--pr <id>] [--status fixed|wontFix|byDesign|closed] [--attachment <path> [--attachment-name <file name>]]',
		summary: "Reply to an existing thread, optionally setting its status.",
		flags: [
			"pr",
			"thread",
			"message",
			"status",
			"attachment",
			"attachment-name",
		],
		requiredFlags: ["thread", "message"],
		validationRules: ["commentAttachment"],
		batchFields: ["command", "thread", "message", "pr", "status"],
	},
	"comment.edit": {
		resource: "comment",
		command: "edit",
		usage:
			'comment edit --thread <id> --comment <id> --message "..." [--pr <id>]',
		summary: "Edit an existing comment.",
		flags: ["pr", "thread", "comment", "message"],
		requiredFlags: ["thread", "comment", "message"],
		batchFields: ["command", "thread", "comment", "message", "pr"],
	},
	"comment.delete": {
		resource: "comment",
		command: "delete",
		usage: "comment delete --thread <id> --comment <id> [--pr <id>]",
		summary: "Delete an existing comment.",
		flags: ["pr", "thread", "comment"],
		requiredFlags: ["thread", "comment"],
		batchFields: ["command", "thread", "comment", "pr"],
	},
	"comment.resolve": {
		resource: "comment",
		command: "resolve",
		usage:
			"comment resolve --thread <id> [--pr <id>] [--status fixed|wontFix|byDesign|closed]",
		summary: "Mark an existing thread as resolved.",
		flags: ["pr", "thread", "status"],
		requiredFlags: ["thread"],
		batchFields: ["command", "thread", "pr", "status"],
	},
	"comment.reopen": {
		resource: "comment",
		command: "reopen",
		usage: "comment reopen --thread <id> [--pr <id>]",
		summary: "Reopen an existing thread.",
		flags: ["pr", "thread"],
		requiredFlags: ["thread"],
		batchFields: ["command", "thread", "pr"],
	},
	"comment.batch": {
		resource: "comment",
		command: "batch",
		usage: "comment batch [--pr <id>] < operations.json",
		summary: "Run comment operations from a JSON array read from stdin.",
		flags: ["pr"],
	},
});

export type CommandId = keyof typeof COMMAND_REGISTRY;
export type CommandRegistryEntry = (typeof COMMAND_REGISTRY)[CommandId];
export type ResourceName = CommandRegistryEntry["resource"];
export type BatchCommand = {
	[Id in CommandId]: (typeof COMMAND_REGISTRY)[Id] extends {
		batchFields: readonly BatchFieldName[];
	}
		? Id
		: never;
}[CommandId];

type CommandFlag<Id extends CommandId> =
	(typeof COMMAND_REGISTRY)[Id]["flags"][number];
type RequiredCommandFlag<Id extends CommandId> =
	(typeof COMMAND_REGISTRY)[Id] extends {
		requiredFlags: readonly (infer Name extends FlagName)[];
	}
		? Name
		: never;
type FlagValue<Name extends FlagName> =
	(typeof FLAG_DEFINITIONS)[Name]["kind"] extends "boolean"
		? boolean
		: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "positiveInteger"
			? number
			: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "repeatableString"
				? string[]
				: string;
type PresentCommandFlag<Id extends CommandId> =
	| RequiredCommandFlag<Id>
	| Extract<CommandFlag<Id>, BooleanFlagName>;

/** Parsed values guaranteed by a command's registered flag schema. */
export type ParsedCommandFlags<Id extends CommandId> = {
	[Name in PresentCommandFlag<Id>]-?: FlagValue<Name>;
} & {
	[Name in Exclude<CommandFlag<Id>, PresentCommandFlag<Id>>]?: FlagValue<Name>;
};

type BatchFieldFor<Id extends BatchCommand> =
	(typeof COMMAND_REGISTRY)[Id] extends {
		batchFields: readonly (infer Field extends BatchFieldName)[];
	}
		? Exclude<Field, "command">
		: never;
type BatchFieldValue<Field extends BatchFieldName> =
	(typeof BATCH_FIELD_DEFINITIONS)[Field]["kind"] extends "positiveInteger"
		? number
		: string;
type RequiredBatchField<Id extends BatchCommand> = {
	[Field in BatchFieldFor<Id>]: (typeof BATCH_FIELD_DEFINITIONS)[Field]["required"] extends true
		? Field
		: never;
}[BatchFieldFor<Id>];

/** A validated batch operation, derived from its registered fields and their value definitions. */
export type BatchOperation = {
	[Id in BatchCommand]: {
		command: Id;
	} & {
		[Field in RequiredBatchField<Id>]-?: BatchFieldValue<Field>;
	} & {
		[Field in Exclude<
			BatchFieldFor<Id>,
			RequiredBatchField<Id>
		>]?: BatchFieldValue<Field>;
	};
}[BatchCommand];

export const COMMAND_IDS = Object.keys(COMMAND_REGISTRY) as CommandId[];
const RESOURCE_NAMES = [
	...new Set(COMMAND_IDS.map((id) => COMMAND_REGISTRY[id].resource)),
];
export const BATCH_COMMANDS = COMMAND_IDS.filter(
	(id): id is BatchCommand => "batchFields" in COMMAND_REGISTRY[id],
);
export const BATCH_FIELD_NAMES = Object.keys(
	BATCH_FIELD_DEFINITIONS,
) as BatchFieldName[];

export function isResourceName(value: string): value is ResourceName {
	return RESOURCE_NAMES.includes(value as ResourceName);
}

export function getCommandId(
	resource: string,
	command: string,
): CommandId | undefined {
	const id = `${resource}.${command}`;
	return Object.hasOwn(COMMAND_REGISTRY, id) ? (id as CommandId) : undefined;
}

export function getCommandDefinition(
	resource: string,
	command: string,
): CommandRegistryEntry | undefined {
	const id = getCommandId(resource, command);
	return id ? COMMAND_REGISTRY[id] : undefined;
}

export function isBatchCommand(value: string): value is BatchCommand {
	return BATCH_COMMANDS.includes(value as BatchCommand);
}

export function getBatchFields(
	command: BatchCommand,
): readonly BatchFieldName[] {
	return (
		COMMAND_REGISTRY[command] as CommandRegistryEntry & {
			batchFields: readonly BatchFieldName[];
		}
	).batchFields;
}

export function getCommandValidationRules(
	command: CommandId,
): readonly CommandValidationRule[] {
	const definition = COMMAND_REGISTRY[command] as CommandDefinition;
	return definition.validationRules ?? [];
}
