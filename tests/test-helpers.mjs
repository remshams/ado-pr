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
const ENV_PROBE_NAMES_ENV = "ADO_PR_TEST_ENV_PROBE_NAMES";
const ENV_PROBE_FILE_ENV = "ADO_PR_TEST_ENV_PROBE_FILE";
const DEFAULT_RUN_TIMEOUT_MS = 15_000;

// Keep subprocesses usable on macOS/Linux/Windows without inheriting credentials, proxy settings,
// NODE_OPTIONS, or other ambient process configuration from the developer's shell.
const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
];

function inheritedTestEnvironment() {
  return Object.fromEntries(
    INHERITED_ENV_ALLOWLIST.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

/**
 * Helpers that replace `fetch`, `process.stdin`, `process.exitCode`, or console methods mutate
 * process-global state. Use them only in tests that run serially within the same test process;
 * their state is restored automatically through `t.mock` or `t.after`.
 */

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
 * `{ body?, json?, status?, statusText?, headers?, delayMs? }`. Every request is exposed
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
    const descriptor = queue.shift();
    if (descriptor?.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, descriptor.delayMs));
    }
    return responseFromDescriptor(descriptor);
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

/**
 * Replaces `process.stdin` with a finite readable stream for one serial test.
 * Do not use concurrently with another global-state helper in the same process.
 */
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

/**
 * Clears `process.exitCode` and restores its prior value after one serial test.
 * Do not use concurrently with another global-state helper in the same process.
 */
export function isolateExitCode(t) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = previous;
  });
}

/**
 * Captures selected console methods for one serial test as ordered `{ method, args }` records.
 * Do not use concurrently with another console capture in the same process.
 */
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
 * the process boundary). Only cross-platform path/temp/locale/system variables
 * are inherited; `env` supplies explicit test-only overrides, after which the
 * Azure PAT and fixture variables are forcibly set. In particular, an ambient
 * `NODE_OPTIONS` or real Azure PAT can never reach the child.
 *
 * Node 22.6 labels type stripping experimental and supports the targeted
 * `--disable-warning=ExperimentalWarning` flag. Passing it on the command line
 * keeps that runtime notice out of application stderr without hiding unrelated
 * warnings or relying on an inheritable `NODE_OPTIONS` setting.
 *
 * `inspectEnv` optionally returns selected child values in `environment` for
 * infrastructure assertions. The subprocess is killed after `timeout` ms.
 * Returns the normal `spawnSync` result plus parsed `calls` and `environment`.
 */
export function runPr(
  t,
  args = [],
  {
    cwd = projectRoot,
    responses = [],
    stdin,
    env = {},
    fakePat = "test-only-fake-pat",
    inspectEnv = [],
    timeout = DEFAULT_RUN_TIMEOUT_MS,
  } = {},
) {
  assert.ok(Array.isArray(args), "runPr args must be an array");
  assert.ok(
    responses.every((response) => !(response instanceof Response)),
    "runPr responses must be serializable descriptors, not Response objects",
  );
  assert.ok(Number.isFinite(timeout) && timeout > 0, "runPr timeout must be a positive number");
  assert.ok(
    inspectEnv.every((name) => typeof name === "string"),
    "runPr inspectEnv entries must be strings",
  );

  const tempPath = mkdtempSync(join(tmpdir(), "ado-pr-test-run-"));
  const callsPath = join(tempPath, "fetch-calls.json");
  const environmentPath = join(tempPath, "environment.json");
  writeFileSync(callsPath, "[]\n");
  writeFileSync(environmentPath, "{}\n");
  t.after(() => rmSync(tempPath, { recursive: true, force: true }));

  const childEnv = { ...inheritedTestEnvironment(), ...env };
  childEnv.AZURE_DEVOPS_PAT = fakePat;
  childEnv[FETCH_RESPONSES_ENV] = JSON.stringify(responses);
  childEnv[FETCH_CALLS_FILE_ENV] = callsPath;
  childEnv[ENV_PROBE_NAMES_ENV] = JSON.stringify(inspectEnv);
  childEnv[ENV_PROBE_FILE_ENV] = environmentPath;

  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      fetchPreloadPath,
      prPath,
      ...args,
    ],
    {
      cwd,
      env: childEnv,
      encoding: "utf8",
      input: stdin,
      timeout,
    },
  );

  if (result.error?.code === "ETIMEDOUT") {
    assert.fail(
      `pr.ts timed out after ${timeout}ms` +
        `${result.stdout ? `\nstdout:\n${result.stdout}` : ""}` +
        `${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`,
    );
  }
  assert.equal(result.error, undefined, `Failed to spawn pr.ts: ${result.error?.message}`);
  assert.equal(result.signal, null);
  return {
    ...result,
    calls: JSON.parse(readFileSync(callsPath, "utf8")),
    environment: JSON.parse(readFileSync(environmentPath, "utf8")),
  };
}
