import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
	createFetchQueue,
	validateFetchResponses,
} from "./support/fetch-harness.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const prPath = fileURLToPath(new URL("../src/pr.ts", import.meta.url));
const fetchPreloadPath = fileURLToPath(
	new URL("./fixtures/fetch-preload.mjs", import.meta.url),
);
const FETCH_RESPONSES_ENV = "ADO_PR_TEST_FETCH_RESPONSES";
const FETCH_CALLS_FILE_ENV = "ADO_PR_TEST_FETCH_CALLS_FILE";
const ENV_PROBE_NAMES_ENV = "ADO_PR_TEST_ENV_PROBE_NAMES";
const ENV_PROBE_FILE_ENV = "ADO_PR_TEST_ENV_PROBE_FILE";

/** Default upper bound for every synchronous test subprocess. */
export const TEST_SUBPROCESS_TIMEOUT_MS = 15_000;

// Keep subprocesses usable on macOS/Linux/Windows without inheriting credentials, proxy settings,
// NODE_OPTIONS, or other ambient process configuration from the developer's shell.
const INHERITED_ENV_ALLOWLIST = [
	"NODE_V8_COVERAGE",
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

const NON_GIT_CREDENTIAL_ENV_NAMES = new Set([
	"SSH_ASKPASS",
	"SSH_ASKPASS_REQUIRE",
]);

function isGitEnvironmentName(name) {
	const normalized = name.toUpperCase();
	return (
		normalized.startsWith("GIT_") ||
		normalized.startsWith("GCM_") ||
		NON_GIT_CREDENTIAL_ENV_NAMES.has(normalized)
	);
}

/**
 * Builds a minimal child environment for deterministic Git commands. Ambient
 * Git configuration, URL rewrites, repository redirection, signing, hooks,
 * askpass, SSH, and credential-manager injection are omitted by construction.
 */
export function gitTestEnvironment() {
	return {
		...inheritedTestEnvironment(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: devNull,
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
	};
}

/**
 * Applies the same clean Git policy to serial in-process tests whose production
 * code spawns Git with the ambient `process.env`. All existing Git, GCM, and
 * askpass variables are restored after the test, including variables absent
 * when isolation began.
 */
export function isolateGitEnvironment(t) {
	const cleanEnvironment = gitTestEnvironment();
	const affectedNames = new Set([
		...Object.keys(process.env).filter(isGitEnvironmentName),
		...Object.keys(cleanEnvironment).filter(isGitEnvironmentName),
	]);
	const previousValues = new Map(
		[...affectedNames].map((name) => [name, process.env[name]]),
	);

	for (const name of Object.keys(process.env).filter(isGitEnvironmentName)) {
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(cleanEnvironment)) {
		if (isGitEnvironmentName(name)) process.env[name] = value;
	}

	t.after(() => {
		for (const name of Object.keys(process.env).filter(isGitEnvironmentName)) {
			delete process.env[name];
		}
		for (const [name, value] of previousValues) {
			if (value !== undefined) process.env[name] = value;
		}
	});
}

function capturedOutput(result) {
	return (
		`${result.stdout ? `\nstdout:\n${result.stdout}` : ""}` +
		`${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`
	);
}

/**
 * Runs a bounded synchronous test subprocess. Timeouts use `SIGKILL` by default
 * so a child cannot extend the bound by handling `SIGTERM`. A nonzero exit status
 * is returned to the caller, while spawn failures, signals, and timeouts fail
 * immediately with the command description and any captured output.
 */
export function spawnTestProcess(
	command,
	args,
	{
		description = `${command} subprocess`,
		timeout = TEST_SUBPROCESS_TIMEOUT_MS,
		killSignal = "SIGKILL",
		...options
	} = {},
) {
	assert.ok(
		Number.isFinite(timeout) && timeout > 0,
		"test subprocess timeout must be a positive number",
	);
	const result = spawnSync(command, args, { ...options, timeout, killSignal });

	if (result.error?.code === "ETIMEDOUT") {
		assert.fail(
			`${description} timed out after ${timeout}ms${capturedOutput(result)}`,
		);
	}
	assert.equal(
		result.error,
		undefined,
		`${description} failed to spawn: ${result.error?.message}${capturedOutput(result)}`,
	);
	assert.equal(
		result.signal,
		null,
		`${description} terminated by ${result.signal}${capturedOutput(result)}`,
	);
	return result;
}

/**
 * Helpers that replace `process.stdin`, `process.exitCode`, or console methods mutate
 * process-global state. Use them only in tests that run serially within the same test process;
 * their state is restored automatically through `t.mock` or `t.after`.
 */

/**
 * Creates a strict FIFO fetch fake without mutating global state.
 *
 * Queue entries may be native `Response` objects or descriptors containing
 * `{ body?, json?, status?, statusText?, headers?, delayMs? }`. A conditional entry
 * `{ whenBodyIncludes, matched, otherwise }` answers with `matched` when the request body
 * contains the text and with `otherwise` when it does not. Every request is exposed
 * through `calls`; an unexpected request rejects immediately, and unused
 * responses fail the test during teardown.
 */
export function createMockFetch(t, responses = []) {
	const queue = createFetchQueue(responses);

	t.after(() => {
		assert.equal(
			queue.remainingResponses,
			0,
			`${queue.remainingResponses} queued fetch response(s) were not consumed`,
		);
	});

	return { fetch: queue.fetch, calls: queue.calls };
}

/**
 * Creates a temporary Git repository with one committed README. The returned
 * path is removed when the test ends. Pass `origin` and/or `branch` to configure
 * repository context used by CLI tests; the default branch is `main`.
 */
export function createTempGitRepo(t, { origin, branch = "main" } = {}) {
	const path = mkdtempSync(join(tmpdir(), "ado-pr-test-repo-"));
	const hooksPath = join(path, "disabled-hooks");
	mkdirSync(hooksPath);
	t.after(() => rmSync(path, { recursive: true, force: true }));

	// The shared policy strips GIT_CONFIG_PARAMETERS, GIT_CONFIG_KEY_*/VALUE_* entries,
	// repository redirection, template injection, signing, askpass, and credential settings.
	const gitEnv = gitTestEnvironment();

	const git = (...args) => {
		const commandArgs = [
			"-c",
			`core.hooksPath=${hooksPath}`,
			"-c",
			"commit.gpgSign=false",
			...args,
		];
		const result = spawnTestProcess("git", commandArgs, {
			cwd: path,
			env: gitEnv,
			encoding: "utf8",
			description: `git ${args.join(" ")}`,
		});
		assert.equal(
			result.status,
			0,
			`git ${args.join(" ")} failed:\n${result.stderr}`,
		);
		return result.stdout.trim();
	};

	git("init", "--initial-branch", branch);
	git("config", "user.name", "ado-pr tests");
	git("config", "user.email", "ado-pr-tests@example.invalid");
	writeFileSync(join(path, "README.md"), "# Test repository\n");
	git("add", "README.md");
	git("commit", "--no-gpg-sign", "-m", "Initial commit");
	if (origin !== undefined) git("remote", "add", "origin", origin);

	return path;
}

/**
 * Replaces `process.stdin` with a finite readable stream for one serial test.
 * Do not use concurrently with another global-state helper in the same process.
 */
export function mockStdin(t, input) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	assert.ok(
		descriptor?.configurable,
		"process.stdin cannot be safely replaced",
	);

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
		assert.equal(
			typeof console[method],
			"function",
			`console.${method} is not a function`,
		);
		t.mock.method(console, method, (...args) => calls.push({ method, args }));
	}
	return calls;
}

/**
 * Runs `pr.ts` in an isolated subprocess using Node's TypeScript stripping and
 * the fetch preload fixture. `responses` uses the same descriptor shape as
 * `createMockFetch` (native `Response` objects are intentionally unsupported across
 * the process boundary). Only V8 coverage and cross-platform path/temp/locale/system variables
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
export function startPr(
	t,
	args = [],
	{
		cwd = projectRoot,
		responses = [],
		env = {},
		fakePat = "test-only-fake-pat",
		timeout = 5_000,
	} = {},
) {
	assert.ok(Array.isArray(args), "startPr args must be an array");
	validateFetchResponses(responses);
	assert.ok(
		responses.every((response) => !(response instanceof Response)),
		"startPr responses must be serializable descriptors, not Response objects",
	);
	assert.ok(
		Number.isFinite(timeout) && timeout > 0,
		"startPr timeout must be positive",
	);

	const tempPath = mkdtempSync(join(tmpdir(), "ado-pr-test-async-run-"));
	const callsPath = join(tempPath, "fetch-calls.json");
	const environmentPath = join(tempPath, "environment.json");
	writeFileSync(callsPath, "[]\n");
	writeFileSync(environmentPath, "{}\n");

	const childEnv = { ...inheritedTestEnvironment(), ...env };
	childEnv.AZURE_DEVOPS_PAT = fakePat;
	childEnv[FETCH_RESPONSES_ENV] = JSON.stringify(responses);
	childEnv[FETCH_CALLS_FILE_ENV] = callsPath;
	childEnv[ENV_PROBE_NAMES_ENV] = "[]";
	childEnv[ENV_PROBE_FILE_ENV] = environmentPath;

	const child = spawn(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			"--experimental-strip-types",
			"--import",
			fetchPreloadPath,
			prPath,
			...args,
		],
		{ cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let stdout = "";
	let stderr = "";
	let closed = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	let timeoutHandle;
	let timedOut = false;
	const completion = new Promise((resolve, reject) => {
		let spawnError;
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (status, signal) => {
			closed = true;
			clearTimeout(timeoutHandle);
			if (spawnError !== undefined) {
				reject(spawnError);
				return;
			}
			if (timedOut) {
				reject(
					new Error(
						`pr.ts async subprocess timed out after ${timeout}ms` +
							`${stdout ? `\nstdout:\n${stdout}` : ""}` +
							`${stderr ? `\nstderr:\n${stderr}` : ""}`,
					),
				);
				return;
			}
			resolve({
				status,
				signal,
				stdout,
				stderr,
				calls: JSON.parse(readFileSync(callsPath, "utf8")),
			});
		});
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
	});

	void completion.catch(() => undefined);

	const waitUntil = async (predicate, description) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			let value;
			try {
				value = predicate();
			} catch {
				// The preload rewrites files synchronously; retry a transient partial read.
			}
			if (value) return value;
			if (closed)
				throw new Error(`pr.ts exited before ${description}:\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for ${description}`);
	};

	t.after(async () => {
		if (!closed) child.kill("SIGKILL");
		await completion.catch(() => undefined);
		rmSync(tempPath, { recursive: true, force: true });
	});

	return {
		child,
		completion,
		waitForCalls(count) {
			return waitUntil(() => {
				const calls = JSON.parse(readFileSync(callsPath, "utf8"));
				return calls.length >= count ? calls : undefined;
			}, `${count} fetch call(s)`);
		},
		waitForStderr(pattern) {
			return waitUntil(
				() => pattern.test(stderr),
				`stderr matching ${pattern}`,
			);
		},
	};
}

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
		timeout = TEST_SUBPROCESS_TIMEOUT_MS,
	} = {},
) {
	assert.ok(Array.isArray(args), "runPr args must be an array");
	validateFetchResponses(responses);
	assert.ok(
		responses.every((response) => !(response instanceof Response)),
		"runPr responses must be serializable descriptors, not Response objects",
	);
	assert.ok(
		Number.isFinite(timeout) && timeout > 0,
		"runPr timeout must be a positive number",
	);
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

	const result = spawnTestProcess(
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
			description: "pr.ts",
		},
	);
	return {
		...result,
		calls: JSON.parse(readFileSync(callsPath, "utf8")),
		environment: JSON.parse(readFileSync(environmentPath, "utf8")),
	};
}
