import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createMockFetch,
  createTempGitRepo,
  gitTestEnvironment,
  isolateGitEnvironment,
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

test("createMockFetch rejects an unexpected request and records it", async (t) => {
  const { fetch, calls } = createMockFetch(t);

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

test("createMockFetch reports responses left unused during test teardown", () => {
  const script = `
    import test from "node:test";
    import { createMockFetch } from ${JSON.stringify(testHelpersUrl)};
    test("leaves a response", (t) => createMockFetch(t, [{ json: {} }]));
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

test("createMockFetch validates queued response fixtures eagerly", (t) => {
  assert.throws(() => createMockFetch(t, {}), {
    name: "TypeError",
    message: "Queued fetch responses must be an array",
  });
  assert.throws(() => createMockFetch(t, [null]), {
    name: "TypeError",
    message: "Queued fetch response 1 must be a Response or descriptor object",
  });
  assert.throws(() => createMockFetch(t, [{ delayMs: -1 }]), {
    name: "TypeError",
    message: "Queued fetch response 1 has an invalid delayMs",
  });
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

test("Git environment helpers remove injection and restore serial in-process state", async (t) => {
  const ambientEnvironment = {
    GIT_CONFIG_GLOBAL: "/hostile/global-config",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://dev.azure.com/",
    GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
    GIT_ASKPASS: "/hostile/askpass",
    GIT_SSH_COMMAND: "hostile-ssh-command",
    GCM_INTERACTIVE: "Always",
    GCM_CREDENTIAL_STORE: "hostile-store",
    SSH_ASKPASS: "/hostile/ssh-askpass",
  };
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    restoreEnv(t, name, process.env[name]);
    process.env[name] = value;
  }

  const childEnvironment = gitTestEnvironment();
  assert.equal(childEnvironment.PATH, process.env.PATH);
  assert.equal(childEnvironment.HOME, process.env.HOME);
  assert.equal(childEnvironment.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(childEnvironment.GIT_CONFIG_COUNT, "0");
  assert.equal(childEnvironment.GCM_INTERACTIVE, "Never");
  assert.equal(childEnvironment.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(childEnvironment.GIT_ASKPASS, undefined);
  assert.equal(childEnvironment.GCM_CREDENTIAL_STORE, undefined);
  assert.equal(childEnvironment.SSH_ASKPASS, undefined);

  await t.test("isolates production-style ambient Git calls", { concurrency: false }, (t) => {
    isolateGitEnvironment(t);

    assert.equal(process.env.GIT_CONFIG_GLOBAL, devNull);
    assert.equal(process.env.GIT_CONFIG_COUNT, "0");
    assert.equal(process.env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(process.env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(process.env.GIT_ASKPASS, undefined);
    assert.equal(process.env.GIT_SSH_COMMAND, undefined);
    assert.equal(process.env.GCM_INTERACTIVE, "Never");
    assert.equal(process.env.GCM_CREDENTIAL_STORE, undefined);
    assert.equal(process.env.SSH_ASKPASS, undefined);

    const result = spawnTestProcess("git", ["config", "--global", "--get", "commit.gpgSign"], {
      encoding: "utf8",
      description: "isolated ambient git config lookup",
    });
    assert.equal(result.status, 1);
  });

  for (const [name, value] of Object.entries(ambientEnvironment)) {
    assert.equal(process.env[name], value);
  }
});

test("spawnTestProcess hard-kills a child that handles SIGTERM", () => {
  assert.equal(TEST_SUBPROCESS_TIMEOUT_MS, 15_000);
  const timeout = 250;
  const startedAt = Date.now();
  assert.throws(
    () =>
      spawnTestProcess(
        process.execPath,
        [
          "--eval",
          "process.on('SIGTERM', () => {}); " +
            "process.stderr.write('ready'); setInterval(() => {}, 10_000)",
        ],
        {
          encoding: "utf8",
          timeout,
          description: "SIGTERM-resistant helper subprocess",
        },
      ),
    /SIGTERM-resistant helper subprocess timed out after 250ms/,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed >= timeout - 50,
    `child returned before the ${timeout}ms timeout: ${elapsed}ms`,
  );
  assert.ok(elapsed < 2_000, `SIGTERM-resistant child returned too late: ${elapsed}ms`);
});

test("spawnTestProcess preserves diagnostics from a cooperative timeout", () => {
  assert.throws(
    () =>
      spawnTestProcess(
        process.execPath,
        ["--eval", "process.stderr.write('waiting'); setInterval(() => {}, 10_000)"],
        {
          encoding: "utf8",
          timeout: 250,
          killSignal: "SIGTERM",
          description: "cooperative helper subprocess",
        },
      ),
    /cooperative helper subprocess timed out after 250ms\nstderr:\nwaiting/,
  );
});

test("runPr rejects non-finite response delays before serializing fixtures", (t) => {
  for (const delayMs of [Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(() => runPr(t, ["--help"], { responses: [{ delayMs }] }), {
      name: "TypeError",
      message: "Queued fetch response 1 has an invalid delayMs",
    });
  }
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

  const nonArray = spawnPreload({
    ADO_PR_TEST_FETCH_RESPONSES: "{}",
    ADO_PR_TEST_FETCH_CALLS_FILE: callsPath,
  });
  assert.equal(nonArray.status, 1);
  assert.match(nonArray.stderr, /Queued fetch responses must be an array/);

  const invalidDescriptor = spawnPreload({
    ADO_PR_TEST_FETCH_RESPONSES: "[null]",
    ADO_PR_TEST_FETCH_CALLS_FILE: callsPath,
  });
  assert.equal(invalidDescriptor.status, 1);
  assert.match(
    invalidDescriptor.stderr,
    /Queued fetch response 1 must be a Response or descriptor object/,
  );

  const invalidDelay = spawnPreload({
    ADO_PR_TEST_FETCH_RESPONSES: '[{"delayMs":-1}]',
    ADO_PR_TEST_FETCH_CALLS_FILE: callsPath,
  });
  assert.equal(invalidDelay.status, 1);
  assert.match(invalidDelay.stderr, /Queued fetch response 1 has an invalid delayMs/);
});
