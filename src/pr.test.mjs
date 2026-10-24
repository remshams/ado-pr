import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTempGitRepo, runPr, startPr } from "../tests/test-helpers.mjs";

const origin = "https://dev.azure.com/acme/Test%20Project/_git/widgets";
const apiBase =
	"https://dev.azure.com/acme/Test%20Project/_apis/git/repositories/widgets";
const webBase =
	"https://dev.azure.com/acme/Test%20Project/_git/widgets/pullrequest";
const buildApiBase =
	"https://dev.azure.com/acme/Test%20Project/_apis/build/builds";

test("pr attach uploads a file and prints its URL and Markdown link", (t) => {
	const cwd = createRepo(t);
	const path = join(cwd, "change.patch");
	writeFileSync(path, "patch bytes");
	const result = runPr(
		t,
		["pr", "attach", path, "--pr", "42", "--name", "change.txt"],
		{
			cwd,
			responses: [
				{
					json: {
						displayName: "change.txt",
						url: "https://files.test/change.txt",
					},
				},
			],
		},
	);
	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"Attachment URL: https://files.test/change.txt\nMarkdown: [change.txt](<https://files.test/change.txt>)\n",
	);
	assert.equal(result.calls[0].method, "POST");
});

test("pr attach reports Azure's rejection body and suggests --name", (t) => {
	const cwd = createRepo(t);
	const path = join(cwd, "change.patch");
	writeFileSync(path, "patch bytes");
	const result = runPr(t, ["pr", "attach", path, "--pr", "42"], {
		cwd,
		responses: [
			{
				status: 400,
				statusText: "Bad Request",
				body: '{"message":"Unsupported file type"}',
			},
		],
	});
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/400 Bad Request[\s\S]*Unsupported file type[\s\S]*--name "attachment.txt"/,
	);
});

function createRepo(t, branch = "feature/dispatch") {
	return createTempGitRepo(t, { origin, branch });
}

function request(call) {
	return { url: call.url, method: call.method, body: call.body };
}

function semanticRequest(call) {
	return {
		url: call.url,
		method: call.method,
		body: typeof call.body === "string" ? JSON.parse(call.body) : call.body,
	};
}

function assertSucceeded(result) {
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
}

function validationPr(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Build validation",
		status: "active",
		isDraft: true,
		sourceRefName: "refs/heads/feature/dispatch",
		repository: { id: "repo-id", name: "widgets" },
		lastMergeCommit: { commitId: "merge-1" },
		...overrides,
	};
}

function validationBuild(overrides = {}) {
	return {
		id: 700,
		buildNumber: "20260818.1",
		status: "completed",
		result: "failed",
		reason: "pullRequest",
		sourceBranch: "refs/pull/42/merge",
		sourceVersion: "merge-1",
		queueTime: "2026-08-18T10:00:00Z",
		startTime: "2026-08-18T10:01:00Z",
		finishTime: "2026-08-18T10:03:00Z",
		repository: { id: "repo-id", name: "widgets", type: "TfsGit" },
		definition: { id: 9, name: "Widget CI" },
		_links: { web: { href: "https://dev.azure.com/acme/build/700" } },
		...overrides,
	};
}

test("build list dispatches through BuildService and prints a normalized JSON envelope", (t) => {
	const cwd = createRepo(t);
	const pr = validationPr();
	const result = runPr(t, ["build", "list", "--pr", "42", "--json"], {
		cwd,
		responses: [{ json: pr }, { json: { count: 0, value: [] } }, { json: pr }],
	});

	assertSucceeded(result);
	assert.deepEqual(JSON.parse(result.stdout), {
		pullRequest: {
			id: 42,
			title: "Build validation",
			status: "active",
			draft: true,
			currentMergeCommit: "merge-1",
		},
		history: false,
		builds: [],
	});
	assert.equal(
		result.calls[1].url,
		`${buildApiBase}?reasonFilter=pullRequest&branchName=refs%2Fpull%2F42%2Fmerge&repositoryId=repo-id&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&api-version=7.1`,
	);
});

test("build list prints a successful explicit message for an empty current collection", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["build", "list", "--pr", "42"], {
		cwd,
		responses: [
			{ json: validationPr() },
			{ json: { value: [] } },
			{ json: validationPr() },
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"No associated current merge version builds found for PR #42.\n",
	);
});

test("build show --full-logs prints its normalized diagnostic envelope", (t) => {
	const cwd = createRepo(t);
	const build = validationBuild();
	const timeline = {
		id: "timeline-700",
		records: [
			{
				id: "task-lint",
				type: "Task",
				name: "Lint",
				state: "completed",
				result: "failed",
				issues: [
					{ type: "error", category: "lint", message: "Formatting differs" },
				],
				log: { id: 17 },
			},
		],
	};
	const result = runPr(
		t,
		["build", "show", "--build", "700", "--pr", "42", "--full-logs", "--json"],
		{
			cwd,
			responses: [
				{ json: validationPr() },
				{ json: build },
				{ json: timeline },
				{ json: { value: [{ id: 17, type: "Container" }] } },
				{ body: "src/app.ts needs formatting\n" },
			],
		},
	);

	assertSucceeded(result);
	const output = JSON.parse(result.stdout);
	assert.equal(output.current, true);
	assert.deepEqual(output.build, build);
	assert.deepEqual(output.timeline, timeline);
	assert.equal(output.problemRecords[0].logMode, "full");
	assert.equal(output.problemRecords[0].logRange, null);
	assert.equal(
		output.problemRecords[0].logText,
		"src/app.ts needs formatting\n",
	);
	assert.deepEqual(
		result.calls.map(({ url, method }) => ({ url, method })),
		[
			{ url: `${apiBase}/pullRequests/42?api-version=7.1`, method: "GET" },
			{ url: `${buildApiBase}/700?api-version=7.1`, method: "GET" },
			{ url: `${buildApiBase}/700/timeline?api-version=7.1`, method: "GET" },
			{ url: `${buildApiBase}/700/logs?api-version=7.1`, method: "GET" },
			{ url: `${buildApiBase}/700/logs/17?api-version=7.1`, method: "GET" },
		],
	);
	assert.equal(result.calls[4].headers.accept, "text/plain");
});

test("build show prints partial JSON and exits nonzero when one problem log fails", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "show", "--build", "700", "--pr", "42", "--json"],
		{
			cwd,
			responses: [
				{ json: validationPr() },
				{ json: validationBuild() },
				{
					json: {
						records: [
							{
								id: "task-test",
								type: "Task",
								name: "Test",
								result: "failed",
								log: { id: 18 },
							},
						],
					},
				},
				{ json: { value: [{ id: 18, lineCount: 12 }] } },
				{
					status: 503,
					statusText: "Unavailable",
					body: "temporary log failure",
				},
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	const output = JSON.parse(result.stdout);
	assert.match(output.problemRecords[0].logError, /503 Unavailable/);
	assert.deepEqual(output.problemRecords[0].logRange, {
		startLine: 0,
		endLine: 12,
	});
});

test("build retry double-checks its target and prints Azure's returned build", (t) => {
	const cwd = createRepo(t);
	const returned = validationBuild({
		id: 701,
		buildNumber: "20260818.2",
		status: "inProgress",
		result: undefined,
		_links: { web: { href: "https://dev.azure.com/acme/build/701" } },
	});
	const result = runPr(t, ["build", "retry", "--build", "700", "--pr", "42"], {
		cwd,
		responses: [
			{ json: validationPr() },
			{ json: validationBuild() },
			{ json: validationPr({ isDraft: false }) },
			{ json: validationBuild() },
			{ json: returned },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(
		result.calls.map(({ url, method, body }) => ({ url, method, body })),
		[
			{
				url: `${apiBase}/pullRequests/42?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{ url: `${buildApiBase}/700?api-version=7.1`, method: "GET", body: null },
			{
				url: `${apiBase}/pullRequests/42?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{ url: `${buildApiBase}/700?api-version=7.1`, method: "GET", body: null },
			{
				url: `${buildApiBase}/700?retry=true&api-version=7.1`,
				method: "PATCH",
				body: JSON.stringify({ id: 700 }),
			},
		],
	);
	assert.equal(
		result.stdout,
		"Azure DevOps accepted the retry request for build 701/20260818.2.\n" +
			"Association: pr-merge\nReturned status/result: inProgress/unknown\n" +
			"URL: https://dev.azure.com/acme/build/701\n",
	);
});

test("build wait polls exactly PR and build metadata for every terminal outcome", (t) => {
	for (const [resultName, expectedStatus] of [
		["succeeded", 0],
		["failed", 1],
		["partiallySucceeded", 1],
		["canceled", 1],
		["mystery", 1],
	]) {
		const result = runPr(
			t,
			[
				"build",
				"wait",
				"--pr",
				"42",
				"--build",
				"700",
				...(resultName === "succeeded" ? ["--json"] : []),
			],
			{
				cwd: createRepo(t),
				responses: [
					{ json: validationPr() },
					{
						json: validationBuild({
							result: resultName,
							unsafeMetadata: "C1\u009b bidi\u202e line\u2028separator",
						}),
					},
				],
			},
		);

		assert.equal(result.status, expectedStatus, result.stderr);
		assert.deepEqual(result.calls.map(request), [
			{
				url: `${apiBase}/pullRequests/42?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{ url: `${buildApiBase}/700?api-version=7.1`, method: "GET", body: null },
		]);
		assert.match(result.stderr, /PR #42, build 700: initial state completed\//);
		assert.doesNotMatch(
			result.stdout,
			/initial state|still waiting|transient warning/,
		);
		assert.equal(result.stdout.includes("timeline"), false);
		assert.equal(result.stdout.includes("log"), false);
		if (resultName === "succeeded") {
			const parsed = JSON.parse(result.stdout);
			assert.equal(parsed.outcome, resultName);
			assert.equal(parsed.buildId, 700);
			assert.equal(
				parsed.build.unsafeMetadata,
				"C1\u009b bidi\u202e line\u2028separator",
			);
			assert.doesNotMatch(result.stdout, /[\u009b\u202e\u2028]/);
			assert.match(result.stdout, /C1\\u009b bidi\\u202e line\\u2028separator/);
		} else {
			const expectedOutcome = resultName === "mystery" ? "unknown" : resultName;
			assert.match(
				result.stdout,
				new RegExp(
					`^build 700 for PR #42 finished with outcome ${expectedOutcome}\\.`,
				),
			);
			assert.equal(result.stdout.split("\n").length, 5);
		}
	}
});

test("build wait reports operational HTTP errors without a result document", (t) => {
	const result = runPr(t, ["build", "wait", "--pr", "42", "--build", "700"], {
		cwd: createRepo(t),
		responses: [
			{ json: validationPr() },
			{ status: 400, statusText: "Bad Request", body: "build unavailable" },
		],
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		`Azure DevOps API request (GET ${buildApiBase}/700?api-version=7.1) failed: 400 Bad Request\nbuild unavailable\n`,
	);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{ url: `${buildApiBase}/700?api-version=7.1`, method: "GET", body: null },
	]);
});

test("build wait exits 130 on SIGINT during PR resolution without final output", async (t) => {
	const running = startPr(
		t,
		["build", "wait", "--pr", "42", "--build", "700"],
		{
			cwd: createRepo(t),
			responses: [{ delayMs: 10_000, json: validationPr() }],
		},
	);
	await running.waitForCalls(1);
	running.child.kill("SIGINT");
	const result = await running.completion;

	assert.equal(result.status, 130);
	assert.equal(result.signal, null);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	assert.equal(result.calls.length, 1);
});

test("build wait exits 143 on SIGTERM during polling sleep without final output", async (t) => {
	const running = startPr(
		t,
		["build", "wait", "--pr", "42", "--build", "700", "--interval", "10"],
		{
			cwd: createRepo(t),
			responses: [
				{ json: validationPr() },
				{ json: validationBuild({ status: "inProgress", result: undefined }) },
			],
		},
	);
	await running.waitForCalls(2);
	await running.waitForStderr(/initial state inProgress\/unknown/);
	running.child.kill("SIGTERM");
	const result = await running.completion;

	assert.equal(result.status, 143);
	assert.equal(result.signal, null);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /initial state inProgress\/unknown/);
	assert.doesNotMatch(result.stderr, /finished with outcome|timed out/);
	assert.equal(result.calls.length, 2);
});

test("pr list requests the current identity then prints active pull requests in response order", (t) => {
	const cwd = createRepo(t);
	const pullRequests = [
		{
			pullRequestId: 91,
			title: "Draft API cleanup",
			status: "active",
			isDraft: true,
			sourceRefName: "refs/heads/feature/api-cleanup",
			targetRefName: "refs/heads/main",
			reviewers: [
				{ id: "reviewer-1", displayName: "Ada Reviewer", vote: 10 },
				{ id: "reviewer-2", displayName: "Lin Reviewer", vote: -5 },
			],
		},
		{
			pullRequestId: 12,
			title: "Release fix",
			status: "active",
			isDraft: false,
			sourceRefName: "refs/heads/fix/release",
			targetRefName: "refs/heads/release/2026",
		},
	];
	const result = runPr(t, ["pr", "list"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "creator/id +?#" } } },
			{ json: { count: pullRequests.length, value: pullRequests } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.creatorId=creator%2Fid%20%2B%3F%23&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"Active pull requests created by you:\n\n" +
			"- PR #91: Draft API cleanup [draft]\n" +
			"  feature/api-cleanup -> main\n" +
			"  Reviewers: Ada Reviewer: approved, Lin Reviewer: waiting for author\n" +
			`  ${webBase}/91\n\n` +
			"- PR #12: Release fix\n" +
			"  fix/release -> release/2026\n" +
			`  ${webBase}/12\n`,
	);
});

test("pr list sends reviewer, all, and target search criteria", (t) => {
	const cases = [
		{
			args: ["--reviewing"],
			identity: true,
			criteria:
				"searchCriteria.reviewerId=me&searchCriteria.status=active&api-version=7.1",
		},
		{
			args: ["--reviewing", "--target", "release/2026"],
			identity: true,
			criteria:
				"searchCriteria.reviewerId=me&searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Frelease%2F2026&api-version=7.1",
		},
		{
			args: ["--all"],
			identity: false,
			criteria: "searchCriteria.status=active&api-version=7.1",
		},
		{
			args: ["--all", "--target", "main"],
			identity: false,
			criteria:
				"searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Fmain&api-version=7.1",
		},
		{
			args: ["--target", "main"],
			identity: true,
			criteria:
				"searchCriteria.creatorId=me&searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Fmain&api-version=7.1",
		},
	];
	for (const { args, identity, criteria } of cases) {
		const cwd = createRepo(t);
		const result = runPr(t, ["pr", "list", ...args, "--json"], {
			cwd,
			responses: [
				...(identity ? [{ json: { authenticatedUser: { id: "me" } } }] : []),
				{ json: { value: [] } },
			],
		});
		assertSucceeded(result);
		assert.equal(
			result.calls.at(-1).url,
			`${apiBase}/pullrequests?${criteria}`,
		);
	}
});

test("pr list rejects --reviewing with --all", (t) => {
	const result = runPr(t, ["pr", "list", "--reviewing", "--all"], {
		cwd: createRepo(t),
		responses: [],
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--reviewing and --all are mutually exclusive/);
	assert.equal(result.calls.length, 0);
});

test("pr list --json prints the collection value as a pretty JSON array", (t) => {
	const cwd = createRepo(t);
	const pullRequests = [
		{
			pullRequestId: 44,
			title: "Raw collection entry",
			sourceRefName: "refs/heads/feature/raw",
			targetRefName: "refs/heads/main",
			repository: { id: "repository-metadata-is-preserved" },
		},
	];
	const result = runPr(t, ["pr", "list", "--json"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { value: pullRequests } },
		],
	});

	assertSucceeded(result);
	assert.equal(result.stdout, `${JSON.stringify(pullRequests, null, 2)}\n`);
	assert.equal(result.calls.length, 2);
	assert.match(result.calls[1].url, /searchCriteria\.creatorId=me/);
});

test("pr list reports an empty active collection as a successful result", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "list"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { count: 0, value: [] } },
		],
	});

	assertSucceeded(result);
	assert.equal(result.calls.length, 2);
	assert.equal(
		result.stdout,
		"No active pull requests created by you in this repository.\n",
	);
});

test("create dispatches directly without resolving an existing pull request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Dispatch coverage",
			"--description",
			"Regression test",
			"--source",
			"feature/source",
			"--target",
			"main",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 101,
						title: "Dispatch coverage",
						sourceRefName: "refs/heads/feature/source",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullrequests?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				sourceRefName: "refs/heads/feature/source",
				targetRefName: "refs/heads/main",
				title: "Dispatch coverage",
				description: "Regression test",
				isDraft: true,
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Created PR #101: Dispatch coverage\n${webBase}/101\n`,
	);
});

test("create resolves reviewers, uploads binary images, and patches every matching placeholder", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "flow[1].png"), Buffer.from([0, 255, 16, 32]));
	const placeholderDescription =
		"Flow {{image:flow[1].png}} and repeated {{image:flow[1].png}}";
	const attachmentUrl = "https://attachments.test/flow(1).png?token=x";
	const finalDescription =
		`Flow ![flow\\[1\\].png](<${attachmentUrl}>)<!-- ado-pr-image:flow%5B1%5D.png --> and repeated ` +
		`![flow\\[1\\].png](<${attachmentUrl}>)<!-- ado-pr-image:flow%5B1%5D.png -->`;
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Illustrated flow",
			"--description",
			placeholderDescription,
			"--source",
			"feature/dispatch",
			"--target",
			"main",
			"--image",
			"flow[1].png",
			"--reviewer",
			"Ada Lovelace",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: "reviewer/id",
								providerDisplayName: "ADA LOVELACE",
								isActive: true,
							},
						],
					},
				},
				{
					json: {
						pullRequestId: 102,
						title: "Illustrated flow",
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
				{ json: { value: [] } },
				{ json: { displayName: "flow[1].png", url: attachmentUrl } },
				{
					json: {
						pullRequestId: 102,
						title: "Illustrated flow",
						description: finalDescription,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				"https://vssps.dev.azure.com/acme/_apis/identities?" +
				"searchFilter=General&filterValue=Ada%20Lovelace&queryMembership=None&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullrequests?api-version=7.1`,
			method: "POST",
			body: {
				sourceRefName: "refs/heads/feature/dispatch",
				targetRefName: "refs/heads/main",
				title: "Illustrated flow",
				description: placeholderDescription,
				isDraft: false,
				reviewers: [{ id: "reviewer/id" }],
			},
		},
		{
			url: `${apiBase}/pullRequests/102/attachments?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/102/attachments/flow%5B1%5D.png?api-version=7.1`,
			method: "POST",
			body: { encoding: "base64", data: "AP8QIA==" },
		},
		{
			url: `${apiBase}/pullRequests/102?api-version=7.1`,
			method: "PATCH",
			body: { description: finalDescription },
		},
	]);
	assert.equal(
		result.stdout,
		`Created PR #102: Illustrated flow\n${webBase}/102\n`,
	);
});

test("create rejects an image placeholder mismatch before creating a pull request", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "flow.png"), Buffer.from([1, 2, 3]));
	const result = runPr(
		t,
		[
			"pr",
			"create",
			"--title",
			"Mismatch",
			"--description",
			"{{image:other.png}}",
			"--source",
			"feature/dispatch",
			"--target",
			"main",
			"--image",
			"flow.png",
		],
		{ cwd },
	);

	assert.equal(result.status, 1);
	assert.deepEqual(result.calls, []);
	assert.equal(
		result.stderr,
		"Image placeholder mismatch: missing {{image:flow.png}} for --image flow.png; " +
			"no --image was supplied for {{image:other.png}}.\n",
	);
});

test("show fetches an explicit PR and prints human-readable details", (t) => {
	const cwd = createRepo(t);
	const pr = {
		pullRequestId: 42,
		title: "Account validation",
		description: "Validate accounts before saving.",
		status: "active",
		isDraft: true,
		sourceRefName: "refs/heads/feature/account-validation",
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--pr", "42"], {
		cwd,
		responses: [{ json: pr }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"PR #42: Account validation\n" +
			"Status: active\n" +
			"Draft: yes\n" +
			"Source: feature/account-validation\n" +
			"Target: main\n" +
			`URL: ${webBase}/42\n` +
			"Description:\n" +
			"Validate accounts before saving.\n",
	);
});

test("show prints an explicit PR as JSON", (t) => {
	const cwd = createRepo(t);
	const pr = {
		pullRequestId: 42,
		title: "JSON details",
		description: "Machine readable",
		status: "active",
		isDraft: false,
		sourceRefName: "refs/heads/feature/json",
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--pr", "42", "--json"], {
		cwd,
		responses: [{ json: pr }],
	});

	assertSucceeded(result);
	assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("show hydrates the active PR found for the current branch", (t) => {
	const cwd = createRepo(t, "feature/branch-details");
	const candidate = {
		pullRequestId: 73,
		title: "Branch details",
		description: "Truncated collection description",
		sourceRefName: "refs/heads/feature/branch-details",
	};
	const pr = {
		...candidate,
		description: "Found from the current branch with the full description.",
		status: "active",
		isDraft: false,
		targetRefName: "refs/heads/main",
	};
	const result = runPr(t, ["pr", "show", "--json"], {
		cwd,
		responses: [{ json: { value: [candidate] } }, { json: pr }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fbranch-details&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("pr edit replaces the description for an explicit PR without fetching it first", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			"Updated from the command line",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 42,
						title: "Updated PR",
						description: "Updated from the command line",
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: "Updated from the command line" },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit marks an explicit PR as draft without fetching it first", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "edit", "--pr", "42", "--draft"], {
		cwd,
		responses: [
			{
				json: {
					pullRequestId: 42,
					title: "Draft PR",
					isDraft: true,
					sourceRefName: "refs/heads/feature/dispatch",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { isDraft: true },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit clears draft state with --no-draft", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "edit", "--pr", "42", "--no-draft"], {
		cwd,
		responses: [
			{
				json: {
					pullRequestId: 42,
					title: "Ready PR",
					isDraft: false,
					sourceRefName: "refs/heads/feature/dispatch",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { isDraft: false },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit combines description and draft changes in one request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			"Work in progress",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						pullRequestId: 42,
						title: "Combined update",
						description: "Work in progress",
						isDraft: true,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: "Work in progress", isDraft: true },
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit preflights and applies image and reviewer additions and removals in safe order", (t) => {
	const cwd = createRepo(t);
	writeFileSync(join(cwd, "new.png"), Buffer.from("new-image-bytes"));
	const oldUrl = "https://attachments.test/old.png?token=exact";
	const newUrl = "https://attachments.test/new.png?token=new";
	const replacement =
		`New {{image:new.png}}\nOld ![old.png](<${oldUrl}>)` +
		"<!-- ado-pr-image:old.png -->";
	const finalDescription = `New ![new.png](<${newUrl}>)<!-- ado-pr-image:new.png -->\nOld `;
	const result = runPr(
		t,
		[
			"pr",
			"edit",
			"--pr",
			"42",
			"--description",
			replacement,
			"--image",
			"new.png",
			"--remove-image",
			"old.png",
			"--reviewer",
			"New Reviewer",
			"--remove-reviewer",
			"old@example.test",
			"--draft",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: "new/id",
								providerDisplayName: "New Reviewer",
								isActive: true,
							},
						],
					},
				},
				{
					json: {
						value: [
							{
								id: "old/id",
								displayName: "Old Reviewer",
								uniqueName: "OLD@EXAMPLE.TEST",
								inactive: true,
								vote: 10,
							},
						],
					},
				},
				{ json: { value: [{ displayName: "old.png", url: oldUrl }] } },
				{ json: { displayName: "new.png", url: newUrl } },
				{
					json: {
						pullRequestId: 42,
						title: "Updated assets",
						description: finalDescription,
						sourceRefName: "refs/heads/feature/dispatch",
					},
				},
				{ status: 204 },
				{ body: "" },
				{ status: 204 },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				"https://vssps.dev.azure.com/acme/_apis/identities?" +
				"searchFilter=General&filterValue=New%20Reviewer&queryMembership=None&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/attachments?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/attachments/new.png?api-version=7.1`,
			method: "POST",
			body: {
				encoding: "base64",
				data: Buffer.from("new-image-bytes").toString("base64"),
			},
		},
		{
			url: `${apiBase}/pullRequests/42?api-version=7.1`,
			method: "PATCH",
			body: { description: finalDescription, isDraft: true },
		},
		{
			url: `${apiBase}/pullRequests/42/attachments/old.png?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers/new%2Fid?api-version=7.1`,
			method: "PUT",
			body: { id: "new/id", vote: 0 },
		},
		{
			url: `${apiBase}/pullRequests/42/reviewers/old%2Fid?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
	]);
	assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit resolves the branch PR and can clear its description", (t) => {
	const cwd = createRepo(t, "feature/clear-description");
	const result = runPr(t, ["pr", "edit", "--description", ""], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							pullRequestId: 73,
							title: "Clear description",
							sourceRefName: "refs/heads/feature/clear-description",
						},
					],
				},
			},
			{
				json: {
					pullRequestId: 73,
					title: "Clear description",
					description: "",
					sourceRefName: "refs/heads/feature/clear-description",
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fclear-description&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73?api-version=7.1`,
			method: "PATCH",
			body: { description: "" },
		},
	]);
	assert.equal(result.stdout, `Updated PR #73.\n${webBase}/73\n`);
});

test("list uses an explicit PR and prints the filtered response as JSON", (t) => {
	const cwd = createRepo(t);
	const threads = [
		{
			id: 12,
			status: "active",
			comments: [
				{ id: 1, content: "Review this", author: { displayName: "Ada" } },
			],
		},
	];
	const result = runPr(t, ["comment", "list", "--pr", "42", "--json"], {
		cwd,
		responses: [{ json: { value: threads } }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify(threads, null, 2)}\n`);
});

test("list forwards exclude flags, fetches connection data after threads, and prints only threads surviving both filters", (t) => {
	const cwd = createRepo(t);
	const currentUser = { id: "me", displayName: "Current User" };
	const reviewer = { id: "reviewer", displayName: "Reviewer" };
	const survivor = {
		id: 13,
		status: "active",
		comments: [{ id: 3, content: "Keep this", author: reviewer }],
	};
	const result = runPr(
		t,
		[
			"comment",
			"list",
			"--pr",
			"42",
			"--json",
			"--exclude-own",
			"--exclude-resolved",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: 11,
								status: "active",
								comments: [{ id: 1, content: "My note", author: currentUser }],
							},
							{
								id: 12,
								status: "fixed",
								comments: [
									{ id: 2, content: "Already resolved", author: reviewer },
								],
							},
							survivor,
						],
					},
				},
				{ json: { authenticatedUser: { id: currentUser.id } } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify([survivor], null, 2)}\n`);
});

test("list auto-resolves the branch PR before fetching threads and handles an empty text result", (t) => {
	const cwd = createRepo(t, "feature/dispatch-order");
	const result = runPr(t, ["comment", "list"], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							pullRequestId: 73,
							title: "Resolved from branch",
							sourceRefName: "refs/heads/feature/dispatch-order",
						},
					],
				},
			},
			{ json: { value: [] } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fdispatch-order&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, "No matching comment threads on PR #73.\n");
});

test("list prints representative nonempty text output", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["comment", "list", "--pr", "42"], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							id: 9,
							status: "active",
							comments: [
								{
									id: 1,
									content: " Looks good ",
									author: { displayName: "Ada" },
								},
							],
						},
					],
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		`Comment threads on PR #42:\n\n` +
			`### Thread 9 — General (not tied to a file/line) [active]\n` +
			`${webBase}/42?discussionId=9\n` +
			`- **Ada** (comment 1): Looks good\n\n` +
			`---\n\nSummary:\n\n` +
			`| Thread | Location | Status | Link |\n` +
			`| --- | --- | --- | --- |\n` +
			`| 9 | General (not tied to a file/line) | active | [Open](${webBase}/42?discussionId=9) |\n`,
	);
});

test("comment dispatches a general top-level thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "create", "--pr", "42", "--message", "General note"],
		{
			cwd,
			responses: [{ json: { id: 31, comments: [] } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				comments: [{ content: "General note" }],
				status: "active",
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Posted new comment thread 31 on PR #42.\n${webBase}/42?discussionId=31\n`,
	);
});

test("comment resolves and dispatches an anchored top-level thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"Anchored note",
			"--file",
			"src/app.ts",
			"--line",
			"3",
			"--end-line",
			"5",
		],
		{
			cwd,
			responses: [
				{ json: { value: [{ id: 2 }, { id: 7 }] } },
				{
					json: {
						changeEntries: [
							{ changeTrackingId: 88, item: { path: "/src/app.ts" } },
						],
					},
				},
				{ json: { id: 32, comments: [] } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/iterations/7/changes?api-version=7.1&$top=500&$skip=0`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				comments: [{ content: "Anchored note" }],
				status: "active",
				threadContext: {
					filePath: "/src/app.ts",
					rightFileStart: { line: 3, offset: 1 },
					rightFileEnd: { line: 5, offset: 1 },
				},
				pullRequestThreadContext: {
					iterationContext: {
						firstComparingIteration: 7,
						secondComparingIteration: 7,
					},
					changeTrackingId: 88,
				},
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Posted new comment thread 32 on PR #42.\n${webBase}/42?discussionId=32\n`,
	);
});

test("reply dispatches to the selected thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Reply text",
		],
		{
			cwd,
			responses: [{ json: { id: 2 } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({ content: "Reply text" }),
		},
	]);
	assert.equal(result.stdout, "Posted reply to thread 8 on PR #42.\n");
});

test("edit dispatches a comment content update and prints success", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"edit",
			"--pr",
			"42",
			"--thread",
			"8",
			"--comment",
			"3",
			"--message",
			"Revised text",
		],
		{
			cwd,
			responses: [{ json: { id: 3, content: "Revised text" } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
			method: "PATCH",
			body: { content: "Revised text" },
		},
	]);
	assert.equal(result.stdout, "Edited comment 3 in thread 8 on PR #42.\n");
});

test("delete dispatches a bodyless comment deletion and prints success", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "delete", "--pr", "42", "--thread", "8", "--comment", "3"],
		{
			cwd,
			responses: [{ body: "" }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
	]);
	assert.equal(result.stdout, "Deleted comment 3 from thread 8 on PR #42.\n");
});

test("resolve dispatches a fixed status update to the selected thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "resolve", "--pr", "42", "--thread", "9"],
		{
			cwd,
			responses: [{ json: { id: 9, status: "fixed" } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: JSON.stringify({ status: "fixed" }),
		},
	]);
	assert.equal(result.stdout, "Marked thread 9 on PR #42 as fixed.\n");
});

for (const [command, flags, status, confirmation] of [
	[
		"resolve",
		["--status", "wontFix"],
		"wontFix",
		"Marked thread 9 on PR #42 as wontFix.",
	],
	["reopen", [], "active", "Reopened thread 9 on PR #42."],
]) {
	test(`comment ${command} dispatches ${status}`, (t) => {
		const cwd = createRepo(t);
		const result = runPr(
			t,
			["comment", command, "--pr", "42", "--thread", "9", ...flags],
			{
				cwd,
				responses: [{ json: { id: 9, status } }],
			},
		);
		assertSucceeded(result);
		assert.deepEqual(result.calls.map(request), [
			{
				url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
				method: "PATCH",
				body: JSON.stringify({ status }),
			},
		]);
		assert.equal(result.stdout, `${confirmation}\n`);
	});
}

test("batch reads stdin and dispatches operations in order with per-operation PR overrides", (t) => {
	const cwd = createRepo(t);
	const operations = [
		{ command: "comment.create", message: "Batch note" },
		{ command: "comment.reply", pr: 77, thread: 8, message: "Batch reply" },
		{ command: "comment.edit", thread: 9, comment: 3, message: "Batch edit" },
		{ command: "comment.delete", thread: 10, comment: 4 },
		{ command: "comment.resolve", thread: 11 },
	];
	const result = runPr(t, ["comment", "batch", "--pr", "42"], {
		cwd,
		stdin: JSON.stringify(operations),
		responses: [
			{ json: { id: 51, comments: [] } },
			{ json: { id: 2 } },
			{ json: { id: 3, content: "Batch edit" } },
			{ body: "" },
			{ json: { id: 11, status: "fixed" } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: {
				comments: [{ content: "Batch note" }],
				status: "active",
			},
		},
		{
			url: `${apiBase}/pullRequests/77/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Batch reply" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9/comments/3?api-version=7.1`,
			method: "PATCH",
			body: { content: "Batch edit" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/10/comments/4?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/threads/11?api-version=7.1`,
			method: "PATCH",
			body: { status: "fixed" },
		},
	]);
	assert.equal(
		result.stdout,
		`[1/5] comment.create: posted new comment thread 51 on PR #42 (${webBase}/42?discussionId=51)\n` +
			`[2/5] comment.reply: posted reply to thread 8 on PR #77\n` +
			`[3/5] comment.edit: edited comment 3 in thread 9 on PR #42\n` +
			`[4/5] comment.delete: deleted comment 4 from thread 10 on PR #42\n` +
			`[5/5] comment.resolve: marked thread 11 on PR #42 as resolved\n`,
	);
});

test("a top-level Azure error is printed and exits nonzero", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["comment", "list", "--pr", "42"], {
		cwd,
		responses: [
			{
				status: 503,
				statusText: "Service Unavailable",
				body: "Azure is temporarily unavailable",
			},
		],
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stderr,
		`Azure DevOps API request (GET ${apiBase}/pullRequests/42/threads?api-version=7.1) failed: ` +
			`503 Service Unavailable\nAzure is temporarily unavailable\n`,
	);
});

test("build show --latest prints current branch-head diagnostics in human and JSON output", (t) => {
	for (const json of [false, true]) {
		const candidate = validationBuild({
			reason: "manual",
			sourceBranch: "refs/heads/feature/dispatch",
			sourceVersion: "head-1",
		});
		const result = runPr(
			t,
			["build", "show", "--latest", "--pr=42", ...(json ? ["--json"] : [])],
			{
				cwd: createRepo(t),
				responses: [
					{
						json: validationPr({
							lastMergeSourceCommit: { commitId: "head-1" },
						}),
					},
					{ json: { value: [] } },
					{ json: { value: [candidate] } },
					{ json: { records: [] } },
					{ json: { value: [] } },
				],
			},
		);
		assertSucceeded(result);
		if (json) {
			const output = JSON.parse(result.stdout);
			assert.equal(output.current, true);
			assert.equal(output.association, "branch-head");
			assert.deepEqual(output.build, candidate);
		} else {
			assert.match(result.stdout, /PR: #42 \(current\)/);
			assert.match(result.stdout, /Association: branch-head; commit: head-1/);
		}
		const branchQuery = new URL(result.calls[2].url);
		assert.equal(
			branchQuery.searchParams.get("branchName"),
			"refs/heads/feature/dispatch",
		);
		assert.equal(branchQuery.searchParams.get("reasonFilter"), null);
		assert.equal(result.calls.length, 5);
	}
});

test("build show --latest prints stale diagnostics and exits 1", (t) => {
	for (const json of [false, true]) {
		const stale = validationBuild({ sourceVersion: "old-merge" });
		const result = runPr(
			t,
			["build", "show", "--pr=42", "--latest", ...(json ? ["--json"] : [])],
			{
				cwd: createRepo(t),
				responses: [
					{
						json: validationPr({
							lastMergeSourceCommit: { commitId: "head-1" },
						}),
					},
					{ json: { value: [stale] } },
					{ json: { value: [] } },
					{ json: { records: [] } },
					{ json: { value: [] } },
				],
			},
		);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "");
		if (json) {
			assert.equal(JSON.parse(result.stdout).current, false);
			assert.equal(JSON.parse(result.stdout).build.sourceVersion, "old-merge");
		} else {
			assert.match(result.stdout, /stale/);
			assert.match(result.stdout, /commit: old-merge/);
		}
	}
});

test("build wait --latest selects and polls the newest validating build", (t) => {
	const branch = validationBuild({
		id: 701,
		reason: "manual",
		sourceBranch: "refs/heads/feature/dispatch",
		sourceVersion: "head-1",
		queueTime: "2026-08-19T10:00:00Z",
		result: "succeeded",
	});
	for (const json of [false, true]) {
		const result = runPr(
			t,
			["build", "wait", "--pr=42", "--latest", ...(json ? ["--json"] : [])],
			{
				cwd: createRepo(t),
				responses: [
					{
						json: validationPr({
							lastMergeSourceCommit: { commitId: "head-1" },
						}),
					},
					{ json: { value: [validationBuild()] } },
					{ json: { value: [branch] } },
					{ json: branch },
				],
			},
		);
		assert.equal(result.status, 0);
		assert.match(
			result.stderr,
			/build 701: initial state completed\/succeeded/,
		);
		if (json) {
			const output = JSON.parse(result.stdout);
			assert.equal(output.buildId, 701);
			assert.equal(output.association, "branch-head");
			assert.equal(output.outcome, "succeeded");
			assert.equal(output.pollCount, 1);
		} else {
			assert.match(result.stdout, /build 701.*outcome succeeded/);
			assert.match(result.stdout, /Association: branch-head/);
		}
		assert.equal(result.calls.length, 4);
		assert.equal(result.calls[3].url, `${buildApiBase}/701?api-version=7.1`);
	}
});

test("build wait --latest fails naming the head when no build validates it", (t) => {
	const result = runPr(t, ["build", "wait", "--pr=42", "--latest", "--json"], {
		cwd: createRepo(t),
		responses: [
			{ json: validationPr({ lastMergeSourceCommit: { commitId: "head-1" } }) },
			{ json: { value: [validationBuild({ sourceVersion: "old-merge" })] } },
			{ json: { value: [] } },
		],
	});
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /No build validates PR #42 head commit head-1/);
	assert.equal(result.calls.length, 3);
});

test("build show/wait require exactly one selector before any Azure request", (t) => {
	for (const command of ["show", "wait"]) {
		for (const [args, error] of [
			[[], /exactly one of --build or --latest is required/],
			[
				["--build=700", "--latest"],
				/--build and --latest are mutually exclusive/,
			],
		]) {
			const result = runPr(t, ["build", command, ...args], {
				cwd: createRepo(t),
				responses: [],
			});
			assert.equal(result.status, 1);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, error);
			assert.deepEqual(result.calls, []);
		}
	}
});
