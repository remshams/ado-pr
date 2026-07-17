import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../pr.ts", import.meta.url));
const usageFirstLine =
  "Usage: pr.sh [list] [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]";

function runCli(...args) {
  const env = { ...process.env };
  delete env.AZURE_DEVOPS_PAT;

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
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
  assert.match(result.stderr, /\nActions:\n/);
  assert.match(result.stderr, /  reply\s+Posts a reply comment to an existing thread\./);
  assert.match(result.stderr, /\nOptions:\n/);
  assert.match(result.stderr, /  --thread <id>\s+Required for reply\/resolve\./);
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
    "Error: AZURE_DEVOPS_PAT is not set. Run this via pr.sh, which injects it from 1Password.\n",
  );
});
