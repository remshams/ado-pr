import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const prPath = fileURLToPath(new URL("../pr.ts", import.meta.url));
const fetchPreloadPath = fileURLToPath(new URL("./fixtures/fetch-preload.mjs", import.meta.url));
const FETCH_RESPONSES_ENV = "ADO_PR_TEST_FETCH_RESPONSES";
const FETCH_CALLS_FILE_ENV = "ADO_PR_TEST_FETCH_CALLS_FILE";

function responseFromDescriptor(descriptor) {
  if (descriptor instanceof Response) return descriptor;

  const headers = new Headers(descriptor.headers);
  let body = descriptor.body ?? null;
  if (Object.hasOwn(descriptor, "json")) {
    body = JSON.stringify(descriptor.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  return new Response(body, {
    status: descriptor.status ?? 200,
    statusText: descriptor.statusText,
    headers,
  });
}

async function recordRequest(input, init) {
  const request = new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body === null ? null : await request.clone().text(),
  };
}

/**
 * Replaces `globalThis.fetch` for one test with a strict FIFO response queue.
 *
 * Queue entries may be native `Response` objects or descriptors containing
 * `{ body?, json?, status?, statusText?, headers? }`. Every request is exposed
 * through `calls`; an unexpected request rejects immediately, and unused
 * responses fail the test during teardown.
 */
export function mockFetch(t, responses = []) {
  const queue = [...responses];
  const calls = [];

  t.mock.method(globalThis, "fetch", async (input, init) => {
    const call = await recordRequest(input, init);
    calls.push(call);
    assert.ok(queue.length > 0, `Unexpected fetch request: ${call.method} ${call.url}`);
    return responseFromDescriptor(queue.shift());
  });

  t.after(() => {
    assert.equal(queue.length, 0, `${queue.length} queued fetch response(s) were not consumed`);
  });

  return calls;
}

/**
 * Creates a temporary Git repository with one committed README. The returned
 * path is removed when the test ends. Pass `origin` and/or `branch` to configure
 * repository context used by CLI tests; the default branch is `main`.
 */
export function createTempGitRepo(t, { origin, branch = "main" } = {}) {
  const path = mkdtempSync(join(tmpdir(), "ado-pr-test-repo-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));

  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout.trim();
  };

  git("init", "--initial-branch", branch);
  git("config", "user.name", "ado-pr tests");
  git("config", "user.email", "ado-pr-tests@example.invalid");
  writeFileSync(join(path, "README.md"), "# Test repository\n");
  git("add", "README.md");
  git("commit", "-m", "Initial commit");
  if (origin !== undefined) git("remote", "add", "origin", origin);

  return path;
}

/** Replaces `process.stdin` with a finite readable stream for one test. */
export function mockStdin(t, input) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  assert.ok(descriptor?.configurable, "process.stdin cannot be safely replaced");

  const stream = Readable.from([input]);
  Object.defineProperty(process, "stdin", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: true,
    value: stream,
  });
  t.after(() => {
    stream.destroy();
    Object.defineProperty(process, "stdin", descriptor);
  });
  return stream;
}

/** Clears `process.exitCode` and restores its prior value after the test. */
export function isolateExitCode(t) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = previous;
  });
}

/** Captures selected console methods and returns ordered `{ method, args }` records. */
export function captureConsole(t, methods = ["log", "error", "warn"]) {
  const calls = [];
  for (const method of methods) {
    assert.equal(typeof console[method], "function", `console.${method} is not a function`);
    t.mock.method(console, method, (...args) => calls.push({ method, args }));
  }
  return calls;
}

/**
 * Runs `pr.ts` in an isolated subprocess using Node's TypeScript stripping and
 * the fetch preload fixture. `responses` uses the same descriptor shape as
 * `mockFetch` (native `Response` objects are intentionally unsupported across
 * the process boundary). The inherited Azure PAT is always replaced by a fake.
 *
 * Returns the normal `spawnSync` result plus a parsed `calls` array.
 */
export function runPr(
  t,
  args = [],
  { cwd = projectRoot, responses = [], stdin, env = {}, fakePat = "test-only-fake-pat" } = {},
) {
  assert.ok(Array.isArray(args), "runPr args must be an array");
  assert.ok(
    responses.every((response) => !(response instanceof Response)),
    "runPr responses must be serializable descriptors, not Response objects",
  );

  const tempPath = mkdtempSync(join(tmpdir(), "ado-pr-test-run-"));
  const callsPath = join(tempPath, "fetch-calls.json");
  writeFileSync(callsPath, "[]\n");
  t.after(() => rmSync(tempPath, { recursive: true, force: true }));

  const childEnv = { ...process.env, ...env };
  delete childEnv[FETCH_RESPONSES_ENV];
  delete childEnv[FETCH_CALLS_FILE_ENV];
  childEnv.AZURE_DEVOPS_PAT = fakePat;
  childEnv[FETCH_RESPONSES_ENV] = JSON.stringify(responses);
  childEnv[FETCH_CALLS_FILE_ENV] = callsPath;

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", fetchPreloadPath, prPath, ...args],
    {
      cwd,
      env: childEnv,
      encoding: "utf8",
      input: stdin,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { ...result, calls: JSON.parse(readFileSync(callsPath, "utf8")) };
}
