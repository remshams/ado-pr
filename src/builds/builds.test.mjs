import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { AzureRequestError, createAzureRequester } from "../shared/azure.ts";
import { createBuildService, stripTerminalControls } from "./builds.ts";

const ctx = {
	organization: "test org",
	project: "test/project",
	repository: "checkout-name",
};
const pat = "test-only-fake-pat";
const buildBase =
	"https://dev.azure.com/test%20org/test%2Fproject/_apis/build/builds";

function pullRequest(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Validate widgets",
		status: "active",
		isDraft: false,
		sourceRefName: "refs/heads/feature/widgets",
		repository: { id: "Repo-ID", name: "widgets" },
		lastMergeCommit: { commitId: "ABCDEF123" },
		...overrides,
	};
}

function build(overrides = {}) {
	return {
		id: 700,
		buildNumber: "2026.8.18.1",
		status: "completed",
		result: "failed",
		reason: "pullRequest",
		sourceBranch: "refs/pull/42/merge",
		sourceVersion: "abcdef123",
		queueTime: "2026-08-18T10:00:00Z",
		startTime: "2026-08-18T10:01:00Z",
		finishTime: "2026-08-18T10:04:00Z",
		repository: { id: "repo-id", name: "widgets", type: "TfsGit" },
		definition: { id: 9, name: "Widget CI" },
		_links: { web: { href: "https://dev.azure.com/build/700" } },
		...overrides,
	};
}

function createPullRequestStub(
	resolveValues = [pullRequest()],
	getValues = resolveValues,
) {
	let resolveIndex = 0;
	let getIndex = 0;
	const calls = [];
	return {
		calls,
		service: {
			async resolve(requestedPrId) {
				calls.push({ method: "resolve", requestedPrId });
				const value =
					resolveValues[Math.min(resolveIndex, resolveValues.length - 1)];
				resolveIndex += 1;
				return value;
			},
			async get(prId) {
				calls.push({ method: "get", prId });
				const value = getValues[Math.min(getIndex, getValues.length - 1)];
				getIndex += 1;
				return value;
			},
		},
	};
}

function setup(t, responses, { resolveValues, getValues } = {}) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const pullRequests = createPullRequestStub(resolveValues, getValues);
	const service = createBuildService({
		azure,
		ctx,
		pullRequests: pullRequests.service,
	});
	return { service, calls, pullRequestCalls: pullRequests.calls };
}

function requestShapes(calls) {
	return calls.map(({ url, method, body, headers }) => ({
		url,
		method,
		body,
		headers,
	}));
}

function listUrl(continuation) {
	return (
		`${buildBase}?reasonFilter=pullRequest&branchName=refs%2Fpull%2F42%2Fmerge&` +
		`repositoryId=Repo-ID&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&` +
		(continuation === undefined
			? ""
			: `continuationToken=${encodeURIComponent(continuation)}&`) +
		"api-version=7.1"
	);
}

function showResponses({
	shownBuild = build(),
	records = [],
	logs = [],
	texts = [],
} = {}) {
	return [
		{ json: shownBuild },
		{ json: { id: "timeline", records } },
		{ json: { count: logs.length, value: logs } },
		...texts,
	];
}

function transientError(kind, status, retryAfterMs) {
	return new AzureRequestError(`safe ${kind} failure`, kind, {
		status,
		retryAfterMs,
	});
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createWaitHarness(
	responses,
	{ resolvedPr = pullRequest(), start = 0 } = {},
) {
	const clock = { value: start };
	const calls = [];
	const sleeps = [];
	const pullRequestCalls = [];
	let responseIndex = 0;
	const azure = {
		async request(url, options) {
			calls.push({ url, options, at: clock.value });
			if (responseIndex >= responses.length)
				throw new Error("Unexpected build poll");
			const response = responses[responseIndex++];
			if (typeof response === "function")
				return response({ clock, options, calls });
			if (response instanceof Error) throw response;
			return response;
		},
		async requestWithMetadata() {
			throw new Error("wait must not use requestWithMetadata");
		},
	};
	const pullRequests = {
		async resolve(requestedPrId) {
			pullRequestCalls.push({ method: "resolve", requestedPrId });
			return resolvedPr;
		},
		async get() {
			throw new Error("wait must resolve the PR only once");
		},
	};
	const sleep = async (milliseconds, signal) => {
		if (signal?.aborted) throw new AzureRequestError("sleep aborted", "abort");
		sleeps.push({ at: clock.value, milliseconds });
		clock.value += milliseconds;
	};
	const service = createBuildService({
		azure,
		ctx,
		pullRequests,
		now: () => clock.value,
		sleep,
	});
	return { service, clock, calls, sleeps, pullRequestCalls };
}

describe("build discovery", () => {
	test("lists only current associated builds with exact query semantics and a normalized envelope", async (t) => {
		const current = build();
		const stale = build({ id: 701, sourceVersion: "older" });
		const unrelatedBranch = build({
			id: 702,
			sourceBranch: "refs/pull/99/merge",
		});
		const unrelatedReason = build({ id: 703, reason: "manual" });
		const { service, calls, pullRequestCalls } = setup(t, [
			{
				json: {
					count: 4,
					value: [current, stale, unrelatedBranch, unrelatedReason],
				},
			},
		]);

		const result = await service.list(undefined);

		assert.deepEqual(result, {
			pullRequest: {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: false,
				currentMergeCommit: "ABCDEF123",
			},
			history: false,
			builds: [current],
		});
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: undefined },
			{ method: "get", prId: 42 },
		]);
		assert.deepEqual(requestShapes(calls), [
			{
				url: listUrl(),
				method: "GET",
				headers: { authorization: "<redacted>" },
				body: null,
			},
		]);
	});

	test("history follows and encodes every continuation page while preserving response order", async (t) => {
		const first = build({ id: 702, sourceVersion: "old-two" });
		const second = build({ id: 701, sourceVersion: "old-one" });
		const token = "next/page +?#&=";
		const completed = pullRequest({
			status: "completed",
			lastMergeCommit: undefined,
			isDraft: true,
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: { value: [first] },
					headers: { "x-ms-continuationtoken": token },
				},
				{ json: { value: [second] } },
			],
			{ resolveValues: [completed] },
		);

		const result = await service.list(42, { history: true });

		assert.equal(result.history, true);
		assert.deepEqual(result.builds, [first, second]);
		assert.deepEqual(result.pullRequest, {
			id: 42,
			title: "Validate widgets",
			status: "completed",
			draft: true,
			currentMergeCommit: null,
		});
		assert.deepEqual(
			calls.map(({ url }) => url),
			[listUrl(), listUrl(token)],
		);
	});

	test("rejects a repeated continuation token instead of looping", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "repeat" } },
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "repeat" } },
		]);

		await assert.rejects(service.list(42, { history: true }), {
			message:
				"Azure DevOps build pagination repeated a continuation token; refusing to loop.",
		});
		assert.equal(calls.length, 2);
	});

	test("rejects duplicate builds and oversized continuation tokens", async (t) => {
		const duplicate = setup(t, [
			{
				json: { value: [build()] },
				headers: { "x-ms-continuationtoken": "next" },
			},
			{ json: { value: [build()] } },
		]);
		await assert.rejects(
			duplicate.service.list(42, { history: true }),
			/duplicate build ID 700/,
		);

		const oversized = setup(t, [
			{
				json: { value: [] },
				headers: { "x-ms-continuationtoken": "x".repeat(8_193) },
			},
		]);
		await assert.rejects(
			oversized.service.list(42, { history: true }),
			/oversized continuation token/,
		);
		assert.equal(oversized.calls.length, 1);
	});

	test("rejects a current-list result if the PR changes during pagination", async (t) => {
		const changedCommit = setup(t, [{ json: { value: [build()] } }], {
			getValues: [pullRequest({ lastMergeCommit: { commitId: "new-merge" } })],
		});
		await assert.rejects(
			changedCommit.service.list(42),
			/changed while current builds were being listed/,
		);

		const changedStatus = setup(t, [{ json: { value: [build()] } }], {
			getValues: [pullRequest({ status: "completed" })],
		});
		await assert.rejects(
			changedStatus.service.list(42),
			/only active pull requests are eligible/,
		);
	});

	test("current listing rejects inactive and merge-less PRs before the Build API", async (t) => {
		const inactive = setup(t, [], {
			resolveValues: [pullRequest({ status: "abandoned" })],
		});
		await assert.rejects(
			inactive.service.list(42),
			/only active pull requests are eligible/,
		);
		assert.deepEqual(inactive.calls, []);

		const missingCommit = setup(t, [], {
			resolveValues: [pullRequest({ lastMergeCommit: undefined })],
		});
		await assert.rejects(
			missingCommit.service.list(42),
			/no lastMergeCommit\.commitId.*current merge version will not be guessed/,
		);
		assert.deepEqual(missingCommit.calls, []);
	});

	test("fails on malformed association-critical PR and Build list data", async (t) => {
		const malformedPr = setup(t, [], {
			resolveValues: [pullRequest({ repository: { name: "widgets" } })],
		});
		await assert.rejects(
			malformedPr.service.list(42),
			/pull request\.repository\.id/,
		);

		const malformedEnvelope = setup(t, [{ json: { value: {} } }]);
		await assert.rejects(
			malformedEnvelope.service.list(42),
			/build list response\.value must be an array/,
		);

		const malformedBuild = setup(t, [
			{ json: { value: [build({ sourceVersion: undefined })] } },
		]);
		await assert.rejects(
			malformedBuild.service.list(42),
			/sourceVersion must be a non-empty string/,
		);
	});

	test("formats deterministic current/history rows and explicit empty results", async (t) => {
		const historical = build({
			id: 699,
			sourceVersion: "older",
			status: "inProgress",
			result: undefined,
		});
		const { service } = setup(t, [{ json: { value: [build(), historical] } }]);
		const result = await service.list(42, { history: true });

		assert.equal(
			service.formatList(result),
			"Builds for PR #42: Validate widgets (history)\n\n" +
				"- Build 700/2026.8.18.1 — Widget CI\n" +
				"  Association: pr-merge\n  Status/result: completed/failed [current]\n" +
				"  Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z\n" +
				"  https://dev.azure.com/build/700\n\n" +
				"- Build 699/2026.8.18.1 — Widget CI\n" +
				"  Association: pr-merge\n  Status/result: inProgress/unknown [history]\n" +
				"  Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z\n" +
				"  https://dev.azure.com/build/700",
		);

		assert.equal(
			service.formatList({ ...result, history: false, builds: [] }),
			"No associated current merge version builds found for PR #42.",
		);
	});
});

describe("build diagnosis", () => {
	test("shows a historical build, orders its graph, expands every problem result, and deduplicates logs", async (t) => {
		const sharedLog = { id: 17, type: "Container", lineCount: 450 };
		const records = [
			{
				id: "task-b",
				parentId: "job",
				type: "Task",
				name: "Tests",
				order: 2,
				state: "completed",
				result: "failed",
				attempt: 1,
				issues: [{ type: "error", category: "test", message: "2 failed" }],
				log: { id: 17 },
			},
			{
				id: "stage",
				type: "Stage",
				name: "Validate",
				order: 1,
				state: "completed",
				result: "succeeded",
				attempt: 1,
			},
			{
				id: "task-a",
				parentId: "job",
				type: "Task",
				name: "Compile",
				order: 1,
				state: "completed",
				result: "succeededWithIssues",
				attempt: 2,
				issues: [{ type: "warning", message: "types" }],
				log: { id: 17 },
			},
			{
				id: "job",
				parentId: "stage",
				type: "Job",
				name: "Linux",
				order: 1,
				state: "completed",
				result: "failed",
				attempt: 1,
			},
			{
				id: "canceled",
				type: "Task",
				name: "Cleanup",
				order: 3,
				state: "completed",
				result: "canceled",
				attempt: 1,
			},
			{
				id: "abandoned",
				type: "Task",
				name: "Publish",
				order: 4,
				state: "completed",
				result: "abandoned",
				attempt: 1,
			},
			{
				id: "success",
				type: "Task",
				name: "Skipped expansion",
				order: 5,
				state: "completed",
				result: "succeeded",
				attempt: 1,
				log: { id: 99 },
			},
		];
		const oldBuild = build({ sourceVersion: "old-version" });
		const { service, calls } = setup(
			t,
			showResponses({
				shownBuild: oldBuild,
				records,
				logs: [sharedLog],
				texts: [{ body: "\u001b[31merror\u001b[0m\nordinary\tline\n" }],
			}),
			{ resolveValues: [pullRequest({ status: "completed" })] },
		);

		const result = await service.show(42, 700);

		assert.equal(result.current, false);
		assert.deepEqual(result.build, oldBuild);
		assert.deepEqual(result.timeline, { id: "timeline", records });
		assert.equal(result.problemRecords.length, 5);
		assert.deepEqual(
			result.problemRecords.map((entry) => entry.record.id),
			["job", "task-a", "task-b", "canceled", "abandoned"],
		);
		assert.equal(
			result.problemRecords[1].logText,
			"\u001b[31merror\u001b[0m\nordinary\tline\n",
		);
		assert.deepEqual(result.problemRecords[1].logRange, {
			startLine: 250,
			endLine: 450,
		});
		assert.equal(
			result.problemRecords[2].logText,
			result.problemRecords[1].logText,
		);
		assert.equal(result.problemRecords[0].noLog, true);
		assert.equal(result.problemRecords[3].noLog, true);
		assert.equal(result.problemRecords[4].noLog, true);
		assert.equal(service.hasLogErrors(result), false);
		assert.deepEqual(
			calls.map(({ url }) => url),
			[
				`${buildBase}/700?api-version=7.1`,
				`${buildBase}/700/timeline?api-version=7.1`,
				`${buildBase}/700/logs?api-version=7.1`,
				`${buildBase}/700/logs/17?startLine=250&endLine=450&api-version=7.1`,
			],
		);
		assert.equal(calls[3].headers.accept, "text/plain");

		const human = service.formatShow(result);
		assert.match(human, /PR: #42 \(history; stale\)/);
		assert.match(
			human,
			/- Stage\/Validate:[\s\S]* {2}- Job\/Linux:[\s\S]* {4}- Task\/Compile/,
		);
		assert.match(human, /Problem 1: Job\/Linux \[failed\]/);
		assert.match(human, /error\nordinary\tline/);
		assert.doesNotMatch(human, /\u001b/);
	});

	test("a matching build on a completed PR is still classified as historical", async (t) => {
		const completed = pullRequest({ status: "completed" });
		const { service } = setup(t, showResponses(), {
			resolveValues: [completed],
		});
		const result = await service.show(42, 700);
		assert.equal(result.current, false);
		assert.match(service.formatShow(result), /PR: #42 \(history; stale\)/);
	});

	test("full logs omit bounds and lineCount while retaining raw JSON-compatible text", async (t) => {
		const records = [
			{
				id: "problem",
				type: "Task",
				name: "Lint",
				result: "failed",
				log: { id: 2 },
			},
		];
		const { service, calls } = setup(
			t,
			showResponses({
				records,
				logs: [{ id: 2, type: "Container" }],
				texts: [{ body: "top\n\u001b]0;hostile\u0007bottom\n" }],
			}),
		);

		const result = await service.show(undefined, 700, { fullLogs: true });

		assert.equal(result.problemRecords[0].logMode, "full");
		assert.equal(result.problemRecords[0].logRange, null);
		assert.equal(
			result.problemRecords[0].logText,
			"top\n\u001b]0;hostile\u0007bottom\n",
		);
		assert.equal(calls[3].url, `${buildBase}/700/logs/2?api-version=7.1`);
		assert.match(
			service.formatShow(result),
			/FULL LOGS; potentially sensitive/,
		);
		assert.doesNotMatch(service.formatShow(result), /hostile/);
	});

	test("requests exact 200-line boundaries and represents a metadata-proven empty log without downloading", async (t) => {
		const records = [
			{ id: "short", result: "failed", log: { id: 1 } },
			{ id: "boundary", result: "failed", log: { id: 2 } },
			{ id: "long", result: "failed", log: { id: 3 } },
			{ id: "empty", result: "failed", log: { id: 4 } },
		];
		const { service, calls } = setup(
			t,
			showResponses({
				records,
				logs: [
					{ id: 1, lineCount: 199 },
					{ id: 2, lineCount: 200 },
					{ id: 3, lineCount: 201 },
					{ id: 4, lineCount: 0 },
				],
				texts: [{ body: "short" }, { body: "boundary" }, { body: "long" }],
			}),
		);

		const result = await service.show(42, 700);

		assert.deepEqual(
			result.problemRecords.map(({ logRange }) => logRange),
			[
				{ startLine: 0, endLine: 199 },
				{ startLine: 0, endLine: 200 },
				{ startLine: 1, endLine: 201 },
				{ startLine: 0, endLine: 0 },
			],
		);
		assert.equal(result.problemRecords[3].logText, "");
		assert.deepEqual(
			calls.slice(3).map(({ url }) => url),
			[
				`${buildBase}/700/logs/1?startLine=0&endLine=199&api-version=7.1`,
				`${buildBase}/700/logs/2?startLine=0&endLine=200&api-version=7.1`,
				`${buildBase}/700/logs/3?startLine=1&endLine=201&api-version=7.1`,
			],
		);
	});

	test("locally enforces the final-200-line and default byte limits", async (t) => {
		const records = [
			{
				id: "problem",
				type: "Task",
				name: "Lint",
				result: "failed",
				log: { id: 5 },
			},
		];
		const serverIgnoredRange = setup(
			t,
			showResponses({
				records,
				logs: [{ id: 5, lineCount: 300 }],
				texts: [
					{
						body: `${Array.from({ length: 250 }, (_value, index) => `line-${index}`).join("\n")}\n`,
					},
				],
			}),
		);
		const result = await serverIgnoredRange.service.show(42, 700);
		const lines = result.problemRecords[0].logText.trimEnd().split("\n");
		assert.equal(lines.length, 200);
		assert.equal(lines[0], "line-50");
		assert.equal(lines.at(-1), "line-249");

		const oversized = setup(
			t,
			showResponses({
				records,
				logs: [{ id: 5, lineCount: 1 }],
				texts: [{ body: "x".repeat(2 * 1024 * 1024 + 1) }],
			}),
		);
		const partial = await oversized.service.show(42, 700);
		assert.equal(oversized.service.hasLogErrors(partial), true);
		assert.match(
			partial.problemRecords[0].logError,
			/response body exceeded 2097152 bytes/,
		);
	});

	test("continues after unique log failures, shares errors, and sanitizes terminal controls", async (t) => {
		const records = [
			{
				id: "one",
				type: "Task",
				name: "One",
				result: "failed",
				log: { id: 1 },
			},
			{
				id: "shared",
				type: "Task",
				name: "Shared",
				result: "failed",
				log: { id: 1 },
			},
			{
				id: "two",
				type: "Task",
				name: "Two",
				result: "failed",
				log: { id: 2 },
			},
		];
		const { service, calls } = setup(
			t,
			showResponses({
				records,
				logs: [
					{ id: 1, lineCount: 3 },
					{ id: 2, lineCount: 2 },
				],
				texts: [
					{
						status: 503,
						statusText: "Unavailable",
						body: "\u001b[31mbad\u001b[0m",
					},
					{ body: "second log" },
				],
			}),
		);

		const result = await service.show(42, 700);

		assert.equal(calls.length, 5);
		assert.equal(service.hasLogErrors(result), true);
		assert.equal(result.problemRecords[0].logError.includes("\u001b"), false);
		assert.match(result.problemRecords[0].logError, /bad/);
		assert.equal(
			result.problemRecords[1].logError,
			result.problemRecords[0].logError,
		);
		assert.equal(result.problemRecords[2].logText, "second log");
	});

	test("fails before log text on unrelated builds, malformed timelines, missing metadata, and unbounded defaults", async (t) => {
		const unrelated = setup(t, [
			{ json: build({ repository: { id: "other", type: "TfsGit" } }) },
		]);
		await assert.rejects(
			unrelated.service.show(42, 700),
			/not associated.*repository ID/,
		);
		assert.equal(unrelated.calls.length, 1);

		const malformedTimeline = setup(t, [
			{ json: build() },
			{ json: { records: {} } },
		]);
		await assert.rejects(
			malformedTimeline.service.show(42, 700),
			/timeline\.records must be an array/,
		);
		assert.equal(malformedTimeline.calls.length, 2);

		const missingMetadata = setup(
			t,
			showResponses({
				records: [{ id: "p", result: "failed", log: { id: 9 } }],
				logs: [],
			}),
		);
		await assert.rejects(
			missingMetadata.service.show(42, 700),
			/references log 9.*did not contain it/,
		);
		assert.equal(missingMetadata.calls.length, 3);

		const noLineCount = setup(
			t,
			showResponses({
				records: [{ id: "p", result: "failed", log: { id: 9 } }],
				logs: [{ id: 9 }],
			}),
		);
		await assert.rejects(
			noLineCount.service.show(42, 700),
			/no lineCount metadata.*unbounded log/,
		);
		assert.equal(noLineCount.calls.length, 3);
	});

	test("timeline formatting is deterministic, includes orphan/cycle records once, and strips controls", async (t) => {
		const records = [
			{
				id: "root",
				parentId: null,
				type: "Stage",
				name: "Root",
				order: 0,
				result: "succeeded",
			},
			{
				id: "root-child",
				parentId: "ROOT",
				type: "Job",
				name: "Root Child",
				order: 1,
				result: "succeeded",
			},
			{
				id: "orphan",
				parentId: "missing",
				type: "Task",
				name: "\u001b[31mOrphan\u001b[0m",
				order: 2,
				result: "succeeded",
			},
			{
				id: "a",
				parentId: "B",
				type: "Stage",
				name: "A",
				order: 1,
				result: "succeeded",
			},
			{
				id: "b",
				parentId: "a",
				type: "Job",
				name: "B",
				order: 1,
				result: "succeeded",
			},
		];
		const { service } = setup(t, showResponses({ records }));
		const result = await service.show(42, 700);
		const human = service.formatShow(result);

		assert.equal((human.match(/Stage\/Root/g) ?? []).length, 1);
		assert.equal((human.match(/Job\/Root Child/g) ?? []).length, 1);
		assert.equal((human.match(/Stage\/A/g) ?? []).length, 1);
		assert.equal((human.match(/Job\/B/g) ?? []).length, 1);
		assert.equal((human.match(/Task\/Orphan/g) ?? []).length, 1);
		assert.match(human, /orphan parent missing/);
		assert.match(human, /cycle/);
		assert.equal(
			stripTerminalControls("a\u001b[2Jb\u0000c\rrewrite\r\nnext\t\nd\u202E"),
			"abcrewrite\nnext\t\nd",
		);
	});

	test("preserves text between ST-terminated and BEL-terminated OSC sequences", () => {
		assert.equal(
			stripTerminalControls(
				"before\u001b]0;first\u001b\\between\u001b]0;second\u0007after",
			),
			"beforebetweenafter",
		);
	});

	test("formats a deep timeline iteratively with bounded indentation", async (t) => {
		const records = Array.from({ length: 10_000 }, (_value, index) => ({
			id: `node-${index}`,
			parentId: index === 0 ? null : `NODE-${index - 1}`,
			type: "Task",
			name: `Node ${index}`,
			order: index,
			result: "succeeded",
		}));
		const { service } = setup(t, showResponses({ records }));
		const result = await service.show(42, 700);
		const human = service.formatShow(result);
		assert.equal((human.match(/Task\/Node/g) ?? []).length, records.length);
		assert.match(human, /\[depth 9999\]/);
	});
});

describe("safe build retry", () => {
	for (const retryableResult of ["failed", "partiallySucceeded", "canceled"]) {
		test(`double-validates and sends the exact documented PATCH for ${retryableResult}`, async (t) => {
			const initial = build({ result: retryableResult });
			const refreshed = build({ result: retryableResult.toUpperCase() });
			const returned = build({
				id: 701,
				buildNumber: "2026.8.18.2",
				status: "inProgress",
				_links: { web: { href: "https://dev.azure.com/build/701" } },
			});
			delete returned.result;
			const { service, calls, pullRequestCalls } = setup(
				t,
				[{ json: initial }, { json: refreshed }, { json: returned }],
				{
					resolveValues: [pullRequest()],
					getValues: [pullRequest({ isDraft: true })],
				},
			);

			const result = await service.retry(undefined, 700);

			assert.deepEqual(result, returned);
			assert.deepEqual(pullRequestCalls, [
				{ method: "resolve", requestedPrId: undefined },
				{ method: "get", prId: 42 },
			]);
			assert.deepEqual(
				calls.map(({ url, method, body }) => ({ url, method, body })),
				[
					{
						url: `${buildBase}/700?api-version=7.1`,
						method: "GET",
						body: null,
					},
					{
						url: `${buildBase}/700?api-version=7.1`,
						method: "GET",
						body: null,
					},
					{
						url: `${buildBase}/700?retry=true&api-version=7.1`,
						method: "PATCH",
						body: JSON.stringify({ id: 700 }),
					},
				],
			);
			assert.equal(
				service.formatRetry(result),
				"Azure DevOps accepted the retry request for build 701/2026.8.18.2.\n" +
					"Association: pr-merge\nReturned status/result: inProgress/unknown\n" +
					"URL: https://dev.azure.com/build/701",
			);
		});
	}

	test("rejects every ineligible initial state without a refresh or PATCH", async (t) => {
		const cases = [
			[
				"successful",
				pullRequest(),
				build({ result: "succeeded" }),
				/only failed, partiallySucceeded, or canceled/,
			],
			[
				"partially successful spelling outside the documented enum",
				pullRequest(),
				build({ result: "succeededWithIssues" }),
				/only failed, partiallySucceeded, or canceled/,
			],
			[
				"abandoned result",
				pullRequest(),
				build({ result: "abandoned" }),
				/only failed, partiallySucceeded, or canceled/,
			],
			[
				"queued",
				pullRequest(),
				build({ status: "notStarted", result: null }),
				/must be completed/,
			],
			[
				"running",
				pullRequest(),
				build({ status: "inProgress" }),
				/must be completed/,
			],
			[
				"cancelling",
				pullRequest(),
				build({ status: "cancelling", result: "canceled" }),
				/must be completed/,
			],
			[
				"missing status",
				pullRequest(),
				build({ status: null }),
				/has no status/,
			],
			[
				"missing result",
				pullRequest(),
				build({ result: null }),
				/has no result/,
			],
			["stale", pullRequest(), build({ sourceVersion: "old" }), /historical/],
			[
				"unrelated",
				pullRequest(),
				build({ sourceBranch: "refs/pull/9/merge" }),
				/not associated/,
			],
			[
				"completed PR",
				pullRequest({ status: "completed" }),
				build(),
				/only active pull requests/,
			],
			[
				"abandoned PR",
				pullRequest({ status: "abandoned" }),
				build(),
				/only active pull requests/,
			],
			[
				"missing merge",
				pullRequest({ lastMergeCommit: undefined }),
				build(),
				/no lastMergeCommit/,
			],
		];

		for (const [name, pr, candidate, expected] of cases) {
			await t.test(name, async (t) => {
				const { service, calls, pullRequestCalls } = setup(
					t,
					[{ json: candidate }],
					{
						resolveValues: [pr],
					},
				);
				await assert.rejects(service.retry(42, 700), expected);
				assert.equal(calls.length, 1);
				assert.deepEqual(pullRequestCalls, [
					{ method: "resolve", requestedPrId: 42 },
				]);
			});
		}
	});

	test("repeats all checks after refresh and never PATCHes changed PR/build state", async (t) => {
		const changedPr = setup(t, [{ json: build() }, { json: build() }], {
			resolveValues: [pullRequest()],
			getValues: [pullRequest({ status: "completed" })],
		});
		await assert.rejects(
			changedPr.service.retry(42, 700),
			/after refresh.*only active/s,
		);
		assert.equal(changedPr.calls.length, 2);

		const changedBuild = setup(
			t,
			[{ json: build() }, { json: build({ status: "inProgress" }) }],
			{
				resolveValues: [pullRequest()],
				getValues: [pullRequest()],
			},
		);
		await assert.rejects(
			changedBuild.service.retry(42, 700),
			/after refresh.*must be completed/s,
		);
		assert.equal(changedBuild.calls.length, 2);
		assert.ok(changedBuild.calls.every(({ method }) => method === "GET"));
	});

	test("treats a stale post-PATCH response as an uncertain outcome", async (t) => {
		const { service, calls } = setup(t, [
			{ json: build() },
			{ json: build() },
			{ json: build({ sourceVersion: "old-version" }) },
		]);

		await assert.rejects(service.retry(42, 700), (error) => {
			assert.match(error.message, /failed after dispatch/);
			assert.match(
				error.message,
				/does not match PR #42's current head or merge commit/,
			);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	test("does not repeat a failed PATCH and gives uncertain-outcome inspection guidance", async (t) => {
		const { service, calls } = setup(t, [
			{ json: build() },
			{ json: build() },
			{ status: 503, statusText: "Service Unavailable", body: "try later" },
		]);

		await assert.rejects(service.retry(42, 700), (error) => {
			assert.match(error.message, /failed after dispatch/);
			assert.match(error.message, /server outcome may be uncertain/);
			assert.match(error.message, /do not retry automatically/);
			assert.match(error.message, /pr\.sh build show --pr 42 --build 700/);
			assert.match(error.message, /pr\.sh build list --pr 42 --history/);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	test("rejects non-positive IDs before any resolution or request", async (t) => {
		const { service, calls, pullRequestCalls } = setup(t, []);
		await assert.rejects(service.show(42, 0), {
			message: "Build ID must be a positive safe integer.",
		});
		await assert.rejects(service.retry(42, -1), {
			message: "Build ID must be a positive safe integer.",
		});
		assert.deepEqual(calls, []);
		assert.deepEqual(pullRequestCalls, []);
	});

	test("rejects invalid requested PR IDs before resolution or Azure calls", async (t) => {
		const operations = [
			(service, prId) => service.list(prId, { history: true }),
			(service, prId) => service.show(prId, 700),
			(service, prId) => service.retry(prId, 700),
			(service, prId) => service.wait(prId, 700),
		];
		for (const prId of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			for (const operation of operations) {
				const { service, calls, pullRequestCalls } = setup(t, []);
				await assert.rejects(operation(service, prId), {
					message: "Pull request ID must be a positive safe integer.",
				});
				assert.deepEqual(calls, []);
				assert.deepEqual(pullRequestCalls, []);
			}
		}
	});
});

describe("deterministic build wait", () => {
	const terminalCases = [
		["succeeded", "succeeded"],
		["failed", "failed"],
		["partiallySucceeded", "partiallySucceeded"],
		["canceled", "canceled"],
		["unknown Azure result", "abandoned", "unknown"],
		["missing Azure result", undefined, "unknown"],
	];
	for (const [name, azureResult, expectedOutcome = name] of terminalCases) {
		test(`maps immediate completed ${name}`, async () => {
			const observed = build({ status: "CoMpLeTeD", result: azureResult });
			const { service, calls, sleeps, pullRequestCalls } = createWaitHarness([
				observed,
			]);

			const result = await service.wait(undefined, 700);

			assert.equal(result.outcome, expectedOutcome);
			assert.equal(result.buildId, 700);
			assert.equal(result.timedOut, false);
			assert.equal(result.build, observed);
			assert.equal(result.pollCount, 1);
			assert.equal(result.transientFailureCount, 0);
			assert.equal(result.elapsedSeconds, 0);
			assert.deepEqual(sleeps, []);
			assert.deepEqual(pullRequestCalls, [
				{ method: "resolve", requestedPrId: undefined },
			]);
			assert.equal(calls[0].options.timeoutMs, 30_000);
			assert.equal(calls[0].options.maxResponseBytes, 16 * 1024 * 1024);
		});
	}

	test("allows a historical associated build on a completed PR", async () => {
		const historical = build({
			sourceVersion: "old-merge",
			result: "succeeded",
		});
		const { service, pullRequestCalls } = createWaitHarness([historical], {
			resolvedPr: pullRequest({
				status: "completed",
				lastMergeCommit: undefined,
			}),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.build, historical);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
		]);
	});

	for (const status of [
		"notStarted",
		"inProgress",
		"cancelling",
		"postponed",
	]) {
		test(`accepts ${status} and transitions to terminal without timeline/log calls`, async () => {
			const first = build({ status: status.toUpperCase(), result: undefined });
			const completed = build({ status: "completed", result: "SUCCEEDED" });
			const events = [];
			const { service, calls, sleeps } = createWaitHarness([first, completed]);

			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				onProgress: (event) => events.push(event),
			});

			assert.equal(result.outcome, "succeeded");
			assert.equal(result.pollCount, 2);
			assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
			assert.deepEqual(
				events.map(({ type, change }) => [type, change]),
				[
					["state", "initial"],
					["state", "changed"],
				],
			);
			assert.deepEqual(
				calls.map(({ url }) => url),
				[
					`${buildBase}/700?api-version=7.1`,
					`${buildBase}/700?api-version=7.1`,
				],
			);
			assert.ok(calls.every(({ options }) => options.method === undefined));
		});
	}

	test("uses default interval/timeout and validates inclusive service boundaries", async () => {
		const defaults = createWaitHarness([
			build({ status: "inProgress", result: undefined }),
			build({ result: "succeeded" }),
		]);
		const defaultResult = await defaults.service.wait(42, 700);
		assert.equal(defaultResult.elapsedSeconds, 60);
		assert.deepEqual(defaults.sleeps, [{ at: 0, milliseconds: 60_000 }]);

		const defaultTimeout = createWaitHarness([
			({ clock }) => {
				clock.value += 3_600_000;
				return build({ result: "succeeded" });
			},
		]);
		assert.equal(
			(await defaultTimeout.service.wait(42, 700)).outcome,
			"timeout",
		);

		for (const [intervalSeconds, timeoutSeconds] of [
			[10, 10],
			[3_600, 86_400],
		]) {
			const boundary = createWaitHarness([build({ result: "succeeded" })]);
			assert.equal(
				(
					await boundary.service.wait(42, 700, {
						intervalSeconds,
						timeoutSeconds,
					})
				).outcome,
				"succeeded",
			);
		}

		const invalidId = createWaitHarness([]);
		await assert.rejects(
			invalidId.service.wait(42, 0),
			/positive safe integer/,
		);
		assert.deepEqual(invalidId.pullRequestCalls, []);

		for (const options of [
			{ intervalSeconds: 9 },
			{ intervalSeconds: 3_601 },
			{ intervalSeconds: 10.5 },
			{ timeoutSeconds: 9 },
			{ timeoutSeconds: 86_401 },
			{ timeoutSeconds: 10.5 },
		]) {
			const invalid = createWaitHarness([]);
			await assert.rejects(
				invalid.service.wait(42, 700, options),
				/whole number from/,
			);
			assert.deepEqual(invalid.pullRequestCalls, []);
			assert.deepEqual(invalid.calls, []);
		}
	});

	test("times out with the latest valid build and never polls at the deadline", async () => {
		const observed = build({ status: "inProgress", result: undefined });
		const { service, calls, sleeps } = createWaitHarness([observed]);

		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});

		assert.deepEqual(result, {
			pullRequest: {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: false,
				currentMergeCommit: "ABCDEF123",
			},
			buildId: 700,
			build: observed,
			association: "pr-merge",
			pollCount: 1,
			transientFailureCount: 0,
			elapsedSeconds: 10,
			timedOut: true,
			outcome: "timeout",
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
	});

	test("times out with no observation before the third transient failure", async () => {
		const { service, calls } = createWaitHarness([transientError("network")]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});
		assert.equal(result.buildId, 700);
		assert.equal(result.build, null);
		assert.equal(result.association, null);
		assert.equal(result.outcome, "timeout");
		assert.equal(result.pollCount, 1);
		assert.equal(result.transientFailureCount, 1);
		assert.equal(calls.length, 1);
	});

	test("treats a completion response received after the deadline as timeout", async () => {
		const { service, calls } = createWaitHarness([
			({ clock }) => {
				clock.value += 10_001;
				return build({ result: "succeeded" });
			},
		]);
		const result = await service.wait(42, 700, { timeoutSeconds: 10 });
		assert.equal(result.outcome, "timeout");
		assert.equal(result.buildId, 700);
		assert.equal(result.build, null);
		assert.equal(result.pollCount, 1);
		assert.equal(result.transientFailureCount, 0);
		assert.equal(calls[0].options.timeoutMs, 10_000);
	});

	test("counts a transient completing exactly at the deadline and lets timeout win", async () => {
		for (const attemptCount of [1, 2, 3]) {
			const warnings = [];
			const responses = Array.from({ length: attemptCount }, (_value, index) =>
				index === attemptCount - 1
					? ({ clock }) => {
							clock.value += 10_000;
							throw transientError("network");
						}
					: transientError("network"),
			);
			const { service, calls } = createWaitHarness(responses);
			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: attemptCount * 10,
				onProgress(event) {
					if (event.type === "transient-warning") warnings.push(event);
				},
			});
			assert.equal(result.outcome, "timeout");
			assert.equal(result.pollCount, attemptCount);
			assert.equal(result.transientFailureCount, attemptCount);
			assert.equal(calls.length, attemptCount);
			assert.equal(warnings.length, attemptCount - 1);
		}
	});

	test("ceil-clamps a fractional remaining request budget to one millisecond", async () => {
		let nowCallCount = 0;
		let requestTimeoutMs;
		const azure = {
			async request(_url, options) {
				requestTimeoutMs = options.timeoutMs;
				return build({ result: "succeeded" });
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => (nowCallCount++ === 0 ? 0 : 9_999.5),
		});

		const result = await service.wait(42, 700, { timeoutSeconds: 10 });

		assert.equal(requestTimeoutMs, 1);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.elapsedSeconds, 9.9995);
	});

	test("counts attempts, keeps cumulative failures, and resets the consecutive count after an observation", async () => {
		const warningEvents = [];
		const errors = Array.from({ length: 4 }, () => transientError("network"));
		const { service } = createWaitHarness([
			errors[0],
			errors[1],
			build({ status: "inProgress", result: undefined }),
			errors[2],
			errors[3],
			build({ result: "succeeded" }),
		]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 100,
			onProgress(event) {
				if (event.type === "transient-warning") warningEvents.push(event);
			},
		});
		assert.equal(result.pollCount, 6);
		assert.equal(result.transientFailureCount, 4);
		assert.deepEqual(
			warningEvents.map(({ attempt, consecutiveFailureCount }) => [
				attempt,
				consecutiveFailureCount,
			]),
			[
				[1, 1],
				[2, 2],
				[4, 1],
				[5, 2],
			],
		);
	});

	test("throws a sanitized operational error on the third consecutive transient failure", async () => {
		const hostile = new AzureRequestError(
			"bad\u001b[31m\u202E detail",
			"network",
		);
		const warnings = [];
		const { service, calls } = createWaitHarness([hostile, hostile, hostile]);
		await assert.rejects(
			service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 100,
				onProgress: (event) => warnings.push(event),
			}),
			(error) => {
				assert.match(error.message, /stopped after 3 consecutive transient/);
				assert.doesNotMatch(error.message, /\u001b|\u202E/);
				return true;
			},
		);
		assert.equal(calls.length, 3);
		assert.deepEqual(
			warnings.map(({ attempt, consecutiveFailureCount }) => [
				attempt,
				consecutiveFailureCount,
			]),
			[
				[1, 1],
				[2, 2],
				[3, 3],
			],
		);
	});

	test("classifies network, timeout, 408, 429, and 5xx errors as transient", async () => {
		const cases = [
			transientError("network"),
			transientError("timeout"),
			transientError("http", 408),
			transientError("http", 429),
			transientError("http", 500),
			transientError("http", 503),
			transientError("http", 599),
		];
		for (const candidate of cases) {
			const { service } = createWaitHarness([
				candidate,
				build({ result: "succeeded" }),
			]);
			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 30,
			});
			assert.equal(result.outcome, "succeeded");
			assert.equal(result.transientFailureCount, 1);
			assert.equal(result.pollCount, 2);
		}
	});

	test("fails immediately for non-transient HTTP and response errors", async () => {
		for (const candidate of [
			transientError("http", 401),
			transientError("http", 403),
			transientError("http", 404),
			transientError("response"),
		]) {
			const { service, calls, sleeps } = createWaitHarness([candidate]);
			await assert.rejects(
				service.wait(42, 700),
				(error) => error === candidate,
			);
			assert.equal(calls.length, 1);
			assert.deepEqual(sleeps, []);
		}
	});

	test("schedules from attempt completion and honors HTTP Retry-After with five-minute heartbeats", async () => {
		const events = [];
		const scheduling = createWaitHarness([
			({ clock }) => {
				clock.value += 2_000;
				return build({ status: "inProgress", result: undefined });
			},
			build({ result: "succeeded" }),
		]);
		await scheduling.service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 30,
		});
		assert.deepEqual(
			scheduling.calls.map(({ at }) => at),
			[0, 12_000],
		);

		const retryAfter = createWaitHarness([
			transientError("http", 429, 700_000),
			build({ result: "succeeded" }),
		]);
		const result = await retryAfter.service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 1_000,
			onProgress: (event) => events.push(event),
		});
		assert.equal(result.outcome, "succeeded");
		assert.deepEqual(
			retryAfter.calls.map(({ at }) => at),
			[0, 700_000],
		);
		assert.deepEqual(
			retryAfter.sleeps.map(({ milliseconds }) => milliseconds),
			[300_000, 300_000, 100_000],
		);
		assert.equal(events.filter(({ type }) => type === "heartbeat").length, 2);
		assert.equal(
			events.filter(({ type }) => type === "transient-warning")[0].retryAfterMs,
			700_000,
		);
	});

	test("clips a saturated Retry-After sleep and request timeout to the overall deadline", async () => {
		const { service, calls, sleeps } = createWaitHarness([
			transientError("http", 429, Number.MAX_SAFE_INTEGER),
		]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});
		assert.equal(result.outcome, "timeout");
		assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.timeoutMs, 10_000);
	});

	test("cancels promptly during an injected sleep", async () => {
		const controller = new AbortController();
		const sleepStarted = deferred();
		const azure = {
			async request() {
				return build({ status: "inProgress", result: undefined });
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const sleep = () =>
			new Promise(() => {
				sleepStarted.resolve();
			});
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
			sleep,
		});
		const waiting = service.wait(42, 700, {
			intervalSeconds: 10,
			signal: controller.signal,
		});
		await sleepStarted.promise;
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
	});

	test("cancels the active request through the caller signal", async () => {
		const controller = new AbortController();
		const requestStarted = deferred();
		const azure = {
			request(_url, options) {
				requestStarted.resolve();
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => reject(new AzureRequestError("request aborted", "abort")),
						{ once: true },
					);
				});
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
		});
		const waiting = service.wait(42, 700, { signal: controller.signal });
		await requestStarted.promise;
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
	});

	test("does not invoke an injected sleep when abort happens during listener installation", async () => {
		const controller = new AbortController();
		const originalAddEventListener = controller.signal.addEventListener.bind(
			controller.signal,
		);
		controller.signal.addEventListener = (...args) => {
			originalAddEventListener(...args);
			controller.abort();
		};
		let sleepCalls = 0;
		const service = createBuildService({
			azure: {
				async request() {
					return build({ status: "inProgress", result: undefined });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
			sleep: async () => {
				sleepCalls += 1;
			},
		});

		await assert.rejects(
			service.wait(42, 700, { intervalSeconds: 10, signal: controller.signal }),
			(error) => error.kind === "abort",
		);
		assert.equal(sleepCalls, 0);
	});

	test("passes bounded read controls to PR resolution and cancels it promptly", async () => {
		const controller = new AbortController();
		const resolutionStarted = deferred();
		let controls;
		let buildPolls = 0;
		const service = createBuildService({
			azure: {
				async request() {
					buildPolls += 1;
					return build({ result: "succeeded" });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: {
				resolve(_requestedPrId, options) {
					controls = options;
					resolutionStarted.resolve();
					return new Promise((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() =>
								reject(new AzureRequestError("resolution aborted", "abort")),
							{ once: true },
						);
					});
				},
				async get() {
					throw new Error("unexpected");
				},
			},
		});

		const waiting = service.wait(42, 700, { signal: controller.signal });
		await resolutionStarted.promise;
		assert.equal(controls.signal, controller.signal);
		assert.equal(controls.timeoutMs, 30_000);
		assert.equal(controls.maxResponseBytes, 16 * 1024 * 1024);
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
		assert.equal(buildPolls, 0);
	});

	test("snapshots signal and progress callback before resolving the PR", async () => {
		const resolution = deferred();
		const originalController = new AbortController();
		const replacementController = new AbortController();
		replacementController.abort();
		const originalEvents = [];
		const replacementEvents = [];
		const options = {
			signal: originalController.signal,
			onProgress: (event) => originalEvents.push(event),
		};
		const service = createBuildService({
			azure: {
				async request() {
					return build({ result: "succeeded" });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: {
				async resolve() {
					await resolution.promise;
					return pullRequest();
				},
				async get() {
					throw new Error("unexpected");
				},
			},
			now: () => 0,
		});

		const waiting = service.wait(42, 700, options);
		options.signal = replacementController.signal;
		options.onProgress = (event) => replacementEvents.push(event);
		resolution.resolve();
		const result = await waiting;

		assert.equal(result.outcome, "succeeded");
		assert.equal(originalEvents.length, 1);
		assert.equal(replacementEvents.length, 0);
	});

	test("awaits async progress and propagates rejection without an unhandled promise", async () => {
		const callbackStarted = deferred();
		const callbackRelease = deferred();
		const { service } = createWaitHarness([build({ result: "succeeded" })]);
		let settled = false;
		const waiting = service.wait(42, 700, {
			async onProgress() {
				callbackStarted.resolve();
				await callbackRelease.promise;
			},
		});
		void waiting.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await callbackStarted.promise;
		assert.equal(settled, false);
		callbackRelease.resolve();
		assert.equal((await waiting).outcome, "succeeded");

		const rejection = new Error("progress failed");
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const rejected = createWaitHarness([build({ result: "succeeded" })]);
			await assert.rejects(
				rejected.service.wait(42, 700, {
					onProgress: async () => {
						throw rejection;
					},
				}),
				(error) => error === rejection,
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	test("caller abort wins when a progress callback aborts and rejects", async () => {
		const controller = new AbortController();
		const { service } = createWaitHarness([build({ result: "succeeded" })]);
		await assert.rejects(
			service.wait(42, 700, {
				signal: controller.signal,
				async onProgress() {
					controller.abort();
					throw new Error("callback rejection");
				},
			}),
			(error) => error.kind === "abort",
		);
	});

	test("caller abort cancels a pending async progress callback and consumes its late rejection", async () => {
		const controller = new AbortController();
		const callbackStarted = deferred();
		const callbackResult = deferred();
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { service } = createWaitHarness([build({ result: "succeeded" })]);
			const waiting = service.wait(42, 700, {
				signal: controller.signal,
				onProgress() {
					callbackStarted.resolve();
					return callbackResult.promise;
				},
			});
			await callbackStarted.promise;
			controller.abort();
			await assert.rejects(waiting, (error) => error.kind === "abort");
			callbackResult.reject(new Error("late callback rejection"));
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	test("progress receives deep snapshots that cannot mutate wait state or its result", async () => {
		const running = build({ status: "inProgress", result: undefined });
		const completed = build({ status: "completed", result: "succeeded" });
		const seen = [];
		const { service } = createWaitHarness([running, completed]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			onProgress(event) {
				seen.push({
					prId: event.pullRequest.id,
					status: event.build?.status,
					repositoryId: event.build?.repository?.id,
				});
				event.pullRequest.id = 999;
				event.pullRequest.title = "mutated";
				if (event.build !== null) {
					event.build.id = 999;
					event.build.status = "completed";
					event.build.result = "failed";
					event.build.repository.id = "other";
					event.build._links.web.href = "mutated";
				}
			},
		});

		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 700);
		assert.equal(result.pullRequest.id, 42);
		assert.equal(result.pullRequest.title, "Validate widgets");
		assert.equal(result.build.id, 700);
		assert.equal(result.build.result, "succeeded");
		assert.equal(result.build.repository.id, "repo-id");
		assert.equal(
			result.build._links.web.href,
			"https://dev.azure.com/build/700",
		);
		assert.deepEqual(seen, [
			{ prId: 42, status: "inProgress", repositoryId: "repo-id" },
			{ prId: 42, status: "completed", repositoryId: "repo-id" },
		]);
		assert.equal(running.id, 700);
		assert.equal(completed.id, 700);
	});

	test("bounds sanitized transient error text in warnings and operational errors", async () => {
		const hostile = new AzureRequestError(
			`bad\u001b[31m\u202E${"x".repeat(20_000)}`,
			"network",
		);
		const warnings = [];
		const { service } = createWaitHarness([hostile, hostile, hostile]);
		await assert.rejects(
			service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 100,
				onProgress(event) {
					if (event.type === "transient-warning") warnings.push(event);
				},
			}),
			(error) => {
				assert.doesNotMatch(error.message, /\u001b|\u202E/);
				assert.ok(error.message.length < 4_300);
				assert.match(error.message, /\[truncated\]$/);
				return true;
			},
		);
		assert.equal(warnings.length, 3);
		assert.ok(warnings.every(({ error }) => error.length <= 4_096));
		assert.ok(warnings.every(({ error }) => !/\u001b|\u202E/.test(error)));
	});

	test("rejects wrong IDs, association changes, and missing/none/unknown statuses immediately", async () => {
		const changedAssociation = createWaitHarness([
			build({ status: "inProgress", result: undefined }),
			build({ repository: { id: "other", type: "TfsGit" } }),
		]);
		await assert.rejects(
			changedAssociation.service.wait(42, 700, { intervalSeconds: 10 }),
			/repository ID/,
		);
		assert.equal(changedAssociation.calls.length, 2);

		const cases = [
			[build({ id: 701 }), /expected 700/],
			[build({ repository: { id: "other", type: "TfsGit" } }), /repository ID/],
			[
				build({ repository: { id: "repo-id", type: "GitHub" } }),
				/repository type/,
			],
			[build({ reason: "manual" }), /reason/],
			[build({ sourceBranch: "refs/pull/99/merge" }), /source branch/],
			[build({ status: undefined }), /no build status/],
			[build({ status: null }), /no build status/],
			[build({ status: "none" }), /unknown build status none/],
			[build({ status: "queued" }), /unknown build status queued/],
		];
		for (const [candidate, expected] of cases) {
			const { service, calls } = createWaitHarness([candidate]);
			await assert.rejects(service.wait(42, 700), expected);
			assert.equal(calls.length, 1);
		}
	});

	test("de-duplicates unchanged progress states and sanitizes all human wait text", async () => {
		const events = [];
		const hostilePr = pullRequest({ title: "widgets\u001b[31m\u202E" });
		const { service } = createWaitHarness(
			[
				build({ status: "inProgress", result: undefined }),
				build({ status: "INPROGRESS", result: undefined }),
				build({ status: "postponed", result: "odd\u001b[31m\u202E" }),
				build({ status: "completed", result: "failed\u202E" }),
			],
			{ resolvedPr: hostilePr },
		);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 40,
			onProgress: (event) => events.push(event),
		});
		const states = events.filter(({ type }) => type === "state");
		assert.deepEqual(
			states.map(({ change, status }) => [change, status]),
			[
				["initial", "inProgress"],
				["changed", "postponed"],
				["changed", "completed"],
			],
		);
		const formattedProgress = service.formatWaitProgress({
			...states[1],
			status: "bad\u001b[31m\u202E",
			result: "bad\u001b[0m",
			build: build({ status: "bad\u001b[31m\u202E", result: "bad\u001b[0m" }),
		});
		const formattedResult = service.formatWaitResult(result);
		assert.doesNotMatch(formattedProgress, /\u001b|\u202E/);
		assert.doesNotMatch(formattedResult, /\u001b|\u202E/);
		assert.match(
			formattedProgress,
			/PR #42, build 700.*status|PR #42, build 700.*state/,
		);
		assert.match(formattedResult, /outcome unknown/);

		for (const outcome of [
			"partiallySucceeded",
			"failed",
			"canceled",
			"unknown",
		]) {
			const failureText = service.formatWaitResult({
				...result,
				build: build({ result: outcome }),
				outcome,
			});
			assert.match(failureText, /pr\.sh build show --pr 42 --build 700/);
		}
		const timeoutText = service.formatWaitResult({
			...result,
			build: null,
			timedOut: true,
			outcome: "timeout",
		});
		assert.match(timeoutText, /build 700.*timed out/);
		assert.doesNotMatch(timeoutText, /requested build/);
	});
});

describe("build response validation contracts", () => {
	test("show identifies malformed optional build metadata", async (t) => {
		for (const [overrides, field, expectedType] of [
			[{ definition: [] }, "build.definition", "an object"],
			[
				{ definition: { id: 0 } },
				"build.definition.id",
				"a positive safe integer",
			],
			[
				{ definition: { name: false } },
				"build.definition.name",
				"a non-empty string",
			],
			[{ _links: [] }, "build._links", "an object"],
			[{ _links: { web: null } }, "build._links.web", "an object"],
			[
				{ _links: { web: { href: 4 } } },
				"build._links.web.href",
				"a non-empty string",
			],
			[{ buildNumber: false }, "build.buildNumber", "a non-empty string"],
		]) {
			const { service } = setup(t, [{ json: build(overrides) }]);
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: ${field} must be ${expectedType}.`,
			});
		}
	});

	test("show identifies malformed issue fields before reading logs", async (t) => {
		for (const field of ["type", "category", "message"]) {
			const { service } = setup(t, [
				{ json: build() },
				{
					json: {
						records: [{ id: "task", type: "Task", issues: [{ [field]: 42 }] }],
					},
				},
			]);
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: timeline.records[0].issues[0].${field} must be a non-empty string.`,
			});
		}
	});

	test("show validates log metadata and rejects duplicate IDs", async (t) => {
		for (const [logs, detail] of [
			[
				[{ id: 0 }],
				"build logs response.value[0].id must be a positive safe integer.",
			],
			[
				[{ id: 1, type: 7 }],
				"build logs response.value[0].type must be a non-empty string.",
			],
			[
				[{ id: 1, url: false }],
				"build logs response.value[0].url must be a non-empty string.",
			],
			[
				[{ id: 1, lineCount: -1 }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[
				[{ id: 1, lineCount: 0.5 }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[
				[{ id: 1, lineCount: "2" }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[[{ id: 1 }, { id: 1 }], "duplicate build log ID 1."],
		]) {
			const { service } = setup(t, showResponses({ logs }));
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: ${detail}`,
			});
		}
	});
});

describe("build output contracts", () => {
	test("show prints empty diagnostics and missing build metadata", (t) => {
		const { service } = setup(t, []);
		assert.equal(
			service.formatShow({
				pullRequest: { id: 42 },
				current: false,
				association: "pr-merge",
				build: { id: 700 },
				timeline: { records: [] },
				problemRecords: [],
			}),
			[
				"Build 700/unknown — unknown",
				"PR: #42 (history; stale)",
				"Association: pr-merge; commit: unknown",
				"Status/result: unknown/unknown",
				"Queue/start/finish: unknown / unknown / unknown",
				"URL: unknown",
				"",
				"Timeline:",
				"(no stage/job/task records)",
				"",
				"Problem diagnostics (final 200 lines per log):",
				"(no problem records)",
			].join("\n"),
		);
	});

	test("show separates issue, missing-log, failed-log, and full-log sections", (t) => {
		const { service } = setup(t, []);
		const records = [
			{
				id: "task",
				type: "Task",
				name: "Lint\nchecks\t",
				result: "failed",
				state: "completed",
				attempt: 0,
				order: 2,
			},
			{
				id: "stage",
				type: "Stage",
				name: "Validate",
				result: "failed",
				state: "completed",
				order: 1,
			},
		];
		const result = {
			pullRequest: { id: 42 },
			current: true,
			association: "pr-merge",
			build: build(),
			timeline: { records },
			problemRecords: [
				{
					record: records[0],
					issues: [{ type: "error", category: "lint", message: "Fix imports" }],
					noLog: true,
				},
				{
					record: records[1],
					issues: [],
					logMode: "tail",
					logRange: { startLine: 1, endLine: 3 },
					logError: "unavailable\nnow",
				},
				{
					record: records[0],
					issues: [],
					logMode: "full",
					logText: "before\u001b[31mred\u001b[0mafter",
				},
			],
		};
		assert.equal(service.hasLogErrors(result), true);
		assert.equal(
			service.formatShow(result),
			[
				"Build 700/2026.8.18.1 — Widget CI",
				"PR: #42 (current)",
				"Association: pr-merge; commit: abcdef123",
				"Status/result: completed/failed",
				"Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z",
				"URL: https://dev.azure.com/build/700",
				"",
				"Timeline:",
				"- Stage/Validate: state=completed, result=failed, attempt=unknown",
				"- Task/Lint checks : state=completed, result=failed, attempt=0",
				"",
				"Problem diagnostics (FULL LOGS; potentially sensitive):",
				"Problem 1: Task/Lint checks  [failed]",
				"Issues:",
				"- error/lint: Fix imports",
				"Log: (no log reference)",
				"",
				"Problem 2: Stage/Validate [failed]",
				"Issues: (none)",
				"Log (tail log (lines 1-3)): ERROR: unavailable now",
				"",
				"Problem 3: Task/Lint checks  [failed]",
				"Issues: (none)",
				"Log (full log (potentially sensitive)):",
				"beforeredafter",
			].join("\n"),
		);
	});

	test("retry validates its result and uses explicit unknown values", (t) => {
		const { service } = setup(t, []);
		assert.throws(() => service.formatRetry(build({ id: 0 })), {
			message:
				"Malformed Azure DevOps response: retry result build.id must be a positive safe integer.",
		});
		assert.equal(
			service.formatRetry(
				build({
					definition: null,
					_links: null,
					buildNumber: null,
					result: null,
				}),
			),
			[
				"Azure DevOps accepted the retry request for build 700/unknown.",
				"Association: pr-merge",
				"Returned status/result: completed/unknown",
				"URL: unknown",
			].join("\n"),
		);
	});

	test("wait gives failure inspection guidance only for unsuccessful outcomes", (t) => {
		const { service } = setup(t, []);
		const result = {
			pullRequest: { id: 42 },
			buildId: 700,
			build: { status: "completed", result: "failed" },
			elapsedSeconds: 12.25,
			pollCount: 3,
			transientFailureCount: 1,
			timedOut: false,
			outcome: "failed",
		};
		assert.equal(
			service.formatWaitResult(result),
			"build 700 for PR #42 finished with outcome failed.\nStatus/result: completed/failed; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown\nInspect failure details with `pr.sh build show --pr 42 --build 700`.",
		);
		assert.equal(
			service.formatWaitResult({
				...result,
				outcome: "succeeded",
				build: { status: "completed", result: "succeeded" },
			}),
			"build 700 for PR #42 finished with outcome succeeded.\nStatus/result: completed/succeeded; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown",
		);
		assert.equal(
			service.formatWaitResult({ ...result, timedOut: true, build: null }),
			"build 700 for PR #42 timed out. Latest status/result: unknown/unknown; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown",
		);
		assert.equal(
			service.formatWaitProgress({ ...result, type: "heartbeat", build: null }),
			"PR #42, build 700: still waiting at unknown/unknown; 12.3s elapsed; 3 poll(s); 1 transient failure(s).",
		);
	});
});

describe("head-aware build selection", () => {
	const headPr = () =>
		pullRequest({
			lastMergeSourceCommit: { commitId: "HEAD-1" },
			isDraft: true,
		});
	const branchBuild = (overrides = {}) =>
		build({
			reason: "manual",
			sourceBranch: "refs/heads/feature/widgets",
			sourceVersion: "head-1",
			...overrides,
		});

	test("classifies current and stale merge and source-branch builds", async (t) => {
		for (const [candidate, association, current] of [
			[build(), "pr-merge", true],
			[build({ sourceVersion: "old-merge" }), "pr-merge", false],
			[branchBuild(), "branch-head", true],
			[branchBuild({ sourceVersion: "old-head" }), "branch-head", false],
		]) {
			await t.test(`${association} ${current}`, async (t) => {
				const { service } = setup(t, showResponses({ shownBuild: candidate }), {
					resolveValues: [headPr()],
				});
				const result = await service.show(42, 700);
				assert.equal(result.current, current);
				assert.equal(result.association, association);
				const text = service.formatShow(result);
				assert.ok(
					text.includes(
						`Association: ${association}; commit: ${candidate.sourceVersion}`,
					),
				);
				assert.ok(text.includes(current ? "(current)" : "(history; stale)"));
			});
		}
	});

	test("rejects manual merge-ref runs for show, wait and retry", async (t) => {
		for (const operation of ["show", "wait", "retry"]) {
			await t.test(operation, async (t) => {
				const { service } = setup(t, [{ json: build({ reason: "manual" }) }], {
					resolveValues: [headPr()],
				});
				await assert.rejects(
					service[operation](42, 700),
					/not associated.*reason/,
				);
			});
		}
	});

	test("accepts any reason on the source branch and does not need a merge commit", async (t) => {
		for (const reason of ["manual", "individualCI", "pullRequest"]) {
			await t.test(reason, async (t) => {
				const { service } = setup(
					t,
					showResponses({ shownBuild: branchBuild({ reason }) }),
					{ resolveValues: [{ ...headPr(), lastMergeCommit: undefined }] },
				);
				assert.equal((await service.show(42, 700)).current, true);
			});
		}
	});

	test("missing head metadata never makes a branch build current", async (t) => {
		const { service } = setup(t, showResponses({ shownBuild: branchBuild() }));
		assert.equal((await service.show(42, 700)).current, false);
	});

	test("validates the head commit response shape", async (t) => {
		for (const lastMergeSourceCommit of ["head-1", {}, { commitId: "" }]) {
			const { service } = setup(t, [], {
				resolveValues: [pullRequest({ lastMergeSourceCommit })],
			});
			await assert.rejects(service.show(42, 700), /lastMergeSourceCommit/);
		}
	});

	test("latest chooses by queue time across both build kinds and ignores newer stale runs", async (t) => {
		for (const newestKind of ["pr-merge", "branch-head"]) {
			await t.test(newestKind, async (t) => {
				const merge = build({
					queueTime:
						newestKind === "pr-merge"
							? "2026-08-19T12:00:00Z"
							: "2026-08-17T10:00:00Z",
				});
				const branch = branchBuild({
					id: 701,
					queueTime: "2026-08-18T10:00:00Z",
				});
				const selected = newestKind === "pr-merge" ? merge : branch;
				const { service, calls } = setup(
					t,
					[
						{
							json: {
								value: [
									build({
										id: 702,
										sourceVersion: "stale",
										queueTime: "2026-08-20T10:00:00Z",
									}),
									merge,
									build({ id: 703, reason: "manual" }),
								],
							},
						},
						{ json: { value: [branch] } },
						...showResponses({ shownBuild: selected }).slice(1),
					],
					{ resolveValues: [headPr()] },
				);
				const result = await service.show(42, "latest");
				assert.equal(result.build.id, selected.id);
				assert.equal(result.association, newestKind);
				assert.equal(result.current, true);
				assert.equal(calls[0].url, listUrl());
				const branchUrl = new URL(calls[1].url);
				assert.equal(
					branchUrl.searchParams.get("branchName"),
					"refs/heads/feature/widgets",
				);
				assert.equal(branchUrl.searchParams.get("reasonFilter"), null);
				assert.equal(branchUrl.searchParams.get("repositoryId"), "Repo-ID");
				assert.equal(branchUrl.searchParams.get("repositoryType"), "TfsGit");
				assert.equal(
					branchUrl.searchParams.get("queryOrder"),
					"queueTimeDescending",
				);
				assert.equal(branchUrl.searchParams.get("$top"), "100");
			});
		}
	});

	test("latest pages both queries and excludes builds returned on unrelated refs", async (t) => {
		const branch = branchBuild({ id: 701 });
		const { service, calls } = setup(
			t,
			[
				{
					json: { value: [] },
					headers: { "x-ms-continuationtoken": "merge-next" },
				},
				{ json: { value: [branch, build({ sourceVersion: "old" })] } },
				{
					json: {
						value: [
							build(),
							branchBuild({ id: 702, sourceBranch: "refs/heads/other" }),
						],
					},
					headers: { "x-ms-continuationtoken": "branch-next" },
				},
				{ json: { value: [branch] } },
				...showResponses({ shownBuild: branch }).slice(1),
			],
			{ resolveValues: [headPr()] },
		);
		assert.equal((await service.show(42, "latest")).build.id, 701);
		assert.equal(
			new URL(calls[1].url).searchParams.get("continuationToken"),
			"merge-next",
		);
		assert.equal(
			new URL(calls[3].url).searchParams.get("continuationToken"),
			"branch-next",
		);
	});

	test("headBuild reports the newest validating build of either kind", async (t) => {
		const branch = branchBuild({ id: 701 });
		const { service, calls } = setup(
			t,
			[
				{ json: { value: [build({ sourceVersion: "old-merge" })] } },
				{ json: { value: [branch] } },
			],
			{ resolveValues: [headPr()] },
		);
		assert.deepEqual(await service.headBuild(headPr()), {
			association: "branch-head",
			current: true,
			build: branch,
		});
		assert.equal(calls.length, 2);
	});

	test("headBuild marks the newest associated build stale when none validates the head", async (t) => {
		const stale = build({ sourceVersion: "old-merge" });
		const { service } = setup(
			t,
			[{ json: { value: [stale] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		assert.deepEqual(await service.headBuild(headPr()), {
			association: "pr-merge",
			current: false,
			build: stale,
		});
	});

	test("headBuild treats a build on the head of a completed PR as current", async (t) => {
		const completed = { ...headPr(), status: "completed" };
		const branch = branchBuild({ id: 702 });
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [branch] } }],
			{ resolveValues: [completed] },
		);
		assert.deepEqual(await service.headBuild(completed), {
			association: "branch-head",
			current: true,
			build: branch,
		});
	});

	test("headBuild returns null when no associated build exists", async (t) => {
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		assert.equal(await service.headBuild(headPr()), null);
	});

	test("show latest returns the newest associated stale build with its commit", async (t) => {
		const stale = branchBuild({
			sourceVersion: "old-head",
			queueTime: "2026-08-19T10:00:00Z",
		});
		const { service } = setup(
			t,
			[
				{ json: { value: [build({ sourceVersion: "old-merge" })] } },
				{ json: { value: [stale] } },
				...showResponses({ shownBuild: stale }).slice(1),
			],
			{ resolveValues: [headPr()] },
		);
		const result = await service.show(42, "latest");
		assert.deepEqual(result.build, stale);
		assert.equal(result.current, false);
		assert.match(
			service.formatShow(result),
			/stale.*\nAssociation: branch-head; commit: old-head/,
		);
	});

	test("wait latest fails naming the head if only stale builds exist", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{ json: { value: [build({ sourceVersion: "old-merge" })] } },
				{ json: { value: [branchBuild({ sourceVersion: "old-head" })] } },
			],
			{ resolveValues: [headPr()] },
		);
		await assert.rejects(
			service.wait(42, "latest"),
			/No build validates PR #42 head commit HEAD-1/,
		);
		assert.equal(calls.length, 2);
	});

	test("show latest fails clearly if neither query has associated builds", async (t) => {
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		await assert.rejects(service.show(42, "latest"), /head commit HEAD-1/);
	});

	test("wait accepts explicit historical branch builds and selects current branch builds for latest", async (t) => {
		for (const selection of [700, "latest"]) {
			await t.test(String(selection), async (t) => {
				const candidate = branchBuild({
					result: "succeeded",
					sourceVersion: selection === "latest" ? "head-1" : "old-head",
				});
				const { service } = setup(
					t,
					[
						...(selection === "latest"
							? [{ json: { value: [] } }, { json: { value: [candidate] } }]
							: []),
						{ json: candidate },
					],
					{ resolveValues: [headPr()] },
				);
				const result = await service.wait(42, selection);
				assert.equal(result.outcome, "succeeded");
				assert.equal(result.association, "branch-head");
				assert.equal(result.buildId, 700);
				assert.equal(result.pollCount, 1);
				assert.match(
					service.formatWaitResult(result),
					/Association: branch-head/,
				);
			});
		}
	});

	test("retries a current branch build after refresh even without a merge commit", async (t) => {
		const candidate = branchBuild();
		const pr = { ...headPr(), lastMergeCommit: undefined };
		const { service, calls } = setup(
			t,
			[{ json: candidate }, { json: candidate }, { json: candidate }],
			{ resolveValues: [pr] },
		);
		assert.deepEqual(await service.retry(42, 700), candidate);
		assert.equal(calls[2].method, "PATCH");
		assert.match(service.formatRetry(candidate), /Association: branch-head/);
	});

	test("never retries stale branch builds or a head that changed during refresh", async (t) => {
		for (const changedDuringRefresh of [false, true]) {
			await t.test(String(changedDuringRefresh), async (t) => {
				const { service, calls } = setup(
					t,
					changedDuringRefresh
						? [{ json: branchBuild() }, { json: branchBuild() }]
						: [{ json: branchBuild({ sourceVersion: "old-head" }) }],
					{
						resolveValues: [headPr()],
						getValues: [
							pullRequest({ lastMergeSourceCommit: { commitId: "new-head" } }),
						],
					},
				);
				await assert.rejects(service.retry(42, 700), /historical/);
				assert.ok(calls.every(({ method }) => method === "GET"));
			});
		}
	});
});

describe("head metadata and latest selection contracts", () => {
	test("errors identify the exact missing or malformed PR field", async (t) => {
		for (const [overrides, field] of [
			[{ sourceRefName: undefined }, "sourceRefName"],
			[{ lastMergeCommit: {} }, "lastMergeCommit.commitId"],
			[{ lastMergeSourceCommit: {} }, "lastMergeSourceCommit.commitId"],
		]) {
			const { service } = setup(t, [], {
				resolveValues: [pullRequest(overrides)],
			});
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: pull request.${field} must be a non-empty string.`,
			});
		}
	});

	test("null commit metadata leaves associated builds stale", async (t) => {
		const { service } = setup(t, showResponses(), {
			resolveValues: [
				pullRequest({ lastMergeCommit: null, lastMergeSourceCommit: null }),
			],
		});
		const result = await service.show(42, 700);
		assert.equal(result.current, false);
		assert.equal(result.pullRequest.currentMergeCommit, null);
	});

	test("latest without head metadata reports that the commit is unavailable", async (t) => {
		const { service } = setup(t, [
			{ json: { value: [] } },
			{ json: { value: [] } },
		]);
		await assert.rejects(service.wait(42, "latest"), {
			message: "No build validates PR #42 head commit (unavailable).",
		});
	});

	test("cancellation after latest selection stops before starting the polling clock", async () => {
		const controller = new AbortController();
		let queries = 0;
		const service = createBuildService({
			ctx,
			pullRequests: createPullRequestStub().service,
			azure: {
				async requestWithMetadata(_url, options) {
					assert.equal(options.signal, controller.signal);
					assert.equal(options.timeoutMs, 30_000);
					assert.equal(options.maxResponseBytes, 16 * 1024 * 1024);
					queries += 1;
					if (queries === 2) controller.abort();
					return {
						data: { value: queries === 1 ? [build()] : [] },
						metadata: { headers: new Headers() },
					};
				},
				async request() {
					assert.fail("must not poll after cancellation");
				},
			},
			now: () => {
				assert.fail("must not start the polling clock after cancellation");
			},
		});
		await assert.rejects(
			service.wait(42, "latest", { signal: controller.signal }),
			/abort/i,
		);
		assert.equal(queries, 2);
	});
});

test("build list excludes source-branch builds from both current and history output", async (t) => {
	for (const history of [false, true]) {
		const merge = build();
		const branch = build({
			id: 701,
			reason: "manual",
			sourceBranch: "refs/heads/feature/widgets",
		});
		const { service, calls } = setup(t, [{ json: { value: [merge, branch] } }]);
		const result = await service.list(42, { history });
		assert.deepEqual(result.builds, [merge]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, listUrl());
	}
});

describe("policy evaluations", () => {
	const prWithProject = pullRequest({
		repository: {
			id: "Repo-ID",
			name: "widgets",
			project: { id: "project-id" },
		},
	});

	test("maps each evaluation to its policy name, blocking flag, satisfied flag and status", async (t) => {
		const evaluation = (status, isBlocking, displayName) => ({
			status,
			configuration: { isBlocking, type: { displayName } },
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("rejected", true, "Minimum number of reviewers"),
							evaluation("queued", false, "Comment requirements"),
							evaluation("approved", true, "Build"),
							evaluation("NotApplicable", true, "Skipped"),
							{ configuration: {} },
							{},
							{
								status: "",
								configuration: { isBlocking: "yes", type: { displayName: "" } },
							},
						],
					},
				},
			],
			{ resolveValues: [] },
		);

		const unknown = {
			name: "unknown policy",
			blocking: false,
			satisfied: false,
			status: "unknown",
		};
		assert.deepEqual(await service.policyEvaluations(prWithProject), [
			{
				name: "Minimum number of reviewers",
				blocking: true,
				satisfied: false,
				status: "rejected",
			},
			{
				name: "Comment requirements",
				blocking: false,
				satisfied: false,
				status: "queued",
			},
			{ name: "Build", blocking: true, satisfied: true, status: "approved" },
			{
				name: "Skipped",
				blocking: true,
				satisfied: true,
				status: "NotApplicable",
			},
			unknown,
			unknown,
			unknown,
		]);
		assert.equal(
			calls[0].url,
			"https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
		);
	});

	test("reports a missing project ID and malformed responses", async (t) => {
		const noProject = setup(t, []);
		await assert.rejects(noProject.service.policyEvaluations(pullRequest()), {
			message:
				"Cannot read policy evaluations for PR #42: Azure DevOps did not return its project ID.",
		});
		assert.deepEqual(noProject.calls, []);

		const malformed = setup(t, [{ json: {} }]);
		await assert.rejects(
			malformed.service.policyEvaluations(prWithProject),
			/policy evaluations response\.value must be an array/,
		);

		const notObject = setup(t, [{ json: { value: [{}, 7] } }]);
		await assert.rejects(
			notObject.service.policyEvaluations(prWithProject),
			/policy evaluation 2 must be an object/,
		);

		const invalidPr = setup(t, []);
		await assert.rejects(
			invalidPr.service.policyEvaluations({ ...prWithProject, title: "" }),
			/pull request\.title must be a non-empty string/,
		);
	});
});

describe("build queueing", () => {
	const projectId = "project-id";
	const buildPolicyType = "0609b952-1397-4640-95ec-e00a01b2c241";

	test("returns the evaluation when Azure has not returned a build ID", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
			lastMergeSourceCommit: { commitId: "head123" },
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: {
									name: "Widget CI",
									type: { id: buildPolicyType },
								},
							},
						],
					},
				},
				{ json: { status: "queued" } },
			],
			{ resolveValues: [pr] },
		);

		const result = await service.queuePr(42);

		assert.deepEqual(result, { evaluationId: "evaluation-id" });
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
					method: "PATCH",
					body: JSON.stringify({ status: "queued" }),
				},
			],
		);
	});

	test("reports a missing build policy evaluation", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const { service } = setup(t, [{ json: { value: [] } }], {
			resolveValues: [pr],
		});
		await assert.rejects(
			service.queuePr(42),
			/No build policy evaluation.*PR #42/,
		);
	});

	test("rejects an invalid PR ID before resolving the pull request", async (t) => {
		const { service, calls, pullRequestCalls } = setup(t, []);

		await assert.rejects(service.queuePr(0), {
			message: "Pull request ID must be a positive safe integer.",
		});
		assert.deepEqual(pullRequestCalls, []);
		assert.deepEqual(calls, []);
	});

	test("reports a missing project ID before looking up policy evaluations", async (t) => {
		for (const project of [undefined, {}]) {
			const pr = pullRequest({
				repository: { id: "Repo-ID", name: "widgets", project },
			});
			const { service, calls } = setup(t, [], { resolveValues: [pr] });

			await assert.rejects(service.queuePr(42), {
				message:
					"Cannot queue a build for PR #42: Azure DevOps did not return its project ID.",
			});
			assert.deepEqual(calls, []);
		}
	});

	test("reports malformed evaluation responses with their field names", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		for (const [response, error] of [
			[{ json: [] }, /policy evaluations response must be an object/],
			[{ json: {} }, /policy evaluations response\.value must be an array/],
		]) {
			const { service, calls } = setup(t, [response], { resolveValues: [pr] });
			await assert.rejects(service.queuePr(42), error);
			assert.match(calls[0].url, /_apis\/policy\/evaluations\?/);
		}
	});

	test("fetches the build ID from the requeued evaluation context", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const returned = build({ id: 703 });
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
				{
					json: {
						evaluationId: "evaluation-id",
						status: "queued",
						context: { buildId: 703 },
					},
				},
				{ json: returned },
			],
			{ resolveValues: [pr] },
		);

		const result = await service.queuePr(42);

		assert.equal(result.build.id, 703);
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
					method: "PATCH",
					body: JSON.stringify({ status: "queued" }),
				},
				{
					url: `${buildBase}/703?api-version=7.1`,
					method: "GET",
					body: null,
				},
			],
		);
	});

	test("rejects an invalid evaluation build ID without requesting a build", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
				{
					json: {
						evaluationId: "evaluation-id",
						status: "queued",
						context: { buildId: 0 },
					},
				},
			],
			{ resolveValues: [pr] },
		);

		await assert.rejects(service.queuePr(42), (error) => {
			assert.match(error.message, /failed after dispatch/);
			assert.match(
				error.message,
				/requeued policy evaluation context\.buildId must be a positive safe integer/,
			);
			return true;
		});
		assert.equal(calls.length, 2);
	});

	test("gives uncertain-outcome guidance when the evaluation requeue fails after dispatch", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
				{ status: 503, statusText: "Service Unavailable", body: "try later" },
			],
			{ resolveValues: [pr] },
		);

		await assert.rejects(service.queuePr(42), (error) => {
			assert.match(
				error.message,
				/Requeue request for build policy evaluation evaluation-id on PR #42 failed after dispatch/,
			);
			assert.match(error.message, /do not retry automatically/);
			assert.match(error.message, /pr\.sh build show --latest --pr 42/);
			assert.match(error.message, /503 Service Unavailable/);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	test("lists several build policy evaluations and asks for a manual choice", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const evaluations = [
			{
				evaluationId: "first-evaluation",
				configuration: {
					name: "Widget CI",
					type: { id: buildPolicyType },
				},
			},
			{
				evaluationId: "second-evaluation",
				configurationName: "Widget CD",
				configuration: { type: { id: buildPolicyType } },
			},
			{
				evaluationId: "other-policy",
				configuration: { type: { id: "other-policy-type" } },
			},
		];
		const { service } = setup(t, [{ json: { value: evaluations } }], {
			resolveValues: [pr],
		});
		await assert.rejects(service.queuePr(42), {
			message:
				"More than one build policy evaluation was found for PR #42. Choose one manually: evaluation first-evaluation (Widget CI), evaluation second-evaluation (Widget CD).",
		});
	});

	test("queues a branch build with the repository build policy definition", async (t) => {
		const returned = build({
			id: 702,
			sourceBranch: "refs/heads/release/next",
		});
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 3,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: returned },
		]);

		const result = await service.queueBranch("release/next");

		assert.equal(result.id, 702);
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/git/repositories/checkout-name?api-version=7.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/configurations?api-version=7.1&policyType=0609b952-1397-4640-95ec-e00a01b2c241",
					method: "GET",
					body: null,
				},
				{
					url: `${buildBase}?api-version=7.1`,
					method: "POST",
					body: JSON.stringify({
						definition: { id: 9 },
						sourceBranch: "refs/heads/release/next",
					}),
				},
			],
		);
	});

	test("preserves a fully qualified source branch when queueing", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: build({ id: 706, sourceBranch: "refs/heads/main" }) },
		]);

		const result = await service.queueBranch("refs/heads/main");

		assert.equal(result.id, 706);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 9 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("gives uncertain-outcome guidance when the branch queue request fails after dispatch", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ status: 503, statusText: "Service Unavailable", body: "try later" },
		]);

		await assert.rejects(service.queueBranch("main"), (error) => {
			assert.match(
				error.message,
				/Queue request for build definition 9 on refs\/heads\/main failed after dispatch/,
			);
			assert.match(error.message, /do not retry automatically/);
			assert.match(error.message, /503 Service Unavailable/);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
	});

	test("reports a missing build policy for branch queueing", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] } },
		]);
		await assert.rejects(
			service.queueBranch("main"),
			/No build policy.*checkout-name/,
		);
	});

	test("lists multiple repository build definitions and their policies", async (t) => {
		const policies = [
			{
				id: 1,
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 9,
					displayName: "Main CI",
					scope: [{ repositoryId: "Repo-ID" }],
				},
			},
			{
				id: 2,
				displayName: "Release policy",
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 10,
					scope: [{ repositoryId: "Repo-ID" }],
				},
			},
		];
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"More than one build definition was found for repository checkout-name. Choose one manually: definition 9: policy 1 (Main CI); definition 10: policy 2 (Release policy).",
		});
	});

	test("follows policy continuation tokens to find a build policy on a later page", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: { value: [] },
				headers: { "x-ms-continuationtoken": "page-2" },
			},
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: build({ id: 707, sourceBranch: "refs/heads/main" }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 707);
		assert.equal(
			calls[2].url,
			"https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/configurations?api-version=7.1&policyType=0609b952-1397-4640-95ec-e00a01b2c241&continuationToken=page-2",
		);
		assert.match(calls[3].body, /"definition":\{"id":9\}/);
	});

	test("rejects a repeated policy continuation token", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "same" } },
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "same" } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"Azure DevOps policy pagination repeated a continuation token; refusing to loop.",
		});
	});

	test("strips terminal controls from policy names in ambiguity errors", async (t) => {
		const policies = [9, 10].map((definitionId) => ({
			id: definitionId,
			type: { id: buildPolicyType },
			settings: {
				buildDefinitionId: definitionId,
				displayName: "\u001b[31mEvil\u001b[0m\nname",
				scope: [{ repositoryId: "repo-id" }],
			},
		}));
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"More than one build definition was found for repository checkout-name. Choose one manually: definition 9: policy 9 (Evil name); definition 10: policy 10 (Evil name).",
		});
	});

	test("queues once when several repository policies share a build definition", async (t) => {
		const policies = [1, 2].map((id) => ({
			id,
			type: { id: buildPolicyType },
			settings: {
				buildDefinitionId: 9,
				scope: [{ repositoryId: "repo-id" }],
			},
		}));
		policies.unshift(
			{
				type: { id: "other-policy-type" },
				settings: {
					buildDefinitionId: 13,
					scope: [{ repositoryId: "repo-id" }],
				},
			},
			{
				type: null,
				settings: {
					buildDefinitionId: 15,
					scope: [{ repositoryId: "repo-id" }],
				},
			},
			{
				type: { id: buildPolicyType },
				settings: { buildDefinitionId: 16, scope: null },
			},
			{
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 14,
					scope: [{ repositoryId: "another-repo" }],
				},
			},
		);
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
			{ json: build({ id: 704 }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 704);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 9 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("includes project-wide build policies for the repository", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 4,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 11,
								scope: [{ matchKind: "Exact", refName: "refs/heads/main" }],
							},
						},
						{
							id: 5,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 11,
								scope: [{ repositoryId: null }],
							},
						},
					],
				},
			},
			{ json: build({ id: 705 }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 705);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 11 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("ignores disabled build policies", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 6,
							isEnabled: false,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 12,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
		]);

		await assert.rejects(
			service.queueBranch("main"),
			/No build policy.*checkout-name/,
		);
		assert.equal(calls.length, 2);
	});
});
