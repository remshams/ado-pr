import assert from "node:assert/strict";
import test from "node:test";

import { runPr } from "../tests/test-helpers.mjs";
import {
	apiBase,
	assertSucceeded,
	createRepo,
	validationBuild,
	validationPr,
	webBase,
} from "../tests/pr-cli-helpers.mjs";

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
