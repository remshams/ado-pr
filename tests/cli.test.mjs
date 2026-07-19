import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawnTestProcess } from "./test-helpers.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../pr.ts", import.meta.url));
const usageFirstLine =
  "Usage: pr.sh [list] [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]";
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

  const result = spawnTestProcess(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cliPath, ...args],
    {
      cwd: projectRoot,
      description: `pr.ts ${JSON.stringify(args)}`,
      encoding: "utf8",
      env: { ...env, ...envOverrides },
    },
  );

  return result;
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

test("--help prints the documented actions and options", () => {
  const result = runCli("--help");

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(firstLine(result.stderr), usageFirstLine);
  assert.ok(
    result.stderr.includes(
      '       pr.sh edit --thread <id> --comment <id> --message "..." [--pr <id>]',
    ),
  );
  assert.ok(result.stderr.includes("       pr.sh delete --thread <id> --comment <id> [--pr <id>]"));
  assert.match(result.stderr, /\nActions:\n/);
  assert.match(result.stderr, /  reply\s+Posts a reply comment to an existing thread\./);
  assert.match(result.stderr, /  edit\s+Edits an existing comment in a thread\./);
  assert.match(result.stderr, /  delete\s+Deletes an existing comment from a thread\./);
  assert.match(result.stderr, /\nOptions:\n/);
  assert.match(result.stderr, /  --thread <id>\s+Required for reply\/edit\/delete\/resolve\./);
  assert.match(result.stderr, /  --comment <id>\s+Required for edit\/delete\./);
  assert.match(result.stderr, /  --message <text>\s+Required for comment\/reply\/edit\./);
  assert.match(result.stderr, /  -h, --help\s+Show this help\./);
  assert.match(result.stderr, /\nRequires:\n/);
});

test("an unknown action reports the action before usage", () => {
  const result = runCli("mystery");

  assertUsageError(result, 'Error: unknown action "mystery"');
  assert.match(result.stderr, /\nActions:\n/);
});

test("reply validates a missing thread before a missing message", () => {
  const missingBoth = runCli("reply");
  assertUsageError(missingBoth, 'Error: --thread is required for "reply"');

  const missingMessage = runCli("reply", "--thread", "7");
  assertUsageError(missingMessage, 'Error: --message is required for "reply"');
});

test("edit requires a thread, comment, and message in order", () => {
  const missingAll = runCli("edit");
  assertUsageError(missingAll, 'Error: --thread is required for "edit"');

  const missingComment = runCli("edit", "--thread", "7");
  assertUsageError(missingComment, 'Error: --comment is required for "edit"');

  const missingMessage = runCli("edit", "--thread", "7", "--comment", "8");
  assertUsageError(missingMessage, 'Error: --message is required for "edit"');
});

test("delete requires a thread and comment, but not a message", () => {
  const missingBoth = runCli("delete");
  assertUsageError(missingBoth, 'Error: --thread is required for "delete"');

  const missingComment = runCli("delete", "--thread", "7");
  assertUsageError(missingComment, 'Error: --comment is required for "delete"');

  const valid = runCli("delete", "--thread", "7", "--comment", "8");
  assert.equal(valid.status, 1);
  assert.equal(valid.stdout, "");
  assert.equal(
    valid.stderr,
    "Error: AZURE_DEVOPS_PAT is not set. Export it before running pr.ts, or configure it in .env and run pr.sh.\n",
  );
});

test("comment IDs must be positive integers", () => {
  const result = runCli("delete", "--thread", "7", "--comment", "0");

  assertUsageError(
    result,
    'Error: invalid --comment "0" (pass it once, as a single positive integer)',
  );
});

test("a repeated string flag is rejected", () => {
  const result = runCli("comment", "--message", "first", "--message", "second");

  assertUsageError(
    result,
    'Error: invalid --message "first,second" (pass it once, as a single string)',
  );
});

test("a non-positive integer flag is rejected", () => {
  const result = runCli("resolve", "--thread", "0");

  assertUsageError(
    result,
    'Error: invalid --thread "0" (pass it once, as a single positive integer)',
  );
});

test("a valid command fails cleanly when AZURE_DEVOPS_PAT is absent", () => {
  const result = runCli("resolve", "--thread", "7");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Error: AZURE_DEVOPS_PAT is not set. Export it before running pr.ts, or configure it in .env and run pr.sh.\n",
  );
});

test("an unresolved op reference explains that an Environment mount needs a literal PAT", () => {
  const result = runCliWithEnv(
    { AZURE_DEVOPS_PAT: "op://Private/Azure DevOps/PAT" },
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
