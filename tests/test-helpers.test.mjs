import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTempGitRepo,
  mockFetch,
  runPr,
  spawnTestProcess,
  TEST_SUBPROCESS_TIMEOUT_MS,
} from "./test-helpers.mjs";

const fetchPreloadPath = fileURLToPath(new URL("./fixtures/fetch-preload.mjs", import.meta.url));
const testHelpersUrl = new URL("./test-helpers.mjs", import.meta.url).href;
const origin = "https://dev.azure.com/test-org/test-project/_git/test-repo";
const expectedAuthorization = `Basic ${Buffer.from(":test-only-fake-pat").toString("base64")}`;

function createRepo(t) {
  return createTempGitRepo(t, { origin, branch: "test/infrastructure" });
}

function restoreEnv(t, name, value) {
  t.after(() => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
}

test("mockFetch rejects an unexpected request and records it", async (t) => {
  const calls = mockFetch(t);

  await assert.rejects(fetch("https://example.invalid/unexpected"), {
    message: "Unexpected fetch request: GET https://example.invalid/unexpected",
  });
  assert.deepEqual(calls, [
    {
      url: "https://example.invalid/unexpected",
      method: "GET",
      headers: {},
      body: null,
    },
  ]);
});

test("mockFetch reports responses left unused during test teardown", () => {
  const script = `
    import test from "node:test";
    import { mockFetch } from ${JSON.stringify(testHelpersUrl)};
    test("leaves a response", (t) => mockFetch(t, [{ json: {} }]));
  `;
  const result = spawnTestProcess(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    description: "unused-response test subprocess",
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /1 queued fetch response\(s\) were not consumed/,
  );
});

test("createTempGitRepo ignores hostile ambient Git configuration", (t) => {
  const hostilePath = mkdtempSync(join(tmpdir(), "ado-pr-hostile-git-"));
  const hooksPath = join(hostilePath, "hooks");
  const markerPath = join(hostilePath, "hook-ran");
  const globalConfigPath = join(hostilePath, "global.gitconfig");
  mkdirSync(hooksPath);
  writeFileSync(
    join(hooksPath, "pre-commit"),
    `#!/bin/sh\nprintf hook-ran > ${JSON.stringify(markerPath)}\nexit 91\n`,
  );
  chmodSync(join(hooksPath, "pre-commit"), 0o755);
  writeFileSync(
    globalConfigPath,
    `[commit]\n\tgpgSign = true\n[core]\n\thooksPath = ${JSON.stringify(hooksPath)}\n`,
  );
  t.after(() => rmSync(hostilePath, { recursive: true, force: true }));

  const hostileEnvironment = {
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
  };
  for (const [name, value] of Object.entries(hostileEnvironment)) {
    restoreEnv(t, name, process.env[name]);
    process.env[name] = value;
  }

  const repoPath = createTempGitRepo(t, { branch: "test/hostile-config" });

  assert.ok(existsSync(join(repoPath, ".git", "refs", "heads", "test", "hostile-config")));
  assert.equal(existsSync(markerPath), false);
});

test("spawnTestProcess applies a shared timeout with captured diagnostics", () => {
  assert.equal(TEST_SUBPROCESS_TIMEOUT_MS, 15_000);
  assert.throws(
    () =>
      spawnTestProcess(
        process.execPath,
        ["--eval", "process.stderr.write('waiting'); setTimeout(() => {}, 10_000)"],
        {
          encoding: "utf8",
          timeout: 250,
          description: "hanging helper subprocess",
        },
      ),
    /hanging helper subprocess timed out after 250ms\nstderr:\nwaiting/,
  );
});

test("runPr rejects unexpected requests and preserves their call record", (t) => {
  const result = runPr(t, ["list", "--pr", "7"], { cwd: createRepo(t) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected fetch request: GET /);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].url, /\/pullRequests\/7\/threads\?api-version=7\.1$/);
});

test("runPr makes unused preload responses fail the subprocess", (t) => {
  const result = runPr(t, ["--help"], { responses: [{ json: {} }] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 queued fetch response\(s\) were not consumed\n$/);
});

test("runPr records a request when the application fails", (t) => {
  const result = runPr(t, ["list", "--pr", "8"], {
    cwd: createRepo(t),
    responses: [{ status: 503, statusText: "Service Unavailable", body: "test outage" }],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /503 Service Unavailable\ntest outage/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, "GET");
});

test("runPr isolates ambient secrets and NODE_OPTIONS while enforcing the fake PAT", (t) => {
  const secretName = "ADO_PR_TEST_AMBIENT_SECRET";
  const explicitName = "ADO_PR_TEST_EXPLICIT_VALUE";
  restoreEnv(t, secretName, process.env[secretName]);
  restoreEnv(t, "NODE_OPTIONS", process.env.NODE_OPTIONS);
  process.env[secretName] = "must-not-leak";
  process.env.NODE_OPTIONS = "--definitely-not-a-real-node-option";

  const result = runPr(t, ["list", "--pr", "9", "--json"], {
    cwd: createRepo(t),
    responses: [{ json: { value: [] } }],
    env: {
      [explicitName]: "explicit-test-value",
      AZURE_DEVOPS_PAT: "attempted-real-token-override",
    },
    inspectEnv: [secretName, "NODE_OPTIONS", explicitName, "AZURE_DEVOPS_PAT"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.environment, {
    [secretName]: null,
    NODE_OPTIONS: null,
    [explicitName]: "explicit-test-value",
    AZURE_DEVOPS_PAT: "test-only-fake-pat",
  });
  assert.equal(result.calls[0].headers.authorization, expectedAuthorization);
});

test("runPr reports a bounded subprocess timeout", (t) => {
  assert.throws(
    () =>
      runPr(t, ["list", "--pr", "10"], {
        cwd: createRepo(t),
        responses: [{ delayMs: 2_000, json: { value: [] } }],
        timeout: 250,
      }),
    /pr\.ts timed out after 250ms/,
  );
});

test("fetch preload rejects missing and malformed configuration", (t) => {
  const tempPath = mkdtempSync(join(tmpdir(), "ado-pr-preload-test-"));
  const callsPath = join(tempPath, "calls.json");
  writeFileSync(callsPath, "[]\n");
  t.after(() => rmSync(tempPath, { recursive: true, force: true }));

  const spawnPreload = (env) =>
    spawnTestProcess(process.execPath, ["--import", fetchPreloadPath, "--eval", ""], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
      description: "fetch preload test subprocess",
    });

  const missing = spawnPreload({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Fetch preload requires ADO_PR_TEST_FETCH_RESPONSES/);

  const malformed = spawnPreload({
    ADO_PR_TEST_FETCH_RESPONSES: "not-json",
    ADO_PR_TEST_FETCH_CALLS_FILE: callsPath,
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /SyntaxError/);
});
