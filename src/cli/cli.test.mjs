import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnTestProcess } from "../../tests/test-helpers.mjs";

import { buildWaitExitCode } from "../shared/operation-types.ts";
import { getPat, parseArgs } from "./cli.ts";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = fileURLToPath(new URL("../pr.ts", import.meta.url));
const usageFirstLine = "Usage: pr.sh pr list [--json]";
const missingPatError =
	"Error: AZURE_DEVOPS_PAT is not set. Export it before running pr.ts, or configure it in .env and run pr.sh.\n";
const childEnvAllowlist = new Set([
	"NODE_V8_COVERAGE",
	"HOME",
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
]);

function minimalChildEnv() {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) =>
				value !== undefined && childEnvAllowlist.has(key.toUpperCase()),
		),
	);
}

function runCliWithEnv(envOverrides, ...args) {
	const env = minimalChildEnv();
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.AZURE_DEVOPS_PAT, undefined);

	return spawnTestProcess(
		process.execPath,
		[
			"--experimental-strip-types",
			"--disable-warning=ExperimentalWarning",
			cliPath,
			...args,
		],
		{
			cwd: projectRoot,
			description: `pr.ts ${JSON.stringify(args)}`,
			encoding: "utf8",
			env: { ...env, ...envOverrides },
		},
	);
}

function captureCli(args, pat) {
	const stdout = [];
	const stderr = [];
	const exited = new Error("CLI exited");
	let status;
	let options;
	const previousPat = process.env.AZURE_DEVOPS_PAT;
	if (pat === undefined) delete process.env.AZURE_DEVOPS_PAT;
	else process.env.AZURE_DEVOPS_PAT = pat;
	const logMock = mock.method(console, "log", (...values) => {
		stdout.push(`${values.join(" ")}\n`);
	});
	const errorMock = mock.method(console, "error", (...values) => {
		stderr.push(`${values.join(" ")}\n`);
	});
	const exitMock = mock.method(process, "exit", (code) => {
		status = code;
		throw exited;
	});
	try {
		options = parseArgs(args);
		getPat();
	} catch (error) {
		if (error !== exited) throw error;
	} finally {
		exitMock.mock.restore();
		errorMock.mock.restore();
		logMock.mock.restore();
		if (previousPat === undefined) delete process.env.AZURE_DEVOPS_PAT;
		else process.env.AZURE_DEVOPS_PAT = previousPat;
	}
	return { status, stdout: stdout.join(""), stderr: stderr.join(""), options };
}

function runCli(...args) {
	return captureCli(args);
}

function parseOptions(args) {
	const result = captureCli(args, "literal-token");
	assert.equal(result.status, undefined, result.stderr);
	assert.equal(result.stderr, "");
	return result.options;
}

function firstLine(output) {
	return output.split(/\r?\n/, 1)[0];
}

function assertUsageError(result, expectedError) {
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(firstLine(result.stderr), expectedError);
	assert.ok(
		result.stderr.startsWith(`${expectedError}\n\n${usageFirstLine}\n`),
	);
}

function assertParsedBeforePat(...args) {
	const result = runCli(...args);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, missingPatError);
}

function assertSuccessfulHelp(result) {
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(firstLine(result.stderr), usageFirstLine);
}

test("bare --help and -h document every resource-first command and the batch contract", () => {
	const result = runCli("--help");

	assertSuccessfulHelp(result);
	for (const command of [
		"pr list",
		"pr show",
		"pr create",
		"pr edit",
		"comment list",
		"build list",
		"build show",
		"build retry",
		"build wait",
		"comment create",
		"comment reply",
		"comment edit",
		"comment delete",
		"comment resolve",
		"comment batch",
	]) {
		assert.match(
			result.stderr,
			new RegExp(`pr\\.sh ${command.replace(" ", " ")}`),
		);
	}
	assert.match(result.stderr, /--draft \| --no-draft/);
	assert.match(result.stderr, /--image <path>/);
	assert.match(result.stderr, /--remove-image <filename>/);
	assert.match(result.stderr, /--reviewer <email-or-display-name>/);
	assert.match(result.stderr, /Identity \(Read\)/);
	assert.match(result.stderr, /maximum 4,000 characters/);
	assert.match(result.stderr, /\{\{image:<basename>\}\}/);
	assert.match(
		result.stderr,
		/every\s+such placeholder needs a corresponding --image/,
	);
	assert.match(result.stderr, / {2}--no-draft\s+Mark an existing PR as ready/);
	assert.match(result.stderr, / {2}-h, --help\s+Show this help\./);

	for (const shape of [
		'{"command":"comment.create","message":"...","pr"?:n,"file"?:"...","line"?:n,"endLine"?:n}',
		'{"command":"comment.reply","thread":n,"message":"...","pr"?:n}',
		'{"command":"comment.edit","thread":n,"comment":n,"message":"...","pr"?:n}',
		'{"command":"comment.delete","thread":n,"comment":n,"pr"?:n}',
		'{"command":"comment.resolve","thread":n,"pr"?:n}',
	]) {
		assert.ok(result.stderr.includes(shape));
	}
	assert.match(
		result.stderr,
		/Per-operation "pr" overrides the command's --pr\/default PR/,
	);
	assert.match(
		result.stderr,
		/Unknown fields and\s+fields irrelevant to the selected command are invalid\./,
	);
	assert.match(
		result.stderr,
		/Operations execute sequentially in array\s+order\./,
	);
	assert.match(
		result.stderr,
		/A failed operation is reported and later operations still run/,
	);
	assert.match(
		result.stderr,
		/process exits nonzero if any operation failed\./,
	);

	assertSuccessfulHelp(runCli("-h"));
});

test("qualified command help succeeds after route and supplied-option validation", () => {
	for (const [resource, command] of [
		["pr", "list"],
		["pr", "show"],
		["pr", "create"],
		["pr", "edit"],
		["comment", "list"],
		["build", "list"],
		["build", "show"],
		["build", "retry"],
		["build", "wait"],
		["comment", "create"],
		["comment", "reply"],
		["comment", "edit"],
		["comment", "delete"],
		["comment", "resolve"],
		["comment", "batch"],
	]) {
		assertSuccessfulHelp(runCli(resource, command, "--help"));
	}
	assertSuccessfulHelp(runCli("pr", "show", "--pr", "42", "-h"));
	assertSuccessfulHelp(
		runCli(
			"build",
			"wait",
			"--build",
			"42",
			"--interval",
			"10",
			"--timeout",
			"86400",
			"--help",
		),
	);
});

test("help does not mask malformed command-like invocations", () => {
	const cases = [
		[["pr", "--help"], 'Error: a command is required for resource "pr"'],
		[["mystery", "show", "--help"], 'Error: unknown resource "mystery"'],
		[
			["pr", "mystery", "--help"],
			'Error: unknown command "mystery" for resource "pr"',
		],
		[
			["pr", "show", "extra", "--help"],
			'Error: unexpected positional argument "extra"',
		],
		[
			["pr", "show", "--json", "--json", "--help"],
			"Error: --json may only be passed once",
		],
		[["pr", "show", "--help", "-h"], "Error: -h may only be passed once"],
		[
			["pr", "show", "--title", "x", "--help"],
			'Error: --title is not valid for "pr show"',
		],
		[["pr", "show", "--bogus", "--help"], 'Error: unknown option "--bogus"'],
		[
			["pr", "show", "--pr", "0", "--help"],
			'Error: invalid --pr "0" (pass it once, as a single positive integer)',
		],
		[
			["build", "retry", "--build", "1", "--build", "2"],
			"Error: --build may only be passed once",
		],
		[
			["pr", "edit", "--draft", "--no-draft", "--help"],
			"Error: --draft and --no-draft cannot be used together",
		],
		[
			["comment", "create", "--line", "2", "--help"],
			"Error: --line requires --file",
		],
	];

	for (const [args, expected] of cases) {
		assertUsageError(runCli(...args), expected);
	}
});

test("no command is a usage error instead of defaulting to comment list", () => {
	assertUsageError(runCli(), "Error: a resource and command are required");
	assertUsageError(
		runCli("comment"),
		'Error: a command is required for resource "comment"',
	);
	assertUsageError(
		runCli("pr"),
		'Error: a command is required for resource "pr"',
	);
});

test("unknown resources, commands, and extra positional arguments are rejected", () => {
	assertUsageError(
		runCli("mystery", "show"),
		'Error: unknown resource "mystery"',
	);
	assertUsageError(
		runCli("pr", "mystery"),
		'Error: unknown command "mystery" for resource "pr"',
	);
	assertUsageError(
		runCli("comment", "list", "extra"),
		'Error: unexpected positional argument "extra"',
	);
});

test("legacy flat action aliases remain rejected even when combined with help", () => {
	for (const action of [
		"list",
		"show",
		"update",
		"create",
		"reply",
		"edit",
		"delete",
		"resolve",
		"batch",
	]) {
		assertUsageError(runCli(action), `Error: unknown resource "${action}"`);
		assertUsageError(
			runCli(action, "--help"),
			`Error: unknown resource "${action}"`,
		);
	}

	assertUsageError(
		runCli("comment", "--help"),
		'Error: a command is required for resource "comment"',
	);
	for (const help of [undefined, "--help"]) {
		const args = ["comment", "--message", "old", ...(help ? [help] : [])];
		assertUsageError(
			runCli(...args),
			'Error: a command is required for resource "comment"',
		);
	}
});

test("build wait maps completed and timeout outcomes to stable exit codes", () => {
	assert.equal(buildWaitExitCode({ timedOut: false, outcome: "succeeded" }), 0);
	for (const outcome of [
		"partiallySucceeded",
		"failed",
		"canceled",
		"unknown",
	]) {
		assert.equal(buildWaitExitCode({ timedOut: false, outcome }), 1);
	}
	assert.equal(buildWaitExitCode({ timedOut: true, outcome: "timeout" }), 124);
	assert.equal(
		buildWaitExitCode({ timedOut: true, outcome: "succeeded" }),
		124,
	);
});

test("build wait defaults, accepts bounds, and validates its parser contract", () => {
	assertParsedBeforePat("build", "wait", "--build", "7");
	assertParsedBeforePat(
		"build",
		"wait",
		"--build=7",
		"--pr=42",
		"--interval=10",
		"--timeout",
		"86400",
	);
	for (const [args, expected] of [
		[
			["build", "wait", "--build", "7", "--interval", "9"],
			"Error: --interval must be between 10 and 3600 seconds",
		],
		[
			["build", "wait", "--build", "7", "--interval", "3601"],
			"Error: --interval must be between 10 and 3600 seconds",
		],
		[
			["build", "wait", "--build", "7", "--timeout", "9"],
			"Error: --timeout must be between 10 and 86400 seconds",
		],
		[
			["build", "wait", "--build", "7", "--timeout", "86401"],
			"Error: --timeout must be between 10 and 86400 seconds",
		],
		[
			["build", "wait", "--build", "7", "--interval"],
			"Error: --interval requires an explicit value",
		],
		[
			["build", "wait", "--build", "7", "--timeout"],
			"Error: --timeout requires an explicit value",
		],
		[
			["build", "wait", "--build", "7", "--timeout="],
			'Error: invalid --timeout "" (pass it once, as a single positive integer)',
		],
		[
			["build", "wait", "--build", "7", "--interval", "9007199254740993"],
			'Error: invalid --interval "9007199254740993" (pass it once, as a single positive integer)',
		],
		[
			["build", "wait", "--build", "7", "--timeout", "9007199254740993"],
			'Error: invalid --timeout "9007199254740993" (pass it once, as a single positive integer)',
		],
		[
			["build", "wait", "--build", "7", "--interval", "10", "--interval", "20"],
			"Error: --interval may only be passed once",
		],
		[
			["build", "wait", "--build", "7", "--timeout", "10", "--timeout", "20"],
			"Error: --timeout may only be passed once",
		],
		[
			["build", "wait", "--build", "7", "--json", "--interval", "9"],
			"Error: --interval must be between 10 and 3600 seconds",
		],
		[
			["build", "wait", "--build", "7", "--history"],
			'Error: --history is not valid for "build wait"',
		],
	])
		assertUsageError(runCli(...args), expected);
});

test("build flags parse with registry-derived types and reject missing or foreign options", () => {
	assertParsedBeforePat("build", "list", "--history");
	assertParsedBeforePat("build", "show", "--build", "7", "--full-logs");
	assertParsedBeforePat("build", "retry", "--build", "7", "--pr", "42");

	for (const command of ["show", "retry", "wait"]) {
		assertUsageError(
			runCli("build", command),
			command === "retry"
				? `Error: --build is required for "build ${command}"`
				: `Error: exactly one of --build or --latest is required for "build ${command}"`,
		);
		assertUsageError(
			runCli("build", command, "--build", "0"),
			'Error: invalid --build "0" (pass it once, as a single positive integer)',
		);
	}
	for (const [args, expected] of [
		[
			["build", "list", "--build", "7"],
			'Error: --build is not valid for "build list"',
		],
		[
			["build", "show", "--build", "7", "--history"],
			'Error: --history is not valid for "build show"',
		],
		[
			["build", "retry", "--build", "7", "--json"],
			'Error: --json is not valid for "build retry"',
		],
		[
			["build", "list", "--full-logs"],
			'Error: --full-logs is not valid for "build list"',
		],
	]) {
		assertUsageError(runCli(...args), expected);
	}
});

test("build queue accepts exactly one PR or branch target", () => {
	const byPr = parseArgs(["build", "queue", "--pr", "42"]);
	assert.deepEqual(
		{ command: byPr.command, pr: byPr.pr, branch: byPr.branch },
		{ command: "queue", pr: 42, branch: undefined },
	);
	const byBranch = parseArgs(["build", "queue", "--branch", "release/next"]);
	assert.deepEqual(
		{ command: byBranch.command, pr: byBranch.pr, branch: byBranch.branch },
		{ command: "queue", pr: undefined, branch: "release/next" },
	);
	assertUsageError(
		runCli("build", "queue"),
		'Error: exactly one of --pr or --branch is required for "build queue"',
	);
	assertUsageError(
		runCli("build", "queue", "--pr", "42", "--branch", "main"),
		'Error: --pr and --branch are mutually exclusive for "build queue"',
	);
	assertUsageError(
		runCli("build", "queue", "--branch", ""),
		"Error: --branch must not be empty",
	);
});

test("unknown flags and invalid boolean values are rejected", () => {
	assertUsageError(
		runCli("pr", "show", "--bogus"),
		'Error: unknown option "--bogus"',
	);
	assertUsageError(runCli("pr", "show", "-x"), 'Error: unknown option "-x"');
	assertUsageError(
		runCli("pr", "show", "--json=true"),
		"Error: --json does not take a value",
	);
});

test("each command rejects options belonging to other commands", () => {
	const cases = [
		[["pr", "list", "--pr", "1"], 'Error: --pr is not valid for "pr list"'],
		[
			["pr", "show", "--title", "x"],
			'Error: --title is not valid for "pr show"',
		],
		[
			["pr", "create", "--title", "x", "--pr", "1"],
			'Error: --pr is not valid for "pr create"',
		],
		[
			["pr", "create", "--title", "x", "--remove-image", "old.png"],
			'Error: --remove-image is not valid for "pr create"',
		],
		[
			["pr", "create", "--title", "x", "--remove-reviewer", "Ada"],
			'Error: --remove-reviewer is not valid for "pr create"',
		],
		[
			["pr", "edit", "--draft", "--json"],
			'Error: --json is not valid for "pr edit"',
		],
		[
			["comment", "list", "--message", "x"],
			'Error: --message is not valid for "comment list"',
		],
		[
			["comment", "create", "--message", "x", "--json"],
			'Error: --json is not valid for "comment create"',
		],
		[
			["comment", "reply", "--thread", "1", "--message", "x", "--comment", "2"],
			'Error: --comment is not valid for "comment reply"',
		],
		[
			[
				"comment",
				"edit",
				"--thread",
				"1",
				"--comment",
				"2",
				"--message",
				"x",
				"--file",
				"a.ts",
			],
			'Error: --file is not valid for "comment edit"',
		],
		[
			[
				"comment",
				"delete",
				"--thread",
				"1",
				"--comment",
				"2",
				"--message",
				"x",
			],
			'Error: --message is not valid for "comment delete"',
		],
		[
			["comment", "resolve", "--thread", "1", "--comment", "2"],
			'Error: --comment is not valid for "comment resolve"',
		],
		[
			["comment", "batch", "--json"],
			'Error: --json is not valid for "comment batch"',
		],
	];

	for (const [args, expected] of cases) {
		assertUsageError(runCli(...args), expected);
	}
});

test("required command options are validated in dependency order", () => {
	assertUsageError(
		runCli("pr", "create"),
		'Error: --title is required for "pr create"',
	);
	assertUsageError(
		runCli("comment", "create"),
		'Error: --message is required for "comment create"',
	);

	assertUsageError(
		runCli("comment", "reply"),
		'Error: --thread is required for "comment reply"',
	);
	assertUsageError(
		runCli("comment", "reply", "--thread", "7"),
		'Error: --message is required for "comment reply"',
	);

	assertUsageError(
		runCli("comment", "edit"),
		'Error: --thread is required for "comment edit"',
	);
	assertUsageError(
		runCli("comment", "edit", "--thread", "7"),
		'Error: --comment is required for "comment edit"',
	);
	assertUsageError(
		runCli("comment", "edit", "--thread", "7", "--comment", "8"),
		'Error: --message is required for "comment edit"',
	);

	assertUsageError(
		runCli("comment", "delete", "--thread", "7"),
		'Error: --comment is required for "comment delete"',
	);
	assertUsageError(
		runCli("comment", "resolve"),
		'Error: --thread is required for "comment resolve"',
	);
});

test("pr edit requires an explicit change and supports setting or clearing draft", () => {
	assertUsageError(
		runCli("pr", "edit"),
		'Error: --description, --draft, --no-draft, --image, --remove-image, --reviewer, or --remove-reviewer is required for "pr edit"',
	);
	assertUsageError(
		runCli("pr", "edit", "--description"),
		"Error: --description requires an explicit value",
	);
	assertUsageError(
		runCli("pr", "edit", "--draft", "--no-draft"),
		"Error: --draft and --no-draft cannot be used together",
	);
	assertUsageError(
		runCli("pr", "create", "--title", "x", "--no-draft"),
		'Error: --no-draft is not valid for "pr create"',
	);

	for (const args of [
		["pr", "edit", "--description", ""],
		["pr", "edit", "--description="],
		["pr", "edit", "--description", "-"],
		["pr", "edit", "--draft"],
		["pr", "edit", "--no-draft"],
		["pr", "edit", "--image", "flow.png", "--image", "arch.png"],
		["pr", "edit", "--remove-image", "old.png", "--remove-image", "older.png"],
		[
			"pr",
			"edit",
			"--reviewer",
			"Ada Lovelace",
			"--reviewer",
			"grace@example.test",
		],
		["pr", "edit", "--remove-reviewer", "Old Reviewer"],
	]) {
		assertParsedBeforePat(...args);
	}
});

test("positive integer flags and duplicate flags are rejected", () => {
	assertUsageError(
		runCli("comment", "resolve", "--thread", "0"),
		'Error: invalid --thread "0" (pass it once, as a single positive integer)',
	);
	assertUsageError(
		runCli("comment", "delete", "--thread", "7", "--comment", "1.5"),
		'Error: invalid --comment "1.5" (pass it once, as a single positive integer)',
	);
	assertUsageError(
		runCli("pr", "show", "--pr", "abc"),
		'Error: invalid --pr "abc" (pass it once, as a single positive integer)',
	);
	for (const value of ["9007199254740993", "1e2", "+7", "01"]) {
		assertUsageError(
			runCli("build", "show", "--build", value),
			`Error: invalid --build "${value}" (pass it once, as a single positive integer)`,
		);
		assertUsageError(
			runCli("build", "wait", "--build", value),
			`Error: invalid --build "${value}" (pass it once, as a single positive integer)`,
		);
	}
	assertUsageError(
		runCli("comment", "create", "--message", "first", "--message", "second"),
		"Error: --message may only be passed once",
	);
	assertUsageError(
		runCli("pr", "list", "--json", "--json"),
		"Error: --json may only be passed once",
	);
	assertUsageError(
		runCli("comment", "list", "--json", "--json"),
		"Error: --json may only be passed once",
	);
});

test("only registered repeatable string flags accept duplicate occurrences", () => {
	assertParsedBeforePat(
		"pr",
		"create",
		"--title",
		"Images and reviewers",
		"--image",
		"one.png",
		"--image=two.png",
		"--reviewer",
		"Ada Lovelace",
		"--reviewer=grace@example.test",
	);
	assertUsageError(
		runCli("pr", "create", "--title", "one", "--title", "two"),
		"Error: --title may only be passed once",
	);
	assertUsageError(
		runCli("pr", "edit", "--image"),
		"Error: --image requires an explicit value",
	);
});

test("repeatable string flags reject empty inline and separate values during parsing", () => {
	for (const [command, flag] of [
		["create", "image"],
		["create", "reviewer"],
		["edit", "remove-image"],
		["edit", "remove-reviewer"],
	]) {
		const prefix = [
			"pr",
			command,
			...(command === "create" ? ["--title", "x"] : []),
		];
		assertUsageError(
			runCli(...prefix, `--${flag}=`),
			`Error: --${flag} must not be empty`,
		);
		assertUsageError(
			runCli(...prefix, `--${flag}`, ""),
			`Error: --${flag} must not be empty`,
		);
	}
});

test("comment create preserves file line-range validation", () => {
	assertUsageError(
		runCli("comment", "create", "--message", "x", "--file", ""),
		"Error: --file must not be empty",
	);
	assertUsageError(
		runCli("comment", "create", "--message", "x", "--line", "2"),
		"Error: --line requires --file",
	);
	assertUsageError(
		runCli(
			"comment",
			"create",
			"--message",
			"x",
			"--file",
			"a.ts",
			"--end-line",
			"3",
		),
		"Error: --end-line requires --line",
	);
	assertUsageError(
		runCli(
			"comment",
			"create",
			"--message",
			"x",
			"--file",
			"a.ts",
			"--line",
			"5",
			"--end-line",
			"3",
		),
		"Error: --end-line must be >= --line",
	);
	assertUsageError(
		runCli(
			"comment",
			"create",
			"--message",
			"x",
			"--file",
			"a.ts",
			"--line",
			"-1",
		),
		'Error: invalid --line "-1" (pass it once, as a single positive integer)',
	);
});

test("valid resource-first commands reach PAT validation", () => {
	for (const args of [
		["pr", "list"],
		["pr", "list", "--json"],
		["pr", "show"],
		["pr", "create", "--title", "New PR"],
		["comment", "list"],
		["comment", "create", "--message", "Note"],
		["comment", "reply", "--thread", "7", "--message", "Reply"],
		["comment", "edit", "--thread", "7", "--comment", "8", "--message", "Edit"],
		["comment", "delete", "--thread", "7", "--comment", "8"],
		["comment", "resolve", "--thread", "7"],
		["comment", "batch"],
	]) {
		assertParsedBeforePat(...args);
	}
});

test("an unresolved op reference explains that an Environment mount needs a literal PAT", () => {
	const result = runCliWithEnv(
		{ AZURE_DEVOPS_PAT: "op://Private/Azure DevOps/PAT" },
		"comment",
		"resolve",
		"--thread",
		"7",
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"Error: AZURE_DEVOPS_PAT is still an op:// reference. pr.sh resolves references from regular .env files, but a 1Password Environment mount must contain the literal PAT.\n",
	);
});

test("parsing returns command options with typed values and defaults", () => {
	const cases = [
		[["pr", "list"], { resource: "pr", command: "list", json: false }],
		[["pr", "list", "--json"], { resource: "pr", command: "list", json: true }],
		[
			["pr", "show", "--pr=42", "--json"],
			{ resource: "pr", command: "show", pr: 42, json: true },
		],
		[
			["pr", "create", "--title", "A well-known title"],
			{
				resource: "pr",
				command: "create",
				title: "A well-known title",
				description: undefined,
				sourceBranch: undefined,
				targetBranch: undefined,
				draft: false,
				images: undefined,
				reviewers: undefined,
			},
		],
		[
			[
				"pr",
				"create",
				"--title=A=B",
				"--description",
				"-",
				"--source=feature/a",
				"--target",
				"main",
				"--draft",
				"--image=one.png",
				"--image",
				"two.png",
				"--reviewer",
				"Ada",
				"--reviewer=Grace",
			],
			{
				resource: "pr",
				command: "create",
				title: "A=B",
				description: "-",
				sourceBranch: "feature/a",
				targetBranch: "main",
				draft: true,
				images: ["one.png", "two.png"],
				reviewers: ["Ada", "Grace"],
			},
		],
		[
			[
				"pr",
				"edit",
				"--pr",
				"7",
				"--description=",
				"--image=new.png",
				"--remove-image=old.png",
				"--reviewer=Ada",
				"--remove-reviewer=Grace",
			],
			{
				resource: "pr",
				command: "edit",
				pr: 7,
				description: "",
				draft: undefined,
				images: ["new.png"],
				removeImages: ["old.png"],
				reviewers: ["Ada"],
				removeReviewers: ["Grace"],
			},
		],
		[
			["pr", "edit", "--draft"],
			{
				resource: "pr",
				command: "edit",
				pr: undefined,
				description: undefined,
				draft: true,
				images: undefined,
				removeImages: undefined,
				reviewers: undefined,
				removeReviewers: undefined,
			},
		],
		[
			["pr", "edit", "--no-draft"],
			{
				resource: "pr",
				command: "edit",
				pr: undefined,
				description: undefined,
				draft: false,
				images: undefined,
				removeImages: undefined,
				reviewers: undefined,
				removeReviewers: undefined,
			},
		],
		[
			["build", "list", "--pr=7", "--history", "--json"],
			{ resource: "build", command: "list", pr: 7, history: true, json: true },
		],
		[
			["build", "list"],
			{
				resource: "build",
				command: "list",
				pr: undefined,
				history: false,
				json: false,
			},
		],
		[
			["build", "show", "--build=9", "--pr=7", "--full-logs", "--json"],
			{
				resource: "build",
				command: "show",
				build: 9,
				latest: false,
				pr: 7,
				fullLogs: true,
				json: true,
			},
		],
		[
			["build", "retry", "--build=9", "--pr=7"],
			{ resource: "build", command: "retry", build: 9, pr: 7 },
		],
		[
			["build", "wait", "--build=9"],
			{
				resource: "build",
				command: "wait",
				build: 9,
				latest: false,
				pr: undefined,
				intervalSeconds: 60,
				timeoutSeconds: 3600,
				json: false,
			},
		],
		[
			[
				"build",
				"wait",
				"--build=9",
				"--pr=7",
				"--interval=3600",
				"--timeout=10",
				"--json",
			],
			{
				resource: "build",
				command: "wait",
				build: 9,
				latest: false,
				pr: 7,
				intervalSeconds: 3600,
				timeoutSeconds: 10,
				json: true,
			},
		],
		[
			["build", "wait", "--build=9", "--interval=10", "--timeout=86400"],
			{
				resource: "build",
				command: "wait",
				build: 9,
				latest: false,
				pr: undefined,
				intervalSeconds: 10,
				timeoutSeconds: 86400,
				json: false,
			},
		],
		[
			[
				"comment",
				"list",
				"--pr=7",
				"--json",
				"--exclude-own",
				"--exclude-resolved",
			],
			{
				resource: "comment",
				command: "list",
				pr: 7,
				json: true,
				excludeOwn: true,
				excludeResolved: true,
			},
		],
		[
			["comment", "list"],
			{
				resource: "comment",
				command: "list",
				pr: undefined,
				json: false,
				excludeOwn: false,
				excludeResolved: false,
			},
		],
		[
			[
				"comment",
				"create",
				"--pr=7",
				"--message=Note",
				"--file=a.ts",
				"--line=3",
				"--end-line=3",
			],
			{
				resource: "comment",
				command: "create",
				pr: 7,
				message: "Note",
				file: "a.ts",
				line: 3,
				endLine: 3,
			},
		],
		[
			["comment", "create", "--message=Note"],
			{
				resource: "comment",
				command: "create",
				pr: undefined,
				message: "Note",
				file: undefined,
				line: undefined,
				endLine: undefined,
			},
		],
		[
			["comment", "reply", "--pr=7", "--thread=8", "--message=Reply"],
			{
				resource: "comment",
				command: "reply",
				pr: 7,
				thread: 8,
				message: "Reply",
			},
		],
		[
			[
				"comment",
				"edit",
				"--pr=7",
				"--thread=8",
				"--comment=9",
				"--message=Edit",
			],
			{
				resource: "comment",
				command: "edit",
				pr: 7,
				thread: 8,
				comment: 9,
				message: "Edit",
			},
		],
		[
			["comment", "delete", "--pr=7", "--thread=8", "--comment=9"],
			{ resource: "comment", command: "delete", pr: 7, thread: 8, comment: 9 },
		],
		[
			["comment", "resolve", "--pr=7", "--thread=8"],
			{
				resource: "comment",
				command: "resolve",
				pr: 7,
				thread: 8,
				status: "fixed",
			},
		],
		[
			["comment", "batch", "--pr=7"],
			{ resource: "comment", command: "batch", pr: 7 },
		],
	];
	for (const [args, expected] of cases) {
		assert.deepEqual(parseOptions(args), expected, args.join(" "));
	}
});

test("option scanning respects terminators and option-like text", () => {
	assert.deepEqual(parseOptions(["--", "pr", "list"]), {
		resource: "pr",
		command: "list",
		json: false,
	});
	assert.equal(
		parseOptions(["pr", "create", "--title=--literal"]).title,
		"--literal",
	);
	assert.equal(parseOptions(["pr", "create", "--title", "-1"]).title, "-1");
	for (const token of ["-x", "--json"]) {
		assertUsageError(
			runCli("pr", "create", "--title", token),
			token === "-x"
				? 'Error: unknown option "-x"'
				: 'Error: --json is not valid for "pr create"',
		);
	}
	assertUsageError(
		runCli("pr", "list", "--", "--bogus"),
		'Error: unexpected positional argument "--bogus"',
	);
});

test("PAT lookup returns literal tokens", (t) => {
	t.mock.method(process, "exit", (code) => {
		throw new Error(`Unexpected CLI exit ${code}`);
	});
	const previous = process.env.AZURE_DEVOPS_PAT;
	t.after(() => {
		if (previous === undefined) delete process.env.AZURE_DEVOPS_PAT;
		else process.env.AZURE_DEVOPS_PAT = previous;
	});
	process.env.AZURE_DEVOPS_PAT = "literal-token";
	assert.equal(getPat(), "literal-token");
});

test("qualified help validates supplied required values while allowing omitted values", () => {
	assertSuccessfulHelp(runCli("pr", "create", "--title=New PR", "--help"));
	assertSuccessfulHelp(runCli("pr", "edit", "--description=", "--help"));
	assertUsageError(
		runCli("pr", "create", "--title=", "--help"),
		'Error: --title is required for "pr create"',
	);
	assertUsageError(
		runCli("comment", "reply", "--thread=1", "--message=", "--help"),
		'Error: --message is required for "comment reply"',
	);
});

test("PAT lookup rejects empty tokens and unresolved references in-process", () => {
	for (const pat of [undefined, ""]) {
		const result = captureCli(["pr", "list"], pat);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, missingPatError);
	}
	const result = captureCli(["pr", "list"], "op://Private/Azure/PAT");
	assert.equal(result.status, 1);
	assert.equal(
		result.stderr,
		"Error: AZURE_DEVOPS_PAT is still an op:// reference. pr.sh resolves references from regular .env files, but a 1Password Environment mount must contain the literal PAT.\n",
	);
});

test("the entrypoint still reads argv and prints help before requiring a PAT", () => {
	assertSuccessfulHelp(runCliWithEnv({}, "--help"));
	const result = runCliWithEnv({}, "pr", "list");
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, missingPatError);
});

test("resolve normalizes all supported statuses and defaults to fixed", () => {
	for (const status of ["fixed", "wontFix", "byDesign", "closed"]) {
		for (const value of [status, status.toUpperCase(), status.toLowerCase()]) {
			assert.deepEqual(
				parseOptions([
					"comment",
					"resolve",
					"--thread",
					"9",
					"--status",
					value,
				]),
				{
					resource: "comment",
					command: "resolve",
					pr: undefined,
					thread: 9,
					status,
				},
			);
		}
	}
	assert.equal(
		parseOptions(["comment", "resolve", "--thread", "9"]).status,
		"fixed",
	);
});

test("resolve rejects invalid and missing status values", () => {
	for (const value of ["active", "pending", "unknown", ""]) {
		assertUsageError(
			runCli("comment", "resolve", "--thread", "9", `--status=${value}`),
			`Error: invalid --status "${value}" (must be one of: fixed, wontFix, byDesign, closed)`,
		);
	}
	assertUsageError(
		runCli("comment", "resolve", "--thread", "9", "--status"),
		"Error: --status requires an explicit value",
	);
	assertUsageError(
		runCli("comment", "resolve", "--help", "--status", "active"),
		'Error: invalid --status "active" (must be one of: fixed, wontFix, byDesign, closed)',
	);
});

test("reopen requires a thread and accepts only thread and PR flags", () => {
	assert.deepEqual(
		parseOptions(["comment", "reopen", "--thread", "9", "--pr", "42"]),
		{
			resource: "comment",
			command: "reopen",
			pr: 42,
			thread: 9,
		},
	);
	assert.deepEqual(parseOptions(["comment", "reopen", "--thread", "9"]), {
		resource: "comment",
		command: "reopen",
		pr: undefined,
		thread: 9,
	});
	assertUsageError(
		runCli("comment", "reopen"),
		'Error: --thread is required for "comment reopen"',
	);
	assertUsageError(
		runCli("comment", "reopen", "--thread", "9", "--status", "fixed"),
		'Error: --status is not valid for "comment reopen"',
	);
	const result = runCli("comment", "reopen", "--help");
	assertSuccessfulHelp(result);
	assert.ok(result.stderr.includes("comment reopen --thread <id> [--pr <id>]"));
});

test("latest selection parses for show/wait and keeps help validation consistent", () => {
	for (const command of ["show", "wait"]) {
		const parsed = parseArgs(["build", command, "--latest", "--pr=42"]);
		assert.equal(parsed.latest, true);
		assert.equal(parsed.build, undefined);
		assert.equal(parsed.pr, 42);
		assert.equal(parsed.command, command);
		assert.equal(runCli("build", command, "--help").status, 0);
		assertUsageError(
			runCli("build", command, "--build=7", "--latest", "--help"),
			`Error: --build and --latest are mutually exclusive for "build ${command}"`,
		);
		assertUsageError(
			runCli("build", command, "--latest=false"),
			"Error: --latest does not take a value",
		);
	}
	assertUsageError(
		runCli("build", "list", "--latest"),
		'Error: --latest is not valid for "build list"',
	);
	assertUsageError(
		runCli("build", "retry", "--build=7", "--latest"),
		'Error: --latest is not valid for "build retry"',
	);
});
