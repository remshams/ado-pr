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

const buildListUrl = (branch) =>
	`${buildApiBase}?${branch === "merge" ? "reasonFilter=pullRequest&" : ""}branchName=${encodeURIComponent(branch === "merge" ? "refs/pull/42/merge" : "refs/heads/feature/dispatch")}&repositoryId=repo-id&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&api-version=7.1`;

function headValidationPr(overrides = {}) {
	return validationPr({
		lastMergeSourceCommit: { commitId: "head-2" },
		...overrides,
	});
}

function listBuilds() {
	const branch = (id, sourceVersion, queueTime) =>
		validationBuild({
			id,
			reason: "manual",
			sourceBranch: "refs/heads/feature/dispatch",
			sourceVersion,
			queueTime,
		});
	return {
		merge: validationBuild({ id: 702, queueTime: "2026-08-18T11:00:00Z" }),
		staleMerge: validationBuild({
			id: 700,
			sourceVersion: "merge-0",
			queueTime: "2026-08-18T09:00:00Z",
		}),
		branch: branch(703, "head-2", "2026-08-18T12:00:00Z"),
		staleBranch: branch(701, "head-1", "2026-08-18T10:00:00Z"),
	};
}

test("build list dispatches through BuildService and prints a normalized JSON envelope", (t) => {
	const cwd = createRepo(t);
	const pr = validationPr();
	const result = runPr(t, ["build", "list", "--pr", "42", "--json"], {
		cwd,
		responses: [
			{ json: pr },
			{ json: { count: 0, value: [] } },
			{ json: { count: 0, value: [] } },
			{ json: pr },
		],
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
		hiddenBuilds: 0,
	});
	assert.equal(result.calls[1].url, buildListUrl("merge"));
	assert.equal(result.calls[2].url, buildListUrl("branch"));
});

test("build list --json merges PR and branch builds newest first with the label and current marker", (t) => {
	const cwd = createRepo(t);
	const { merge, staleMerge, branch, staleBranch } = listBuilds();
	const pr = headValidationPr();
	const result = runPr(t, ["build", "list", "--pr", "42", "--json"], {
		cwd,
		responses: [
			{ json: pr },
			{ json: { value: [merge, staleMerge] } },
			{ json: { value: [staleBranch, branch] } },
			{ json: pr },
		],
	});

	assertSucceeded(result);
	const { builds } = JSON.parse(result.stdout);
	assert.deepEqual(
		builds.map(({ id, association, current }) => [id, association, current]),
		[
			[703, "branch-head", true],
			[702, "pr-merge", true],
		],
	);
	assert.equal(builds[0].sourceVersion, "head-2");
	assert.equal(builds[0].queueTime, "2026-08-18T12:00:00Z");
});

test("build list --history prints every associated build newest first with labels", (t) => {
	const cwd = createRepo(t);
	const { merge, staleMerge, branch, staleBranch } = listBuilds();
	const result = runPr(
		t,
		["build", "list", "--pr", "42", "--history", "--json"],
		{
			cwd,
			responses: [
				{ json: headValidationPr() },
				{ json: { value: [merge, staleMerge] } },
				{ json: { value: [staleBranch, branch] } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(
		JSON.parse(result.stdout).builds.map(({ id, association, current }) => [
			id,
			association,
			current,
		]),
		[
			[703, "branch-head", true],
			[702, "pr-merge", true],
			[701, "branch-head", false],
			[700, "pr-merge", false],
		],
	);
});

test("build list --history human output labels both build kinds and marks current builds", (t) => {
	const cwd = createRepo(t);
	const { merge, branch } = listBuilds();
	const result = runPr(t, ["build", "list", "--pr", "42", "--history"], {
		cwd,
		responses: [
			{ json: headValidationPr() },
			{ json: { value: [merge] } },
			{ json: { value: [branch] } },
		],
	});

	assertSucceeded(result);
	assert.match(
		result.stdout,
		/Builds for PR #42: Build validation \(history\)/,
	);
	assert.match(
		result.stdout,
		/Build 703\/[^\n]*\n {2}Association: branch-head\n {2}Status\/result: completed\/failed \[current\]/,
	);
	assert.match(
		result.stdout,
		/Build 702\/[^\n]*\n {2}Association: pr-merge\n {2}Status\/result: completed\/failed \[current\]/,
	);
});

test("build list explains an empty current view that hides stale builds", (t) => {
	const cwd = createRepo(t);
	const { staleMerge, staleBranch } = listBuilds();
	const result = runPr(t, ["build", "list", "--pr", "42"], {
		cwd,
		responses: [
			{ json: headValidationPr() },
			{ json: { value: [staleMerge] } },
			{ json: { value: [staleBranch] } },
			{ json: headValidationPr() },
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"No associated current head builds found for PR #42. 2 stale builds exist; use build list --history or build show --latest.\n",
	);
});

test("build list prints a successful explicit message for an empty current collection", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["build", "list", "--pr", "42"], {
		cwd,
		responses: [
			{ json: validationPr() },
			{ json: { value: [] } },
			{ json: { value: [] } },
			{ json: validationPr() },
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"No associated current head builds found for PR #42.\n",
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

test("build queue --branch queues the repository policy build and prints its ID and URL", (t) => {
	const cwd = createRepo(t);
	const returned = validationBuild({
		id: 702,
		sourceBranch: "refs/heads/release/next",
		_links: { web: { href: "https://dev.azure.com/acme/build/702" } },
	});
	const result = runPr(t, ["build", "queue", "--branch", "release/next"], {
		cwd,
		responses: [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 3,
							type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: returned },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: "https://dev.azure.com/acme/Test%20Project/_apis/git/repositories/widgets?api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: "https://dev.azure.com/acme/Test%20Project/_apis/policy/configurations?api-version=7.1&policyType=0609b952-1397-4640-95ec-e00a01b2c241",
			method: "GET",
			body: null,
		},
		{
			url: `${buildApiBase}?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				definition: { id: 9 },
				sourceBranch: "refs/heads/release/next",
			}),
		},
	]);
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 702/20260818.1.\nURL: https://dev.azure.com/acme/build/702\n",
	);
});

test("build queue --pr reports when the requeued evaluation has no build ID", (t) => {
	const cwd = createRepo(t);
	const pr = validationPr({
		repository: {
			id: "repo-id",
			name: "widgets",
			project: { id: "project-id" },
		},
		lastMergeSourceCommit: { commitId: "head-1" },
	});
	const result = runPr(t, ["build", "queue", "--pr", "42"], {
		cwd,
		responses: [
			{ json: pr },
			{
				json: {
					value: [
						{
							evaluationId: "evaluation-id",
							configuration: {
								name: "Widget CI",
								type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
							},
						},
					],
				},
			},
			{ json: { evaluationId: "evaluation-id", status: "queued" } },
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
			{
				url: "https://dev.azure.com/acme/Test%20Project/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
				method: "GET",
				body: null,
			},
			{
				url: "https://dev.azure.com/acme/Test%20Project/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
				method: "PATCH",
				body: JSON.stringify({ status: "queued" }),
			},
		],
	);
	assert.equal(
		result.stdout,
		"Requeued build policy evaluation evaluation-id for PR #42.\n" +
			"Azure DevOps did not return the build ID yet. Check with `pr.sh build show --latest --pr 42`.\n",
	);
	assert.equal(result.status, 0);
});

test("build queue --pr fetches and prints the build ID from evaluation context", (t) => {
	const cwd = createRepo(t);
	const pr = validationPr({
		repository: {
			id: "repo-id",
			name: "widgets",
			project: { id: "project-id" },
		},
		lastMergeSourceCommit: { commitId: "head-1" },
	});
	const queued = validationBuild({
		id: 701,
		_links: { web: { href: "https://dev.azure.com/acme/build/701" } },
	});
	const result = runPr(t, ["build", "queue", "--pr", "42"], {
		cwd,
		responses: [
			{ json: pr },
			{
				json: {
					value: [
						{
							evaluationId: "evaluation-id",
							configuration: {
								type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
							},
						},
					],
				},
			},
			{
				json: {
					evaluationId: "evaluation-id",
					status: "queued",
					context: { buildId: 701 },
				},
			},
			{ json: queued },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(
		result.calls
			.slice(2)
			.map(({ url, method, body }) => ({ url, method, body })),
		[
			{
				url: "https://dev.azure.com/acme/Test%20Project/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
				method: "PATCH",
				body: JSON.stringify({ status: "queued" }),
			},
			{
				url: `${buildApiBase}/701?api-version=7.1`,
				method: "GET",
				body: null,
			},
		],
	);
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 701/20260818.1.\nURL: https://dev.azure.com/acme/build/701\n",
	);
});

test("build queue requires exactly one queue target before any Azure request", (t) => {
	const cwd = createRepo(t);
	for (const args of [
		["build", "queue"],
		["build", "queue", "--pr", "42", "--branch", "main"],
	]) {
		const result = runPr(t, args, { cwd, responses: [] });
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/exactly one of --pr or --branch|--pr and --branch are mutually exclusive/,
		);
		assert.equal(result.calls.length, 0);
	}
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

test("reply --status posts the reply, then sets the thread status", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"9",
			"--message",
			"Done",
			"--status",
			"ByDesign",
		],
		{ cwd, responses: [{ json: { id: 2 } }, { json: { id: 9 } }] },
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/9/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Done" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: { status: "byDesign" },
		},
	]);
	assert.equal(
		result.stdout,
		"Posted reply to thread 9 on PR #42 and marked it as byDesign.\n",
	);
});

test("reply --status reports the posted reply when the status update fails", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"9",
			"--message",
			"Done",
			"--status",
			"fixed",
		],
		{
			cwd,
			responses: [
				{ json: { id: 2 } },
				{ status: 500, statusText: "Server Error", body: "boom" },
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/Reply posted to thread 9, but setting its status to fixed failed: /,
	);
});

test("batch dispatches reply and resolve statuses and reopen", (t) => {
	const cwd = createRepo(t);
	const operations = [
		{ command: "comment.reply", thread: 8, message: "Done", status: "closed" },
		{ command: "comment.resolve", thread: 9, status: "wontFix" },
		{ command: "comment.reopen", pr: 77, thread: 10 },
	];
	const result = runPr(t, ["comment", "batch", "--pr", "42"], {
		cwd,
		stdin: JSON.stringify(operations),
		responses: [{ json: {} }, { json: {} }, { json: {} }, { json: {} }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Done" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/8?api-version=7.1`,
			method: "PATCH",
			body: { status: "closed" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: { status: "wontFix" },
		},
		{
			url: `${apiBase}/pullRequests/77/threads/10?api-version=7.1`,
			method: "PATCH",
			body: { status: "active" },
		},
	]);
	assert.equal(
		result.stdout,
		"[1/3] comment.reply: posted reply to thread 8 on PR #42 and marked it as closed\n" +
			"[2/3] comment.resolve: marked thread 9 on PR #42 as wontFix\n" +
			"[3/3] comment.reopen: reopened thread 10 on PR #77\n",
	);
});

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
			`[5/5] comment.resolve: marked thread 11 on PR #42 as fixed\n`,
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

function statusPr(overrides = {}) {
	return validationPr({
		isDraft: false,
		repository: {
			id: "repo-id",
			name: "widgets",
			project: { id: "project-id" },
		},
		lastMergeSourceCommit: { commitId: "head-1" },
		mergeStatus: "succeeded",
		reviewers: [{ id: "ada", displayName: "Ada", vote: 10 }],
		...overrides,
	});
}

function statusThread(id, status = "active") {
	return {
		id,
		status,
		comments: [{ id, content: `comment ${id}`, commentType: "text" }],
	};
}

function statusSystemThread(content, publishedDate) {
	return {
		id: 90,
		comments: [{ id: 1, content, commentType: "system", publishedDate }],
	};
}

const policyEvaluationsUrl = `https://dev.azure.com/acme/Test%20Project/_apis/policy/evaluations?artifactId=${encodeURIComponent("vstfs:///CodeReview/CodeReviewId/project-id/42")}&api-version=7.1-preview.1`;

function runStatus(
	t,
	{
		pr = statusPr(),
		merge = [],
		branch = [],
		threads = [],
		iterations = [{ id: 1 }, { id: 2 }],
		policies = { json: { value: [] } },
		args = [],
	},
	extra = [],
) {
	return runPr(t, ["pr", "status", "--pr", "42", ...args], {
		cwd: createRepo(t),
		responses: [
			{ json: pr },
			{ json: { value: merge } },
			{ json: { value: branch } },
			{ json: { value: threads } },
			{ json: { value: iterations } },
			...extra,
			policies,
		],
	});
}

test("pr status reports a clean PR in one call", (t) => {
	const result = runStatus(t, {
		merge: [validationBuild({ result: "succeeded", sourceVersion: "merge-1" })],
	});
	assertSucceeded(result);
	assert.equal(
		result.stdout,
		[
			"PR #42: Build validation (active)",
			`${webBase}/42`,
			"Draft: no",
			"Head: head-1",
			"Merge commit: merge-1",
			"Iteration: 2",
			"Build: succeeded - build 700 (20260818.1, pr-merge) validates the head",
			"Copilot review (best effort): none",
			"Unresolved threads: 0",
			"Merge status: succeeded",
			"Blocked by: none",
			"Reviewers: Ada: approved",
			"",
		].join("\n"),
	);
	assert.deepEqual(
		result.calls.map((call) => call.method),
		["GET", "GET", "GET", "GET", "GET", "GET"],
	);
	assert.equal(
		result.calls[0].url,
		`${apiBase}/pullRequests/42?api-version=7.1`,
	);
	assert.equal(
		result.calls[3].url,
		`${apiBase}/pullRequests/42/threads?api-version=7.1`,
	);
	assert.equal(
		result.calls[4].url,
		`${apiBase}/pullRequests/42/iterations?api-version=7.1`,
	);
	assert.equal(result.calls[5].url, policyEvaluationsUrl);
});

test("pr status --json prints the whole status as a stable document", (t) => {
	const result = runStatus(
		t,
		{
			args: ["--json"],
			pr: statusPr({
				isDraft: true,
				mergeStatus: "conflicts",
				reviewers: [
					{ id: "ada", displayName: "Ada", vote: -10, isRequired: true },
				],
			}),
			merge: [
				validationBuild({ result: "succeeded", sourceVersion: "merge-1" }),
			],
			policies: {
				json: {
					value: [
						{
							status: "rejected",
							configuration: {
								isBlocking: true,
								type: { displayName: "Minimum number of reviewers" },
							},
						},
						{
							status: "queued",
							configuration: {
								isBlocking: false,
								type: { displayName: "Work item linking" },
							},
						},
					],
				},
			},
		},
		[
			{
				json: {
					value: [{ conflictPath: "/src/a.ts", conflictType: "content" }],
				},
			},
		],
	);
	assertSucceeded(result);
	assert.deepEqual(JSON.parse(result.stdout), {
		id: 42,
		title: "Build validation",
		state: "active",
		draft: true,
		url: `${webBase}/42`,
		headCommit: "head-1",
		mergeCommit: "merge-1",
		iteration: 2,
		build: {
			id: 700,
			number: "20260818.1",
			status: "completed",
			result: "succeeded",
			sourceVersion: "merge-1",
			association: "pr-merge",
			validatesHead: true,
		},
		copilot: { state: "none", text: null, date: null },
		unresolvedThreads: 0,
		mergeStatus: "conflicts",
		conflicts: {
			kind: "listed",
			conflicts: [{ path: "/src/a.ts", type: "content" }],
		},
		blockingPolicies: {
			kind: "listed",
			policies: [{ name: "Minimum number of reviewers", status: "rejected" }],
		},
		reviewers: [
			{ name: "Ada", vote: -10, voteLabel: "rejected", required: true },
		],
	});
});

test("pr status prints the draft state, blocking policies and required reviewers", (t) => {
	const result = runStatus(t, {
		pr: statusPr({
			isDraft: true,
			reviewers: [
				{ id: "ada", displayName: "Ada", vote: 10, isRequired: true },
				{ id: "bob", displayName: "Bob", vote: 0 },
			],
		}),
		policies: {
			json: {
				value: [
					{
						status: "rejected",
						configuration: {
							isBlocking: true,
							type: { displayName: "Minimum number of reviewers" },
						},
					},
					{
						status: "queued",
						configuration: {
							isBlocking: true,
							type: { displayName: "Work item linking" },
						},
					},
					{
						status: "approved",
						configuration: { isBlocking: true, type: { displayName: "Build" } },
					},
				],
			},
		},
	});
	assertSucceeded(result);
	assert.match(result.stdout, /^Draft: yes$/m);
	assert.match(
		result.stdout,
		/^Blocked by: Minimum number of reviewers \(rejected\), Work item linking \(queued\)$/m,
	);
	assert.match(
		result.stdout,
		/^Reviewers: Ada: approved \(required\), Bob: no vote$/m,
	);
});

test("pr status keeps going when the policy evaluations cannot be read", (t) => {
	const result = runStatus(t, {
		policies: { status: 403, statusText: "Forbidden", body: "denied" },
	});
	assertSucceeded(result);
	assert.match(result.stdout, /^Blocked by: could not be listed \(.*403/m);
	assert.match(result.stdout, /^Iteration: 2$/m);
});

test("pr status --json reports unavailable policies without failing", (t) => {
	const result = runStatus(t, {
		args: ["--json"],
		policies: { status: 403, statusText: "Forbidden", body: "denied" },
	});
	assertSucceeded(result);
	const { blockingPolicies } = JSON.parse(result.stdout);
	assert.equal(blockingPolicies.kind, "unavailable");
	assert.match(blockingPolicies.error, /403/);
});

test("pr status accepts a source-branch build that validates the head", (t) => {
	const result = runStatus(t, {
		branch: [
			validationBuild({
				reason: "manual",
				result: "succeeded",
				sourceBranch: "refs/heads/feature/dispatch",
				sourceVersion: "head-1",
			}),
		],
	});
	assertSucceeded(result);
	assert.match(
		result.stdout,
		/^Build: succeeded - build 700 \(20260818\.1, branch-head\) validates the head$/m,
	);
});

test("pr status marks the build stale when none validates the head", (t) => {
	const result = runStatus(t, {
		merge: [validationBuild({ sourceVersion: "old-merge" })],
	});
	assertSucceeded(result);
	assert.match(
		result.stdout,
		/^Build: stale - no build validates head head-1; newest is build 700 \(20260818\.1, pr-merge\) at old-merge with failed$/m,
	);
});

test("pr status reports when the PR has no builds", (t) => {
	const result = runStatus(t, {});
	assertSucceeded(result);
	assert.match(
		result.stdout,
		/^Build: none \(no build is associated with this PR\)$/m,
	);
});

test("pr status lists merge conflicts from the conflicts endpoint", (t) => {
	const result = runStatus(t, { pr: statusPr({ mergeStatus: "conflicts" }) }, [
		{
			json: {
				value: [
					{ conflictPath: "/src/a.ts", conflictType: "content" },
					{ conflictPath: "/src/b.ts", conflictType: "delete" },
				],
			},
		},
	]);
	assertSucceeded(result);
	assert.match(
		result.stdout,
		/^Merge status: conflicts\nConflicts \(2\):\n {2}- \/src\/a\.ts \(content\)\n {2}- \/src\/b\.ts \(delete\)\nBlocked by: none\nReviewers:/m,
	);
	assert.equal(
		result.calls[5].url,
		`${apiBase}/pullRequests/42/conflicts?$top=50&api-version=7.1-preview.1`,
	);
});

test("pr status keeps going when the conflicts endpoint fails", (t) => {
	const result = runStatus(t, { pr: statusPr({ mergeStatus: "conflicts" }) }, [
		{ status: 404, statusText: "Not Found", body: "no such resource" },
	]);
	assertSucceeded(result);
	assert.match(result.stdout, /^Merge status: conflicts$/m);
	assert.match(result.stdout, /^Conflicts: could not be listed \(.*404/m);
});

test("pr status counts only unresolved review threads", (t) => {
	const result = runStatus(t, {
		threads: [
			statusThread(1),
			statusThread(2, "pending"),
			statusThread(3, "fixed"),
			statusThread(4, "closed"),
			statusSystemThread("Policy status updated", "2026-10-20T10:00:00Z"),
		],
	});
	assertSucceeded(result);
	assert.match(result.stdout, /^Unresolved threads: 2$/m);
});

test("pr status reports requested, completed and absent Copilot activity", (t) => {
	const requested = statusSystemThread(
		"Copilot balanced review requested by branch policy.",
		"2026-10-20T10:00:00Z",
	);
	const completed = {
		...statusSystemThread(
			"Copilot code review completed",
			"2026-10-20T10:05:00Z",
		),
		id: 91,
	};
	for (const [threads, line] of [
		[[], "none"],
		[[requested], "requested (2026-10-20T10:00:00Z)"],
		[[requested, completed], "completed (2026-10-20T10:05:00Z)"],
	]) {
		const result = runStatus(t, { threads });
		assertSucceeded(result);
		assert.match(
			result.stdout,
			new RegExp(
				`^Copilot review \\(best effort\\): ${line.replace(/[()]/g, "\\$&")}$`,
				"m",
			),
		);
	}
});

test("pr status shows a newer unknown Copilot entry instead of the older request", (t) => {
	const requested = statusSystemThread(
		"Copilot balanced review requested by branch policy.",
		"2026-10-20T10:00:00Z",
	);
	const cancelled = {
		...statusSystemThread(
			"Copilot code review cancelled",
			"2026-10-20T10:30:00Z",
		),
		id: 91,
	};
	const result = runStatus(t, { threads: [requested, cancelled] });
	assertSucceeded(result);
	assert.match(
		result.stdout,
		/^Copilot review \(best effort\): "Copilot code review cancelled" \(2026-10-20T10:30:00Z\)$/m,
	);
});

test("pr status resolves the current branch PR when --pr is omitted", (t) => {
	const result = runPr(t, ["pr", "status"], {
		cwd: createRepo(t),
		responses: [
			{ json: { value: [statusPr()] } },
			{ json: statusPr() },
			{ json: { value: [] } },
			{ json: { value: [] } },
			{ json: { value: [] } },
			{ json: { value: [{ id: 1 }] } },
			{ json: { value: [] } },
		],
	});
	assertSucceeded(result);
	assert.match(result.stdout, /^PR #42: Build validation/);
	assert.equal(result.calls.length, 7);
});

test("pr status reports Azure errors and exits 1", (t) => {
	const result = runPr(t, ["pr", "status", "--pr", "42"], {
		cwd: createRepo(t),
		responses: [{ status: 404, statusText: "Not Found", body: "missing" }],
	});
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /404 Not Found/);
});

function diffIterations(count) {
	return {
		json: {
			count,
			value: Array.from({ length: count }, (_, index) => ({
				id: index + 1,
				sourceRefCommit: { commitId: `source-${index + 1}` },
				commonRefCommit: { commitId: `common-${index + 1}` },
				createdDate: `2026-10-0${index + 1}T12:00:00Z`,
			})),
		},
	};
}

function diffChange(changeType, path, extra = {}) {
	return {
		changeId: 1,
		changeTrackingId: 1,
		changeType,
		item: { path },
		...extra,
	};
}

function diffItem(content, isBinary = false) {
	return {
		json: { gitObjectType: "blob", content, contentMetadata: { isBinary } },
	};
}

function diffItemUrl(path, commit) {
	return `${apiBase}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json&api-version=7.1`;
}

test("pr diff prints modified, added, deleted, renamed and binary files", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42"], {
		cwd,
		responses: [
			diffIterations(2),
			{
				json: {
					changeEntries: [
						diffChange("edit", "/src/app.ts"),
						diffChange("add", "/docs/new.md"),
						diffChange("delete", "/old.txt"),
						diffChange("edit, rename", "/src/renamed.ts", {
							originalPath: "/src/original.ts",
						}),
						diffChange("edit", "/logo.png"),
					],
				},
			},
			diffItem("a\nb\nc\n"),
			diffItem("a\nB\nc\n"),
			{
				json: [
					{
						path: "/src/app.ts",
						lineDiffBlocks: [
							{
								changeType: "edit",
								originalLineNumberStart: 2,
								originalLinesCount: 1,
								modifiedLineNumberStart: 2,
								modifiedLinesCount: 1,
							},
						],
					},
				],
			},
			diffItem("# New\n"),
			diffItem("gone\n"),
			diffItem("x\n"),
			diffItem("x\ny\n"),
			{
				json: [
					{
						path: "/src/renamed.ts",
						originalPath: "/src/original.ts",
						lineDiffBlocks: [
							{
								changeType: "add",
								originalLineNumberStart: 2,
								originalLinesCount: 0,
								modifiedLineNumberStart: 2,
								modifiedLinesCount: 1,
							},
						],
					},
				],
			},
			diffItem("PNG", true),
			diffItem("PNG", true),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		[
			"PR #42: iteration 2 compared with the merge base.",
			"diff --git a/src/app.ts b/src/app.ts",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
			"diff --git a/docs/new.md b/docs/new.md",
			"--- /dev/null",
			"+++ b/docs/new.md",
			"@@ -0,0 +1,1 @@",
			"+# New",
			"diff --git a/old.txt b/old.txt",
			"--- a/old.txt",
			"+++ /dev/null",
			"@@ -1,1 +0,0 @@",
			"-gone",
			"diff --git a/src/original.ts b/src/renamed.ts",
			"rename from src/original.ts",
			"rename to src/renamed.ts",
			"--- a/src/original.ts",
			"+++ b/src/renamed.ts",
			"@@ -1,1 +1,2 @@",
			" x",
			"+y",
			"diff --git a/logo.png b/logo.png",
			"Binary files a/logo.png and b/logo.png differ",
			"",
		].join("\n"),
	);
	assert.deepEqual(
		result.calls.map((call) => `${call.method} ${call.url}`),
		[
			`GET ${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			`GET ${apiBase}/pullRequests/42/iterations/2/changes?$top=2000&api-version=7.1`,
			`GET ${diffItemUrl("/src/app.ts", "common-2")}`,
			`GET ${diffItemUrl("/src/app.ts", "source-2")}`,
			`POST ${apiBase}/filediffs?api-version=7.1-preview.1`,
			`GET ${diffItemUrl("/docs/new.md", "source-2")}`,
			`GET ${diffItemUrl("/old.txt", "common-2")}`,
			`GET ${diffItemUrl("/src/original.ts", "common-2")}`,
			`GET ${diffItemUrl("/src/renamed.ts", "source-2")}`,
			`POST ${apiBase}/filediffs?api-version=7.1-preview.1`,
			`GET ${diffItemUrl("/logo.png", "common-2")}`,
			`GET ${diffItemUrl("/logo.png", "source-2")}`,
		],
	);
	assert.deepEqual(semanticRequest(result.calls[9]).body, {
		baseVersionCommit: "common-2",
		targetVersionCommit: "source-2",
		fileDiffParams: [
			{ path: "/src/renamed.ts", originalPath: "/src/original.ts" },
		],
	});
});

test("pr diff --since-iteration compares the current branch's PR with an earlier iteration", (t) => {
	const cwd = createRepo(t, "feature/diff");
	const result = runPr(t, ["pr", "diff", "--since-iteration", "2"], {
		cwd,
		responses: [
			{ json: { value: [validationPr({ pullRequestId: 73 })] } },
			diffIterations(3),
			{ json: { changeEntries: [diffChange("add", "/later.txt")] } },
			diffItem("later\n"),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"PR #73: iteration 3 compared with iteration 2.\ndiff --git a/later.txt b/later.txt\n--- /dev/null\n+++ b/later.txt\n@@ -0,0 +1,1 @@\n+later\n",
	);
	assert.deepEqual(
		result.calls.slice(1).map((call) => call.url),
		[
			`${apiBase}/pullRequests/73/iterations?api-version=7.1`,
			`${apiBase}/pullRequests/73/iterations/3/changes?$top=2000&$compareTo=2&api-version=7.1`,
			diffItemUrl("/later.txt", "source-3"),
		],
	);
});

test("pr diff stops at the output limit with a truncation notice", (t) => {
	const cwd = createRepo(t);
	const fileText = `${"x".repeat(99)}\n`.repeat(550);
	const result = runPr(t, ["pr", "diff", "--pr", "42"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("add", "/one.txt"),
						diffChange("add", "/two.txt"),
						diffChange("add", "/three.txt"),
					],
				},
			},
			diffItem(fileText),
			diffItem(fileText),
		],
	});

	assertSucceeded(result);
	assert.match(
		result.stdout,
		/\n\+x+\nDiff truncated at the 100,000-byte limit in file 2 of 3 \(two\.txt\)\.\n$/,
	);
	const heading = "PR #42: iteration 1 compared with the merge base.\n";
	const notice = result.stdout.slice(
		result.stdout.lastIndexOf("Diff truncated"),
	);
	assert.ok(
		Buffer.byteLength(result.stdout) - heading.length - notice.length <=
			100_000,
	);
	assert.equal(result.calls.length, 4);
});

test("pr diff rejects an iteration the PR does not have", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--since-iteration", "5"],
		{
			cwd,
			responses: [diffIterations(2)],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"PR #42 has no iteration 5; the latest iteration is 2.\n",
	);
});

const connectionDataUrl =
	"https://dev.azure.com/acme/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1";

test("pr diff --since-last-review compares with the iteration before the user's last vote", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--since-last-review"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{
				json: {
					value: [
						{
							id: 1,
							comments: [
								{
									id: 1,
									author: { id: "me" },
									commentType: "text",
									content: "Please rename",
									publishedDate: "2026-10-01T15:00:00Z",
								},
							],
						},
						{
							id: 2,
							properties: {
								CodeReviewThreadType: {
									$type: "System.String",
									$value: "VoteUpdate",
								},
								CodeReviewVotedByIdentity: {
									$type: "System.String",
									$value: "1",
								},
							},
							identities: { 1: { id: "me", displayName: "Ada" } },
							comments: [
								{
									id: 1,
									author: { id: "azure-service" },
									commentType: "system",
									content: "Ada voted 10",
									publishedDate: "2026-10-02T15:00:00Z",
								},
							],
						},
					],
				},
			},
			diffIterations(3),
			{ json: { changeEntries: [diffChange("add", "/later.txt")] } },
			diffItem("later\n"),
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"PR #42: iteration 3 compared with iteration 2, the latest before your last review on 2026-10-02T15:00:00.000Z.\ndiff --git a/later.txt b/later.txt\n--- /dev/null\n+++ b/later.txt\n@@ -0,0 +1,1 @@\n+later\n",
	);
	assert.deepEqual(
		result.calls.map((call) => call.url),
		[
			connectionDataUrl,
			`${apiBase}/pullRequests/42/threads?api-version=7.1`,
			`${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			`${apiBase}/pullRequests/42/iterations/3/changes?$top=2000&$compareTo=2&api-version=7.1`,
			diffItemUrl("/later.txt", "source-3"),
		],
	);
});

test("pr diff --since-last-review fails without activity by the user", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--since-last-review"], {
		cwd,
		responses: [
			{ json: { authenticatedUser: { id: "me" } } },
			{ json: { value: [] } },
			diffIterations(2),
		],
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"Found no comment or vote by you on PR #42. Use --since-iteration <n> instead.\n",
	);
});

test("pr diff --since-last-review rejects --since-iteration before any request", (t) => {
	const result = runPr(
		t,
		["pr", "diff", "--since-last-review", "--since-iteration", "1"],
		{ cwd: createRepo(t), responses: [] },
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^Error: --since-iteration and --since-last-review are mutually exclusive for "pr diff"\n/,
	);
	assert.equal(result.calls.length, 0);
});

test("pr diff --name-only prints only path lines and reads no content", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--name-only"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("edit", "/src/app.ts"),
						diffChange("edit, rename", "/src/renamed.ts", {
							originalPath: "/src/original.ts",
						}),
						diffChange("delete", "/old.txt"),
					],
				},
			},
		],
	});

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"edit\tsrc/app.ts\nrename\tsrc/original.ts -> src/renamed.ts\ndelete\told.txt\n",
	);
	assert.equal(result.calls.length, 2);
});

test("pr diff --json prints files, change types and line blocks", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--since-iteration", "1", "--json"],
		{
			cwd,
			responses: [
				diffIterations(2),
				{
					json: {
						changeEntries: [
							diffChange("edit", "/src/app.ts"),
							diffChange("add", "/logo.png"),
						],
					},
				},
				diffItem("a\nb\nc\n"),
				diffItem("a\nB\nc\n"),
				{
					json: [
						{
							path: "/src/app.ts",
							lineDiffBlocks: [
								{
									changeType: "edit",
									originalLineNumberStart: 2,
									originalLinesCount: 1,
									modifiedLineNumberStart: 2,
									modifiedLinesCount: 1,
								},
							],
						},
					],
				},
				diffItem("PNG", true),
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(JSON.parse(result.stdout), {
		pullRequestId: 42,
		iteration: 2,
		baseIteration: 1,
		lastReview: null,
		files: [
			{
				path: "src/app.ts",
				originalPath: "src/app.ts",
				change: "edit",
				content: "text",
				blocks: [
					{
						originalStart: 2,
						originalCount: 1,
						modifiedStart: 2,
						modifiedCount: 1,
						removed: ["b"],
						added: ["B"],
					},
				],
			},
			{
				path: "logo.png",
				originalPath: "logo.png",
				change: "add",
				content: "binary",
				blocks: [],
			},
		],
		truncated: false,
	});
});

test("pr diff --json keeps the printed output within 100,000 bytes", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["pr", "diff", "--pr", "42", "--json"], {
		cwd,
		responses: [
			diffIterations(1),
			{
				json: {
					changeEntries: [
						diffChange("add", "/huge.txt"),
						diffChange("add", "/half.txt"),
						diffChange("add", "/small.txt"),
					],
				},
			},
			// One-character lines take about 15 bytes each in the printed JSON.
			diffItem("x\n".repeat(8000)),
			diffItem("y\n".repeat(4000)),
			diffItem("small\n"),
		],
	});

	assertSucceeded(result);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(
		output.files.map((file) => [file.path, file.content]),
		[
			["huge.txt", "omitted"],
			["half.txt", "text"],
			["small.txt", "text"],
		],
	);
	assert.equal(output.truncated, true);
	assert.ok(Buffer.byteLength(result.stdout) <= 100_000);
	assert.ok(Buffer.byteLength(result.stdout) > 60_000);
});

test("pr diff --json --name-only prints only paths and change types", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["pr", "diff", "--pr", "42", "--name-only", "--json"],
		{
			cwd,
			responses: [
				diffIterations(1),
				{ json: { changeEntries: [diffChange("add", "/new\u202e.txt")] } },
			],
		},
	);

	assertSucceeded(result);
	assert.match(result.stdout, /"path": "new\\u202e\.txt"/);
	assert.deepEqual(JSON.parse(result.stdout), {
		pullRequestId: 42,
		iteration: 1,
		baseIteration: null,
		lastReview: null,
		files: [
			{ path: "new\u202e.txt", originalPath: "new\u202e.txt", change: "add" },
		],
		truncated: false,
	});
	assert.equal(result.calls.length, 2);
});
