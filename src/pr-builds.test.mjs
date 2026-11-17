import assert from "node:assert/strict";
import test from "node:test";

import { runPr, startPr } from "../tests/test-helpers.mjs";
import {
	apiBase,
	assertSucceeded,
	createRepo,
	request,
	validationBuild,
	validationPr,
} from "../tests/pr-cli-helpers.mjs";

const buildApiBase =
	"https://dev.azure.com/acme/Test%20Project/_apis/build/builds";

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
			currentHeadCommit: null,
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
			{ json: { value: [validationPr({ pullRequestId: 55 })] } },
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
		{
			url: `${apiBase}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Frelease%2Fnext&searchCriteria.status=active&api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 702/20260818.1.\nBuild pipeline: Widget CI (9)\nURL: https://dev.azure.com/acme/build/702\n" +
			"Wait with: pr.sh build wait --build 702 --pr 55\n",
	);
});

test("build queue --branch prints no wait line when the branch has no active pull request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--branch", "feature/x", "--definition", "9"],
		{
			cwd,
			responses: [
				{
					json: validationBuild({
						id: 705,
						sourceBranch: "refs/heads/feature/x",
					}),
				},
				{ json: { value: [] } },
			],
		},
	);

	assertSucceeded(result);
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 705/20260818.1.\nBuild pipeline: Widget CI (9)\nURL: https://dev.azure.com/acme/build/700\n" +
			"`build wait` needs a pull request for the branch, and none was found for feature/x.\n",
	);
	assert.doesNotMatch(result.stdout, /Wait with/);
});

test("build queue --branch keeps the queued build output when several pull requests share the branch", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--branch", "feature/x", "--definition", "9"],
		{
			cwd,
			responses: [
				{
					json: validationBuild({
						id: 706,
						sourceBranch: "refs/heads/feature/x",
					}),
				},
				{
					json: {
						value: [
							validationPr({ pullRequestId: 55 }),
							validationPr({ pullRequestId: 56 }),
						],
					},
				},
			],
		},
	);

	assert.equal(result.status, 0);
	assert.match(result.stdout, /^Azure DevOps queued build 706\//);
	assert.doesNotMatch(result.stdout, /Wait with|none was found/);
	assert.match(
		result.stderr,
		/Multiple active pull requests have feature\/x as their source: #55, #56\./,
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
			"Azure DevOps did not return the build ID yet. When `pr.sh build show --latest --pr 42` shows a new build ID, run `pr.sh build wait --build <id> --pr 42`.\n",
	);
	assert.equal(result.status, 0);
});

test("build queue --pr reports a null build ID in the requeued evaluation context as not known yet", (t) => {
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
			{
				json: {
					evaluationId: "evaluation-id",
					status: "queued",
					context: { buildId: null },
				},
			},
		],
	});

	assertSucceeded(result);
	assert.equal(result.calls[2].method, "PATCH");
	assert.equal(
		result.stdout,
		"Requeued build policy evaluation evaluation-id for PR #42.\n" +
			"Azure DevOps did not return the build ID yet. When `pr.sh build show --latest --pr 42` shows a new build ID, run `pr.sh build wait --build <id> --pr 42`.\n",
	);
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
		"Azure DevOps queued build 701/20260818.1.\nBuild pipeline: Widget CI (9)\nURL: https://dev.azure.com/acme/build/701\n" +
			"Wait with: pr.sh build wait --build 701 --pr 42\n",
	);
});

const buildPolicyTypeId = "0609b952-1397-4640-95ec-e00a01b2c241";

function queueEvaluations(...evaluations) {
	return {
		json: {
			value: evaluations.map(([evaluationId, definitionId]) => ({
				evaluationId,
				configuration: {
					name: `Pipeline ${definitionId}`,
					type: { id: buildPolicyTypeId },
					settings: { buildDefinitionId: definitionId },
				},
			})),
		},
	};
}

const queuePr = () =>
	validationPr({
		repository: {
			id: "repo-id",
			name: "widgets",
			project: { id: "project-id" },
		},
		lastMergeSourceCommit: { commitId: "head-1" },
	});

test("build queue --pr --definition requeues the evaluation for that pipeline and prints the wait line", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--pr", "42", "--definition", "12"],
		{
			cwd,
			responses: [
				{ json: queuePr() },
				queueEvaluations(["first-evaluation", 9], ["second-evaluation", 12]),
				{
					json: {
						evaluationId: "second-evaluation",
						status: "queued",
						context: { buildId: 703 },
					},
				},
				{
					json: validationBuild({
						id: 703,
						_links: { web: { href: "https://dev.azure.com/acme/build/703" } },
					}),
				},
			],
		},
	);

	assertSucceeded(result);
	assert.equal(
		result.calls[2].url,
		"https://dev.azure.com/acme/Test%20Project/_apis/policy/evaluations/second-evaluation?api-version=7.1-preview.1",
	);
	assert.equal(result.calls[2].method, "PATCH");
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 703/20260818.1.\nBuild pipeline: Widget CI (9)\nURL: https://dev.azure.com/acme/build/703\n" +
			"Wait with: pr.sh build wait --build 703 --pr 42\n",
	);
});

test("build queue --pr --definition fails with the candidates and queues nothing when no evaluation matches", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--pr", "42", "--definition", "77"],
		{
			cwd,
			responses: [
				{ json: queuePr() },
				queueEvaluations(["first-evaluation", 9], ["second-evaluation", 12]),
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		"No build policy evaluation for build pipeline (definition) 77 was found for PR #42. Candidates: evaluation first-evaluation (Pipeline 9), build pipeline 9; evaluation second-evaluation (Pipeline 12), build pipeline 12.\n",
	);
	assert.deepEqual(
		result.calls.map(({ method }) => method),
		["GET", "GET"],
	);
});

test("build queue --branch --definition queues that pipeline when the repository has build policies", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--branch", "feature/x", "--definition", "21"],
		{
			cwd,
			responses: [
				{
					json: validationBuild({
						id: 704,
						sourceBranch: "refs/heads/feature/x",
						definition: { id: 21, name: "Other Repo CI" },
						_links: { web: { href: "https://dev.azure.com/acme/build/704" } },
					}),
				},
				{ json: { value: [validationPr({ pullRequestId: 55 })] } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${buildApiBase}?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				definition: { id: 21 },
				sourceBranch: "refs/heads/feature/x",
			}),
		},
		{
			url: `${apiBase}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fx&searchCriteria.status=active&api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		"Azure DevOps queued build 704/20260818.1.\nBuild pipeline: Other Repo CI (21)\nURL: https://dev.azure.com/acme/build/704\n" +
			"Wait with: pr.sh build wait --build 704 --pr 55\n",
	);
});

test("build queue --branch without --definition points to it when the repository has no build policy", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["build", "queue", "--branch", "feature/x"], {
		cwd,
		responses: [{ json: { id: "repo-id" } }, { json: { value: [] } }],
	});

	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/No build policy was found.*Pass --definition <id>/,
	);
	assert.equal(result.calls.length, 2);
});

test("build queue names the Build (Read & execute) scope on 403", (t) => {
	const cwd = createRepo(t);
	const forbidden = { status: 403, statusText: "Forbidden", body: "denied" };

	const branch = runPr(
		t,
		["build", "queue", "--branch", "main", "--definition", "9"],
		{
			cwd,
			responses: [forbidden],
		},
	);
	assert.equal(branch.status, 1);
	assert.match(
		branch.stderr,
		/rejected with HTTP 403; Azure DevOps took no action\. The PAT needs the Build \(Read & execute\) scope, also named vso\.build_execute, and the account needs permission to queue builds for that build pipeline\.\n/,
	);
	assert.doesNotMatch(branch.stderr, /unverified/);

	const pr = runPr(t, ["build", "queue", "--pr", "42"], {
		cwd,
		responses: [
			{ json: queuePr() },
			queueEvaluations(["evaluation-id", 9]),
			forbidden,
		],
	});
	assert.equal(pr.status, 1);
	assert.match(
		pr.stderr,
		/rejected with HTTP 403; Azure DevOps took no action\. The PAT needs the Build \(Read & execute\) scope/,
	);
	assert.match(
		pr.stderr,
		/Requeueing a policy evaluation may need more than that; this is unverified\./,
	);
});

test("build queue --branch --definition reports a nonexistent build pipeline as rejected, not uncertain", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["build", "queue", "--branch", "main", "--definition", "999"],
		{
			cwd,
			responses: [
				{ status: 404, statusText: "Not Found", body: "definition not found" },
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^Queue request for build pipeline 999 on refs\/heads\/main was rejected with HTTP 404; Azure DevOps took no action\.\n/,
	);
	assert.doesNotMatch(result.stderr, /uncertain|vso\.build_execute/);
});

test("build retry names the Build (Read & execute) scope on 401", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["build", "retry", "--build", "700", "--pr", "42"], {
		cwd,
		responses: [
			{ json: validationPr() },
			{ json: validationBuild() },
			{ json: validationPr({ isDraft: false }) },
			{ json: validationBuild() },
			{ status: 401, statusText: "Unauthorized", body: "denied" },
		],
	});

	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/Retry request for build 700 was rejected with HTTP 401; Azure DevOps took no action\. The PAT needs the Build \(Read & execute\) scope/,
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

test("build wait polls exactly PR and build metadata for every terminal outcome, then rereads the PR", (t) => {
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
					{ json: validationPr() },
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
			{
				url: `${apiBase}/pullRequests/42?api-version=7.1`,
				method: "GET",
				body: null,
			},
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
			assert.equal(parsed.validatesHead, true);
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
			assert.match(result.stdout, /\nValidates head: yes\n/);
			assert.equal(result.stdout.split("\n").length, 6);
		}
	}
});

test("build wait reports a finished build that no longer validates the head", (t) => {
	const result = runPr(t, ["build", "wait", "--pr", "42", "--build", "700"], {
		cwd: createRepo(t),
		responses: [
			{ json: validationPr() },
			{ json: validationBuild({ result: "succeeded" }) },
			{ json: validationPr({ lastMergeCommit: { commitId: "merge-2" } }) },
		],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		result.stdout,
		"build 700 for PR #42 finished with outcome succeeded.\n" +
			`${result.stdout.split("\n")[1]}\n` +
			"Association: pr-merge\n" +
			"Validates head: no\n" +
			"This build doesn't validate the current head of the pull request; wait for the build that does with `pr.sh build wait --latest --pr 42`.\n",
	);
	const json = runPr(
		t,
		["build", "wait", "--pr", "42", "--build", "700", "--json"],
		{
			cwd: createRepo(t),
			responses: [
				{ json: validationPr() },
				{ json: validationBuild({ result: "succeeded" }) },
				{ json: validationPr({ lastMergeCommit: { commitId: "merge-2" } }) },
			],
		},
	);
	assert.equal(json.status, 0, json.stderr);
	assert.equal(JSON.parse(json.stdout).validatesHead, false);
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
			assert.equal(output.validatesHead, true);
		} else {
			assert.match(result.stdout, /build 701.*outcome succeeded/);
			assert.match(
				result.stdout,
				/Association: branch-head\nValidates head: yes/,
			);
		}
		assert.equal(result.calls.length, 4);
		assert.equal(result.calls[3].url, `${buildApiBase}/701?api-version=7.1`);
	}
});

test("build wait --latest keeps waiting while no build validates the head", (t) => {
	const result = runPr(
		t,
		[
			"build",
			"wait",
			"--pr=42",
			"--latest",
			"--json",
			"--interval=10",
			"--timeout=10",
		],
		{
			cwd: createRepo(t),
			responses: [
				{
					json: validationPr({ lastMergeSourceCommit: { commitId: "head-1" } }),
				},
				{ json: { value: [validationBuild({ sourceVersion: "old-merge" })] } },
				{ json: { value: [] } },
			],
		},
	);
	assert.equal(result.status, 124, result.stderr);
	assert.match(
		result.stderr,
		/PR #42: no build validates head head-1 yet; waiting for one\./,
	);
	const output = JSON.parse(result.stdout);
	assert.equal(output.outcome, "timeout");
	assert.equal(output.buildId, null);
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
