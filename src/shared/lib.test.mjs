import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	getCurrentBranch,
	getRepoContext,
	parseAzureDevOpsRemote,
	runCommand,
} from "./lib.ts";
import {
	createTempGitRepo,
	gitTestEnvironment,
	isolateGitEnvironment,
	spawnTestProcess,
} from "../../tests/test-helpers.mjs";

const supportedRemotes = [
	{
		name: "dev.azure.com HTTPS",
		remote: "https://dev.azure.com/acme/Project/_git/widgets",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "dev.azure.com HTTPS with a credential prefix",
		remote: "https://acme@dev.azure.com/acme/Project/_git/widgets",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "Azure Repos SSH",
		remote: "git@ssh.dev.azure.com:v3/acme/Project/widgets",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "legacy visualstudio.com HTTPS",
		remote: "https://acme.visualstudio.com/Project/_git/widgets",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "legacy visualstudio.com HTTPS with DefaultCollection",
		remote:
			"https://acme.visualstudio.com/DefaultCollection/Project/_git/widgets",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "HTTPS with a .git suffix",
		remote: "https://dev.azure.com/acme/Project/_git/widgets.git",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "HTTPS with a trailing slash",
		remote: "https://dev.azure.com/acme/Project/_git/widgets/",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "legacy HTTPS with a .git suffix and trailing slash",
		remote: "https://acme.visualstudio.com/Project/_git/widgets.git/",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "SSH with a .git suffix",
		remote: "git@ssh.dev.azure.com:v3/acme/Project/widgets.git",
		expected: {
			organization: "acme",
			project: "Project",
			repository: "widgets",
		},
	},
	{
		name: "percent-encoded path components",
		remote:
			"https://dev.azure.com/acme%20org/Project%2FSpace/_git/widgets%20%2B%20tools",
		expected: {
			organization: "acme org",
			project: "Project/Space",
			repository: "widgets + tools",
		},
	},
];

for (const { name, remote, expected } of supportedRemotes) {
	test(`parseAzureDevOpsRemote parses ${name}`, () => {
		assert.deepEqual(parseAzureDevOpsRemote(remote), expected);
	});
}

const unsupportedRemotes = [
	"https://github.com/acme/widgets.git",
	"git@github.com:acme/widgets.git",
	"https://example.invalid/acme/Project/_git/widgets",
	"ssh://git@ssh.dev.azure.com/v3/acme/Project/widgets",
	"",
];

for (const remote of unsupportedRemotes) {
	test(`parseAzureDevOpsRemote rejects unsupported remote ${JSON.stringify(remote)}`, () => {
		assert.throws(() => parseAzureDevOpsRemote(remote), {
			message:
				`Could not parse an Azure DevOps organization/project/repository from remote URL: ` +
				`"${remote}"`,
		});
	});
}

async function withWorkingDirectory(path, callback) {
	const previousCwd = process.cwd();
	process.chdir(path);
	try {
		return await callback();
	} finally {
		process.chdir(previousCwd);
	}
}

function git(cwd, ...args) {
	const commandArgs = [
		"-c",
		`core.hooksPath=${join(cwd, "disabled-hooks")}`,
		...args,
	];
	const result = spawnTestProcess("git", commandArgs, {
		cwd,
		env: gitTestEnvironment(),
		encoding: "utf8",
		description: `git ${args.join(" ")} in ${cwd}`,
	});
	assert.equal(
		result.status,
		0,
		`git ${args.join(" ")} failed:\n${result.stderr}`,
	);
	return result.stdout.trim();
}

function setGitEnvironment(values) {
	const previousValues = new Map(
		Object.keys(values).map((name) => [name, process.env[name]]),
	);
	for (const [name, value] of Object.entries(values)) process.env[name] = value;

	return () => {
		for (const [name, value] of previousValues) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

describe("Git repository integration", { concurrency: false }, () => {
	test("getRepoContext reads origin and getCurrentBranch reads the checked-out branch", async (t) => {
		isolateGitEnvironment(t);
		const repo = createTempGitRepo(t, {
			origin: "https://dev.azure.com/acme/Test%20Project/_git/widgets.git",
			branch: "feature/lib-tests",
		});

		await withWorkingDirectory(repo, async () => {
			assert.deepEqual(await getRepoContext(), {
				organization: "acme",
				project: "Test Project",
				repository: "widgets",
			});
			assert.equal(await getCurrentBranch(), "feature/lib-tests");
		});
	});

	test("getRepoContext reports the current parser error when origin is missing", async (t) => {
		isolateGitEnvironment(t);
		const repo = createTempGitRepo(t);

		await withWorkingDirectory(repo, async () => {
			await assert.rejects(getRepoContext(), {
				message:
					'Could not parse an Azure DevOps organization/project/repository from remote URL: ""',
			});
		});
	});

	test('getCurrentBranch reports "HEAD" for a detached checkout', async (t) => {
		isolateGitEnvironment(t);
		const repo = createTempGitRepo(t, { branch: "main" });
		git(repo, "checkout", "--detach");

		await withWorkingDirectory(repo, async () => {
			assert.equal(await getCurrentBranch(), "HEAD");
		});
	});

	test("runCommand resolves the current non-zero Git result instead of rejecting", async (t) => {
		isolateGitEnvironment(t);
		const repo = createTempGitRepo(t);

		await withWorkingDirectory(repo, async () => {
			assert.deepEqual(
				await runCommand("git", ["rev-parse", "--verify", "missing-ref"]),
				{
					code: 128,
					stdout: "",
				},
			);
		});
	});

	test("runCommand aborts its child when the caller signal is canceled", async () => {
		const controller = new AbortController();
		const pending = runCommand(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ signal: controller.signal },
		);
		controller.abort();
		await assert.rejects(pending, (error) => error?.code === "ABORT_ERR");
	});

	test("getRepoContext ignores a hostile ambient insteadOf URL rewrite", async (t) => {
		const origin = "https://dev.azure.com/acme/Project/_git/widgets";
		const repo = createTempGitRepo(t, { origin });
		const restoreEnvironment = setGitEnvironment({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://dev.azure.com/",
		});

		try {
			await t.test(
				"with isolated production Git environment",
				{ concurrency: false },
				async (t) => {
					isolateGitEnvironment(t);
					await withWorkingDirectory(repo, async () => {
						assert.deepEqual(await getRepoContext(), {
							organization: "acme",
							project: "Project",
							repository: "widgets",
						});
					});
				},
			);
		} finally {
			restoreEnvironment();
		}
	});

	test("detached checkout does not execute a hostile post-checkout hook", async (t) => {
		isolateGitEnvironment(t);
		const repo = createTempGitRepo(t, { branch: "main" });
		const markerPath = join(repo, "post-checkout-hook-ran");
		const hookPath = join(repo, ".git", "hooks", "post-checkout");
		writeFileSync(
			hookPath,
			`#!/bin/sh\nprintf hook-ran > ${JSON.stringify(markerPath)}\n`,
		);
		chmodSync(hookPath, 0o755);

		git(repo, "checkout", "--detach");

		await withWorkingDirectory(repo, async () => {
			assert.equal(await getCurrentBranch(), "HEAD");
		});
		assert.equal(
			existsSync(markerPath),
			false,
			"hostile post-checkout hook created its marker",
		);
	});
});

test("runCommand captures stdout from fast concurrent commands", async () => {
	for (let batch = 0; batch < 4; batch += 1) {
		const results = await Promise.all(
			Array.from({ length: 16 }, () => runCommand("git", ["--version"])),
		);
		for (const result of results) {
			assert.equal(result.code, 0);
			assert.match(result.stdout, /^git version /);
		}
	}
});
