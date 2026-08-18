import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildWaitExitCode } from "../operation-types.ts";
import { spawnTestProcess } from "./test-helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../pr.ts", import.meta.url));
const usageFirstLine = "Usage: pr.sh pr list [--json]";
const missingPatError =
  "Error: AZURE_DEVOPS_PAT is not set. Export it before running pr.ts, or configure it in .env and run pr.sh.\n";
const childEnvAllowlist = new Set([
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
      ([key, value]) => value !== undefined && childEnvAllowlist.has(key.toUpperCase()),
    ),
  );
}

function runCliWithEnv(envOverrides, ...args) {
  const env = minimalChildEnv();
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AZURE_DEVOPS_PAT, undefined);

  return spawnTestProcess(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cliPath, ...args],
    {
      cwd: projectRoot,
      description: `pr.ts ${JSON.stringify(args)}`,
      encoding: "utf8",
      env: { ...env, ...envOverrides },
    },
  );
}

function runCli(...args) {
  return runCliWithEnv({}, ...args);
}

function firstLine(output) {
  return output.split(/\r?\n/, 1)[0];
}

function assertUsageError(result, expectedError) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(firstLine(result.stderr), expectedError);
  assert.ok(result.stderr.startsWith(`${expectedError}\n\n${usageFirstLine}\n`));
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
    assert.match(result.stderr, new RegExp(`pr\\.sh ${command.replace(" ", " ")}`));
  }
  assert.match(result.stderr, /--draft \| --no-draft/);
  assert.match(result.stderr, /--image <path>/);
  assert.match(result.stderr, /--remove-image <filename>/);
  assert.match(result.stderr, /--reviewer <email-or-display-name>/);
  assert.match(result.stderr, /Identity \(Read\)/);
  assert.match(result.stderr, /maximum 4,000 characters/);
  assert.match(result.stderr, /\{\{image:<basename>\}\}/);
  assert.match(result.stderr, /every\s+such placeholder needs a corresponding --image/);
  assert.match(result.stderr, /  --no-draft\s+Mark an existing PR as ready/);
  assert.match(result.stderr, /  -h, --help\s+Show this help\./);

  for (const shape of [
    '{"command":"comment.create","message":"...","pr"?:n,"file"?:"...","line"?:n,"endLine"?:n}',
    '{"command":"comment.reply","thread":n,"message":"...","pr"?:n}',
    '{"command":"comment.edit","thread":n,"comment":n,"message":"...","pr"?:n}',
    '{"command":"comment.delete","thread":n,"comment":n,"pr"?:n}',
    '{"command":"comment.resolve","thread":n,"pr"?:n}',
  ]) {
    assert.ok(result.stderr.includes(shape));
  }
  assert.match(result.stderr, /Per-operation "pr" overrides the command's --pr\/default PR/);
  assert.match(
    result.stderr,
    /Unknown fields and\s+fields irrelevant to the selected command are invalid\./,
  );
  assert.match(result.stderr, /Operations execute sequentially in array\s+order\./);
  assert.match(result.stderr, /A failed operation is reported and later operations still run/);
  assert.match(result.stderr, /process exits nonzero if any operation failed\./);

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
  assertSuccessfulHelp(runCli("build", "wait", "--build", "42", "--interval", "10", "--timeout", "86400", "--help"));
});

test("help does not mask malformed command-like invocations", () => {
  const cases = [
    [["pr", "--help"], 'Error: a command is required for resource "pr"'],
    [["mystery", "show", "--help"], 'Error: unknown resource "mystery"'],
    [["pr", "mystery", "--help"], 'Error: unknown command "mystery" for resource "pr"'],
    [["pr", "show", "extra", "--help"], 'Error: unexpected positional argument "extra"'],
    [["pr", "show", "--json", "--json", "--help"], "Error: --json may only be passed once"],
    [["pr", "show", "--help", "-h"], "Error: -h may only be passed once"],
    [["pr", "show", "--title", "x", "--help"], 'Error: --title is not valid for "pr show"'],
    [["pr", "show", "--bogus", "--help"], 'Error: unknown option "--bogus"'],
    [
      ["pr", "show", "--pr", "0", "--help"],
      'Error: invalid --pr "0" (pass it once, as a single positive integer)',
    ],
    [["build", "retry", "--build", "1", "--build", "2"], "Error: --build may only be passed once"],
    [
      ["pr", "edit", "--draft", "--no-draft", "--help"],
      "Error: --draft and --no-draft cannot be used together",
    ],
    [["comment", "create", "--line", "2", "--help"], "Error: --line requires --file"],
  ];

  for (const [args, expected] of cases) {
    assertUsageError(runCli(...args), expected);
  }
});

test("no command is a usage error instead of defaulting to comment list", () => {
  assertUsageError(runCli(), "Error: a resource and command are required");
  assertUsageError(runCli("comment"), 'Error: a command is required for resource "comment"');
  assertUsageError(runCli("pr"), 'Error: a command is required for resource "pr"');
});

test("unknown resources, commands, and extra positional arguments are rejected", () => {
  assertUsageError(runCli("mystery", "show"), 'Error: unknown resource "mystery"');
  assertUsageError(runCli("pr", "mystery"), 'Error: unknown command "mystery" for resource "pr"');
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
    assertUsageError(runCli(action, "--help"), `Error: unknown resource "${action}"`);
  }

  assertUsageError(
    runCli("comment", "--help"),
    'Error: a command is required for resource "comment"',
  );
  for (const help of [undefined, "--help"]) {
    const args = ["comment", "--message", "old", ...(help ? [help] : [])];
    assertUsageError(runCli(...args), 'Error: a command is required for resource "comment"');
  }
});

test("build wait maps completed and timeout outcomes to stable exit codes", () => {
  assert.equal(buildWaitExitCode({ timedOut: false, outcome: "succeeded" }), 0);
  for (const outcome of ["partiallySucceeded", "failed", "canceled", "unknown"]) {
    assert.equal(buildWaitExitCode({ timedOut: false, outcome }), 1);
  }
  assert.equal(buildWaitExitCode({ timedOut: true, outcome: "timeout" }), 124);
  assert.equal(buildWaitExitCode({ timedOut: true, outcome: "succeeded" }), 124);
});

test("build wait defaults, accepts bounds, and validates its parser contract", () => {
  assertParsedBeforePat("build", "wait", "--build", "7");
  assertParsedBeforePat("build", "wait", "--build=7", "--pr=42", "--interval=10", "--timeout", "86400");
  for (const [args, expected] of [
    [["build", "wait", "--build", "7", "--interval", "9"], "Error: --interval must be between 10 and 3600 seconds"],
    [["build", "wait", "--build", "7", "--interval", "3601"], "Error: --interval must be between 10 and 3600 seconds"],
    [["build", "wait", "--build", "7", "--timeout", "9"], "Error: --timeout must be between 10 and 86400 seconds"],
    [["build", "wait", "--build", "7", "--timeout", "86401"], "Error: --timeout must be between 10 and 86400 seconds"],
    [["build", "wait", "--build", "7", "--interval"], "Error: --interval requires an explicit value"],
    [["build", "wait", "--build", "7", "--timeout"], "Error: --timeout requires an explicit value"],
    [["build", "wait", "--build", "7", "--timeout="], 'Error: invalid --timeout "" (pass it once, as a single positive integer)'],
    [["build", "wait", "--build", "7", "--interval", "9007199254740993"], 'Error: invalid --interval "9007199254740993" (pass it once, as a single positive integer)'],
    [["build", "wait", "--build", "7", "--timeout", "9007199254740993"], 'Error: invalid --timeout "9007199254740993" (pass it once, as a single positive integer)'],
    [["build", "wait", "--build", "7", "--interval", "10", "--interval", "20"], "Error: --interval may only be passed once"],
    [["build", "wait", "--build", "7", "--timeout", "10", "--timeout", "20"], "Error: --timeout may only be passed once"],
    [["build", "wait", "--build", "7", "--json", "--interval", "9"], "Error: --interval must be between 10 and 3600 seconds"],
    [["build", "wait", "--build", "7", "--history"], 'Error: --history is not valid for "build wait"'],
  ]) assertUsageError(runCli(...args), expected);
});

test("build flags parse with registry-derived types and reject missing or foreign options", () => {
  assertParsedBeforePat("build", "list", "--history");
  assertParsedBeforePat("build", "show", "--build", "7", "--full-logs");
  assertParsedBeforePat("build", "retry", "--build", "7", "--pr", "42");

  for (const command of ["show", "retry", "wait"]) {
    assertUsageError(
      runCli("build", command),
      `Error: --build is required for "build ${command}"`,
    );
    assertUsageError(
      runCli("build", command, "--build", "0"),
      'Error: invalid --build "0" (pass it once, as a single positive integer)',
    );
  }
  for (const [args, expected] of [
    [["build", "list", "--build", "7"], 'Error: --build is not valid for "build list"'],
    [["build", "show", "--build", "7", "--history"], 'Error: --history is not valid for "build show"'],
    [["build", "retry", "--build", "7", "--json"], 'Error: --json is not valid for "build retry"'],
    [["build", "list", "--full-logs"], 'Error: --full-logs is not valid for "build list"'],
  ]) {
    assertUsageError(runCli(...args), expected);
  }
});

test("unknown flags and invalid boolean values are rejected", () => {
  assertUsageError(runCli("pr", "show", "--bogus"), 'Error: unknown option "--bogus"');
  assertUsageError(runCli("pr", "show", "-x"), 'Error: unknown option "-x"');
  assertUsageError(runCli("pr", "show", "--json=true"), "Error: --json does not take a value");
});

test("each command rejects options belonging to other commands", () => {
  const cases = [
    [["pr", "list", "--pr", "1"], 'Error: --pr is not valid for "pr list"'],
    [["pr", "show", "--title", "x"], 'Error: --title is not valid for "pr show"'],
    [["pr", "create", "--title", "x", "--pr", "1"], 'Error: --pr is not valid for "pr create"'],
    [
      ["pr", "create", "--title", "x", "--remove-image", "old.png"],
      'Error: --remove-image is not valid for "pr create"',
    ],
    [
      ["pr", "create", "--title", "x", "--remove-reviewer", "Ada"],
      'Error: --remove-reviewer is not valid for "pr create"',
    ],
    [["pr", "edit", "--draft", "--json"], 'Error: --json is not valid for "pr edit"'],
    [["comment", "list", "--message", "x"], 'Error: --message is not valid for "comment list"'],
    [
      ["comment", "create", "--message", "x", "--json"],
      'Error: --json is not valid for "comment create"',
    ],
    [
      ["comment", "reply", "--thread", "1", "--message", "x", "--comment", "2"],
      'Error: --comment is not valid for "comment reply"',
    ],
    [
      ["comment", "edit", "--thread", "1", "--comment", "2", "--message", "x", "--file", "a.ts"],
      'Error: --file is not valid for "comment edit"',
    ],
    [
      ["comment", "delete", "--thread", "1", "--comment", "2", "--message", "x"],
      'Error: --message is not valid for "comment delete"',
    ],
    [
      ["comment", "resolve", "--thread", "1", "--comment", "2"],
      'Error: --comment is not valid for "comment resolve"',
    ],
    [["comment", "batch", "--json"], 'Error: --json is not valid for "comment batch"'],
  ];

  for (const [args, expected] of cases) {
    assertUsageError(runCli(...args), expected);
  }
});

test("required command options are validated in dependency order", () => {
  assertUsageError(runCli("pr", "create"), 'Error: --title is required for "pr create"');
  assertUsageError(
    runCli("comment", "create"),
    'Error: --message is required for "comment create"',
  );

  assertUsageError(runCli("comment", "reply"), 'Error: --thread is required for "comment reply"');
  assertUsageError(
    runCli("comment", "reply", "--thread", "7"),
    'Error: --message is required for "comment reply"',
  );

  assertUsageError(runCli("comment", "edit"), 'Error: --thread is required for "comment edit"');
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
    ["pr", "edit", "--reviewer", "Ada Lovelace", "--reviewer", "grace@example.test"],
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
    const prefix = ["pr", command, ...(command === "create" ? ["--title", "x"] : [])];
    assertUsageError(runCli(...prefix, `--${flag}=`), `Error: --${flag} must not be empty`);
    assertUsageError(runCli(...prefix, `--${flag}`, ""), `Error: --${flag} must not be empty`);
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
    runCli("comment", "create", "--message", "x", "--file", "a.ts", "--end-line", "3"),
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
    runCli("comment", "create", "--message", "x", "--file", "a.ts", "--line", "-1"),
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
