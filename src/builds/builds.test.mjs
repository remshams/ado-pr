import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	branchBuild,
	build,
	buildBase,
	createPullRequestStub,
	ctx,
	headPr,
	listUrl,
	pullRequest,
	requestShapes,
	setup,
} from "../../tests/support/builds.mjs";
import { AzureRequestError } from "../shared/azure.ts";
import { createBuildService } from "./builds.ts";

function branchListUrl() {
	return (
		`${buildBase}?branchName=refs%2Fheads%2Ffeature%2Fwidgets&` +
		"repositoryId=Repo-ID&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&api-version=7.1"
	);
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
	{ resolvedPr = pullRequest(), refreshedPr = resolvedPr, start = 0 } = {},
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
		async requestWithMetadata(url, options) {
			return {
				data: await azure.request(url, options),
				metadata: { headers: new Headers() },
			};
		},
	};
	const pullRequests = {
		async resolve(requestedPrId) {
			pullRequestCalls.push({ method: "resolve", requestedPrId });
			return resolvedPr;
		},
		async get(prId, options) {
			pullRequestCalls.push({ method: "get", prId });
			if (refreshedPr instanceof Error) throw refreshedPr;
			if (typeof refreshedPr === "function") return refreshedPr(options);
			return refreshedPr;
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
	test("lists current PR merge and branch builds, newest first, labelled and marked current", async (t) => {
		const merge = build({ queueTime: "2026-08-18T10:00:00Z" });
		const staleMerge = build({ id: 701, sourceVersion: "older" });
		const unrelatedBranch = build({
			id: 702,
			sourceBranch: "refs/pull/99/merge",
		});
		const unrelatedReason = build({ id: 703, reason: "manual" });
		const branch = branchBuild({ id: 704, queueTime: "2026-08-18T11:00:00Z" });
		const staleBranch = branchBuild({ id: 705, sourceVersion: "old-head" });
		const otherBranch = branchBuild({
			id: 706,
			sourceBranch: "refs/heads/other",
		});
		const { service, calls, pullRequestCalls } = setup(
			t,
			[
				{
					json: {
						value: [merge, staleMerge, unrelatedBranch, unrelatedReason],
					},
				},
				{ json: { value: [branch, staleBranch, otherBranch] } },
			],
			{ resolveValues: [headPr()] },
		);

		const result = await service.list(undefined);

		assert.deepEqual(result, {
			pullRequest: {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: true,
				currentMergeCommit: "ABCDEF123",
				currentHeadCommit: "HEAD-1",
			},
			history: false,
			builds: [
				{ ...branch, association: "branch-head", current: true },
				{ ...merge, association: "pr-merge", current: true },
			],
			hiddenBuilds: 2,
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
			{
				url: branchListUrl(),
				method: "GET",
				headers: { authorization: "<redacted>" },
				body: null,
			},
		]);
	});

	test("lists a build without a queue time after the timed builds", async (t) => {
		const untimed = build({ queueTime: undefined });
		const older = branchBuild({ id: 704, queueTime: "2026-08-18T09:00:00Z" });
		const newer = branchBuild({ id: 705, queueTime: "2026-08-18T11:00:00Z" });
		const { service } = setup(
			t,
			[{ json: { value: [untimed] } }, { json: { value: [older, newer] } }],
			{ resolveValues: [headPr()] },
		);

		const result = await service.list(undefined);

		assert.deepEqual(
			result.builds.map((listed) => listed.id),
			[705, 704, untimed.id],
		);
	});

	test("history follows and encodes every continuation page and merges both build kinds newest first without marking inactive PRs current", async (t) => {
		const first = build({
			id: 702,
			sourceVersion: "old-two",
			queueTime: "2026-08-18T10:00:00Z",
		});
		const second = build({
			id: 701,
			sourceVersion: "old-one",
			queueTime: "2026-08-18T08:00:00Z",
		});
		const middle = branchBuild({
			id: 703,
			queueTime: "2026-08-18T09:00:00Z",
		});
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
				{ json: { value: [middle] } },
			],
			{ resolveValues: [completed] },
		);

		const result = await service.list(42, { history: true });

		assert.equal(result.history, true);
		assert.equal(result.hiddenBuilds, 0);
		assert.deepEqual(result.builds, [
			{ ...first, association: "pr-merge", current: false },
			{ ...middle, association: "branch-head", current: false },
			{ ...second, association: "pr-merge", current: false },
		]);
		assert.deepEqual(result.pullRequest, {
			id: 42,
			title: "Validate widgets",
			status: "completed",
			draft: true,
			currentMergeCommit: null,
			currentHeadCommit: null,
		});
		assert.deepEqual(
			calls.map(({ url }) => url),
			[listUrl(), listUrl(token), branchListUrl()],
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
		const pages = () => [
			{ json: { value: [build()] } },
			{ json: { value: [] } },
		];
		const changedCommit = setup(t, pages(), {
			getValues: [pullRequest({ lastMergeCommit: { commitId: "new-merge" } })],
		});
		await assert.rejects(
			changedCommit.service.list(42),
			/changed while current builds were being listed/,
		);

		const changedHead = setup(t, pages(), {
			resolveValues: [headPr()],
			getValues: [
				pullRequest({ lastMergeSourceCommit: { commitId: "new-head" } }),
			],
		});
		await assert.rejects(
			changedHead.service.list(42),
			/changed while current builds were being listed/,
		);

		const gainedMerge = setup(t, pages(), {
			resolveValues: [pullRequest({ lastMergeCommit: undefined })],
			getValues: [pullRequest()],
		});
		await assert.rejects(
			gainedMerge.service.list(42),
			/changed while current builds were being listed/,
		);

		const changedStatus = setup(t, pages(), {
			getValues: [pullRequest({ status: "completed" })],
		});
		await assert.rejects(
			changedStatus.service.list(42),
			/only active pull requests are eligible/,
		);
	});

	test("current listing rejects inactive PRs before the Build API", async (t) => {
		const inactive = setup(t, [], {
			resolveValues: [pullRequest({ status: "abandoned" })],
		});
		await assert.rejects(
			inactive.service.list(42),
			/Cannot list current builds: PR #42 is abandoned; only active pull requests are eligible/,
		);
		assert.deepEqual(inactive.calls, []);
	});

	test("counts the stale builds an empty current listing hides", async (t) => {
		const { service } = setup(t, [
			{ json: { value: [build({ id: 701, sourceVersion: "older" })] } },
			{ json: { value: [branchBuild({ id: 702, sourceVersion: "old" })] } },
		]);

		const result = await service.list(42);

		assert.deepEqual(result.builds, []);
		assert.equal(result.hiddenBuilds, 2);
		assert.equal(
			service.formatList(result),
			"No associated current head builds found for PR #42. 2 stale builds exist; use build list --history or build show --latest.",
		);
	});

	test("current listing of a PR without a merge commit still shows branch builds validating the head", async (t) => {
		const branch = branchBuild();
		const { service } = setup(
			t,
			[{ json: { value: [build()] } }, { json: { value: [branch] } }],
			{
				resolveValues: [
					pullRequest({
						lastMergeCommit: undefined,
						lastMergeSourceCommit: { commitId: "HEAD-1" },
					}),
				],
			},
		);

		const result = await service.list(42);

		assert.deepEqual(result.builds, [
			{ ...branch, association: "branch-head", current: true },
		]);
		assert.equal(result.pullRequest.currentMergeCommit, null);
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
		const branch = branchBuild({
			id: 698,
			queueTime: "2026-08-17T10:00:00Z",
			status: "completed",
			result: "succeeded",
		});
		const { service } = setup(
			t,
			[
				{ json: { value: [build(), historical] } },
				{ json: { value: [branch] } },
			],
			{ resolveValues: [headPr()] },
		);
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
				"  https://dev.azure.com/build/700\n\n" +
				"- Build 698/2026.8.18.1 — Widget CI\n" +
				"  Association: branch-head\n  Status/result: completed/succeeded [current]\n" +
				"  Queue/start/finish: 2026-08-17T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z\n" +
				"  https://dev.azure.com/build/700",
		);

		const empty = { ...result, history: false, builds: [] };
		assert.equal(
			service.formatList({ ...empty, hiddenBuilds: 0 }),
			"No associated current head builds found for PR #42.",
		);
		assert.equal(
			service.formatList({ ...empty, hiddenBuilds: 1 }),
			"No associated current head builds found for PR #42. 1 stale build exists; use build list --history or build show --latest.",
		);
		assert.equal(
			service.formatList({ ...empty, hiddenBuilds: 3 }),
			"No associated current head builds found for PR #42. 3 stale builds exist; use build list --history or build show --latest.",
		);
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
			assert.equal(result.validatesHead, true);
			assert.deepEqual(pullRequestCalls, [
				{ method: "resolve", requestedPrId: undefined },
				{ method: "get", prId: 42 },
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
		assert.equal(result.validatesHead, null);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
			{ method: "get", prId: 42 },
		]);
	});

	test("reports a build as stale when the PR head moved during the wait", async () => {
		const { service } = createWaitHarness(
			[build({ status: "inProgress" }), build({ result: "succeeded" })],
			{
				refreshedPr: pullRequest({
					lastMergeCommit: { commitId: "new-merge" },
				}),
			},
		);
		const result = await service.wait(42, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, false);
		assert.match(
			service.formatWaitResult(result),
			/Validates head: no\nThis build doesn't validate the current head of the pull request; wait for the build that does with `pr\.sh build wait --latest --pr 42`\./,
		);
	});

	test("reports a branch build as stale when the source head moved", async () => {
		const { service } = createWaitHarness(
			[branchBuild({ result: "succeeded", sourceVersion: "head-1" })],
			{
				resolvedPr: headPr(),
				refreshedPr: pullRequest({
					...headPr(),
					lastMergeSourceCommit: { commitId: "head-2" },
				}),
			},
		);
		const result = await service.wait(42, 700);
		assert.equal(result.association, "branch-head");
		assert.equal(result.validatesHead, false);
	});

	test("reports the PR summary from the final read", async () => {
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: pullRequest({
				status: "completed",
				lastMergeCommit: { commitId: "new-merge" },
			}),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.validatesHead, false);
		assert.equal(result.pullRequest.status, "completed");
		assert.deepEqual(Object.keys(result).slice(0, 3), [
			"association",
			"pullRequest",
			"buildId",
		]);
		assert.equal(Object.keys(result).at(-1), "validatesHead");
		assert.equal(result.pullRequest.currentMergeCommit, "new-merge");
		assert.doesNotMatch(service.formatWaitResult(result), /--latest/);
	});

	test("reports an unknown head when the final read has no commit to compare", async () => {
		for (const [observed, refreshedPr] of [
			[
				build({ result: "succeeded" }),
				pullRequest({ lastMergeCommit: undefined }),
			],
			[
				branchBuild({ result: "succeeded" }),
				pullRequest({ lastMergeSourceCommit: undefined }),
			],
		]) {
			const { service } = createWaitHarness([observed], {
				resolvedPr: headPr(),
				refreshedPr,
			});
			const result = await service.wait(42, 700);
			assert.equal(result.validatesHead, null);
			assert.doesNotMatch(service.formatWaitResult(result), /--latest/);
		}
	});

	test("skips the final PR read when the deadline passed while reporting progress", async () => {
		const { service, clock, pullRequestCalls } = createWaitHarness([
			build({ result: "succeeded" }),
		]);
		const result = await service.wait(42, 700, {
			timeoutSeconds: 10,
			onProgress: () => {
				clock.value = 10_000;
			},
		});
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, null);
		assert.equal(result.pullRequest.id, 42);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
		]);
	});

	test("bounds the final PR read by the wait deadline", async () => {
		const readTimeouts = [];
		const { service } = createWaitHarness(
			[
				({ clock }) => {
					clock.value = 9_000;
					return build({ result: "succeeded" });
				},
			],
			{
				refreshedPr: (options) => {
					readTimeouts.push(options.timeoutMs);
					return pullRequest();
				},
			},
		);
		const result = await service.wait(42, 700, { timeoutSeconds: 10 });
		assert.equal(result.validatesHead, true);
		assert.deepEqual(readTimeouts, [1_000]);
	});

	test("still validates the head when auto-complete merged the PR as the build finished", async () => {
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: pullRequest({ status: "completed" }),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.validatesHead, true);
		assert.match(service.formatWaitResult(result), /Validates head: yes$/);
	});

	test("reports an unknown head when the final PR read fails", async () => {
		const failedRead = new AzureRequestError("Bad Gateway", "http");
		for (const refreshedPr of [failedRead, { pullRequestId: "not a number" }]) {
			const { service } = createWaitHarness([build({ result: "failed" })], {
				refreshedPr,
			});
			const result = await service.wait(42, 700);
			assert.equal(result.outcome, "failed");
			assert.equal(result.validatesHead, null);
			assert.deepEqual(result.pullRequest, {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: false,
				currentMergeCommit: "ABCDEF123",
				currentHeadCommit: null,
			});
			assert.match(service.formatWaitResult(result), /Validates head: unknown/);
		}
	});

	test("cancels instead of reporting when aborted during the final PR read", async () => {
		const controller = new AbortController();
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: () => {
				controller.abort();
				throw new AzureRequestError("request aborted", "abort");
			},
		});
		await assert.rejects(
			service.wait(42, 700, { signal: controller.signal }),
			(error) => error.kind === "abort",
		);
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
				currentHeadCommit: null,
			},
			buildId: 700,
			build: observed,
			association: "pr-merge",
			pollCount: 1,
			transientFailureCount: 0,
			elapsedSeconds: 10,
			timedOut: true,
			outcome: "timeout",
			validatesHead: null,
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
			validatesHead: true,
		};
		assert.equal(
			service.formatWaitResult(result),
			"build 700 for PR #42 finished with outcome failed.\nStatus/result: completed/failed; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown\nValidates head: yes\nInspect failure details with `pr.sh build show --pr 42 --build 700`.",
		);
		assert.equal(
			service.formatWaitResult({
				...result,
				outcome: "succeeded",
				build: { status: "completed", result: "succeeded" },
			}),
			"build 700 for PR #42 finished with outcome succeeded.\nStatus/result: completed/succeeded; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown\nValidates head: yes",
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

	for (const [name, requeueResponse] of [
		["context.buildId is null", { context: { buildId: null } }],
		["context.buildId is missing", { context: {} }],
		["context is null", { context: null }],
		["context is missing", {}],
	]) {
		test(`returns the evaluation ID when the requeue response says ${name}`, async (t) => {
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
							...requeueResponse,
						},
					},
				],
				{ resolveValues: [pr] },
			);

			assert.deepEqual(await service.queuePr(42), {
				evaluationId: "evaluation-id",
			});
			assert.equal(calls.length, 2);
		});
	}

	for (const [name, requeueResponse, reason] of [
		[
			"a build ID of 0",
			{ context: { buildId: 0 } },
			/requeued policy evaluation context\.buildId must be a positive safe integer/,
		],
		[
			"a string build ID",
			{ context: { buildId: "703" } },
			/requeued policy evaluation context\.buildId must be a positive safe integer/,
		],
		["a non-object body", ["queued"], /requeued policy evaluation response/],
		[
			"a non-object context",
			{ context: "queued" },
			/requeued policy evaluation context must be an object/,
		],
	]) {
		test(`says the requeue was accepted when the response has ${name}`, async (t) => {
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
					{ json: requeueResponse },
				],
				{ resolveValues: [pr] },
			);

			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(
					error.message,
					/Requeue request for build policy evaluation evaluation-id on PR #42 was accepted, but Azure DevOps sent an invalid build ID or response/,
				);
				assert.match(error.message, /pr\.sh build list --pr 42 --history/);
				assert.match(error.message, reason);
				assert.doesNotMatch(error.message, /failed after dispatch|uncertain/);
				return true;
			});
			assert.equal(calls.length, 2);
		});
	}

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

	test("keeps the uncertain-outcome guidance for an empty or non-JSON 2xx requeue body", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		for (const body of ["", "<html>proxy</html>"]) {
			const { service } = setup(
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
					{ status: 200, body },
				],
				{ resolveValues: [pr] },
			);
			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(error.message, /failed after dispatch/);
				assert.doesNotMatch(error.message, /was accepted/);
				return true;
			});
		}
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
				"More than one build policy evaluation was found for PR #42. Choose one with --definition <id>: evaluation first-evaluation (Widget CI); evaluation second-evaluation (Widget CD).",
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
				/Queue request for build pipeline 9 on refs\/heads\/main failed after dispatch/,
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
				"More than one build pipeline was found for repository checkout-name. Choose one with --definition <id>: build pipeline 9: policy 1 (Main CI); build pipeline 10: policy 2 (Release policy).",
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
				"More than one build pipeline was found for repository checkout-name. Choose one with --definition <id>: build pipeline 9: policy 9 (Evil name); build pipeline 10: policy 10 (Evil name).",
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

	function evaluation(evaluationId, definitionId, name) {
		return {
			evaluationId,
			configuration: {
				name,
				type: { id: buildPolicyType },
				settings: { buildDefinitionId: definitionId },
			},
		};
	}

	const queuePrPullRequest = () =>
		pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});

	test("requeues the evaluation whose pipeline matches --definition", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Widget CI"),
							evaluation("second-evaluation", 12, "Widget CD"),
						],
					},
				},
				{ json: { status: "queued" } },
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		const result = await service.queuePr(42, 12);

		assert.deepEqual(result, { evaluationId: "second-evaluation" });
		assert.match(calls[1].url, /evaluations\/second-evaluation\?/);
		assert.equal(calls[1].method, "PATCH");
	});

	test("lists the candidates and sends no mutation when --definition matches no evaluation", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Widget CI"),
							{
								evaluationId: "unknown-pipeline",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42, 77), {
			message:
				"No build policy evaluation for build pipeline (definition) 77 was found for PR #42. Candidates: evaluation first-evaluation (Widget CI), build pipeline 9; evaluation unknown-pipeline.",
		});
		assert.equal(calls.filter(({ method }) => method !== "GET").length, 0);
	});

	test("fails when several evaluations share the --definition pipeline", async (t) => {
		const { service } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Main CI"),
							evaluation("second-evaluation", 9, "Release CI"),
						],
					},
				},
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42, 9), {
			message:
				"More than one build policy evaluation was found for PR #42 for build pipeline 9: evaluation first-evaluation (Main CI), build pipeline 9; evaluation second-evaluation (Release CI), build pipeline 9.",
		});
	});

	test("queues --definition on a branch without reading build policies", async (t) => {
		const { service, calls } = setup(t, [{ json: build({ id: 707 }) }]);

		const result = await service.queueBranch("feature/x", 21);

		assert.equal(result.id, 707);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "POST");
		assert.equal(
			calls[0].body,
			JSON.stringify({
				definition: { id: 21 },
				sourceBranch: "refs/heads/feature/x",
			}),
		);
	});

	test("prefers --definition over the repository build policies", async (t) => {
		const { service, calls } = setup(t, [{ json: build({ id: 708 }) }]);

		await service.queueBranch("main", 33);

		assert.equal(calls.length, 1);
		assert.match(calls[0].body, /"definition":\{"id":33\}/);
	});

	test("points to --definition when a branch has no build policy", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] } },
		]);

		await assert.rejects(service.queueBranch("main"), /Pass --definition <id>/);
	});

	describe("scope hint on 401 and 403", () => {
		for (const status of [401, 403]) {
			test(`names the Build (Read & execute) scope when a branch queue gets ${status}`, async (t) => {
				const { service, calls } = setup(t, [
					{ status, statusText: "Denied", body: "no" },
				]);

				await assert.rejects(service.queueBranch("main", 9), (error) => {
					assert.match(
						error.message,
						new RegExp(`rejected with HTTP ${status}`),
					);
					assert.match(error.message, /Build \(Read & execute\)/);
					assert.match(error.message, /vso\.build_execute/);
					assert.doesNotMatch(error.message, /unverified/);
					assert.doesNotMatch(error.message, /may be uncertain/);
					return true;
				});
				assert.equal(calls.length, 1);
			});
		}

		test("adds that a policy requeue may need more scope", async (t) => {
			const { service } = setup(
				t,
				[
					{ json: { value: [evaluation("evaluation-id", 9, "Widget CI")] } },
					{ status: 403, statusText: "Forbidden", body: "no" },
				],
				{ resolveValues: [queuePrPullRequest()] },
			);

			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(error.message, /rejected with HTTP 403/);
				assert.match(error.message, /Build \(Read & execute\)/);
				assert.match(
					error.message,
					/may need more than that; this is unverified/,
				);
				return true;
			});
		});

		test("names the scope when a build retry gets 403", async (t) => {
			const failed = build({ status: "completed", result: "failed" });
			const { service } = setup(
				t,
				[
					{ json: failed },
					{ json: failed },
					{ status: 403, statusText: "Forbidden", body: "no" },
				],
				{ resolveValues: [pullRequest(), pullRequest()] },
			);

			await assert.rejects(service.retry(42, 700), (error) => {
				assert.match(
					error.message,
					/Retry request for build 700 was rejected with HTTP 403/,
				);
				assert.match(error.message, /Build \(Read & execute\)/);
				assert.doesNotMatch(error.message, /unverified/);
				return true;
			});
		});

		test("leaves reads without a scope hint", async (t) => {
			const { service } = setup(t, [
				{ status: 403, statusText: "Forbidden", body: "no" },
			]);

			await assert.rejects(service.queueBranch("main"), (error) => {
				assert.doesNotMatch(error.message, /vso\.build_execute/);
				return true;
			});
		});
	});

	test("rejects 400 and 404 without uncertain-outcome text or a scope hint", async (t) => {
		for (const status of [400, 404]) {
			const { service, calls } = setup(t, [
				{ status, statusText: "Nope", body: "no such pipeline" },
			]);

			await assert.rejects(service.queueBranch("main", 99), (error) => {
				assert.match(
					error.message,
					new RegExp(
						`Queue request for build pipeline 99 on refs/heads/main was rejected with HTTP ${status}; Azure DevOps took no action\\.\\n`,
					),
				);
				assert.doesNotMatch(error.message, /uncertain|retry automatically/);
				assert.doesNotMatch(error.message, /vso\.build_execute/);
				return true;
			});
			assert.equal(calls.length, 1);
		}
	});

	test("keeps 409, 5xx and network failures uncertain", async (t) => {
		for (const response of [
			{ status: 409, statusText: "Conflict", body: "busy" },
			{ status: 500, statusText: "Server Error", body: "oops" },
			{ error: new TypeError("fetch failed") },
		]) {
			const { service } = setup(t, [response]);

			await assert.rejects(service.queueBranch("main", 9), (error) => {
				assert.match(error.message, /failed after dispatch/);
				assert.match(error.message, /may be uncertain/);
				return true;
			});
		}
	});

	test("also says the account may lack permission to queue the build pipeline", async (t) => {
		const { service } = setup(t, [
			{ status: 403, statusText: "Forbidden", body: "no" },
		]);

		await assert.rejects(service.queueBranch("main", 9), (error) => {
			assert.match(
				error.message,
				/the account needs permission to queue builds for that build pipeline/,
			);
			return true;
		});
	});

	test("does not call a failed build read after a successful requeue a rejection", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{ json: { value: [evaluation("evaluation-id", 9, "Widget CI")] } },
				{
					json: {
						evaluationId: "evaluation-id",
						status: "queued",
						context: { buildId: 701 },
					},
				},
				{ status: 403, statusText: "Forbidden", body: "no read" },
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42), (error) => {
			assert.match(
				error.message,
				/^Requeued build policy evaluation evaluation-id on PR #42; reading build 701 failed\./,
			);
			assert.match(error.message, /pr\.sh build show --build 701 --pr 42/);
			assert.doesNotMatch(
				error.message,
				/rejected|uncertain|vso\.build_execute/,
			);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	describe("queue output", () => {
		test("formatQueue names the build pipeline and adds the wait line for a PR", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatQueue(
					build({ id: 701, definition: { id: 9, name: "Widget CI" } }),
					42,
				),
				[
					"Azure DevOps queued build 701/2026.8.18.1.",
					"Build pipeline: Widget CI (9)",
					"URL: https://dev.azure.com/build/700",
					"Wait with: pr.sh build wait --build 701 --pr 42",
				].join("\n"),
			);
		});

		test("formatQueue omits the wait line without a PR and the pipeline line without a name", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatQueue(build({ id: 702, definition: undefined })),
				[
					"Azure DevOps queued build 702/2026.8.18.1.",
					"URL: https://dev.azure.com/build/700",
				].join("\n"),
			);
		});

		test("formatRequeue points to build show and a wait command with the new build ID", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatRequeue("evaluation-id", 42),
				[
					"Requeued build policy evaluation evaluation-id for PR #42.",
					"Azure DevOps did not return the build ID yet. When `pr.sh build show --latest --pr 42` shows a new build ID, run `pr.sh build wait --build <id> --pr 42`.",
				].join("\n"),
			);
		});
	});

	describe("pull request for a queued branch", () => {
		test("returns the ID of the one active pull request", async (t) => {
			const { service, pullRequestCalls } = setup(t, [], {
				branchPullRequests: [{ pullRequestId: 55 }],
			});

			assert.equal(await service.branchPullRequestId("feature/x"), 55);
			assert.deepEqual(pullRequestCalls, [
				{ method: "findActiveForBranch", branch: "feature/x" },
			]);
		});

		test("returns undefined when the branch has no active pull request", async (t) => {
			const { service } = setup(t, [], { branchPullRequests: [] });

			assert.equal(await service.branchPullRequestId("feature/x"), undefined);
		});

		test("fails naming the candidates when several pull requests share the source", async (t) => {
			const { service } = setup(t, [], {
				branchPullRequests: [{ pullRequestId: 55 }, { pullRequestId: 56 }],
			});

			await assert.rejects(service.branchPullRequestId("feature/x"), {
				message:
					"Multiple active pull requests have feature/x as their source: #55, #56. Run `pr.sh build wait --build <id> --pr <id>` with the one you want.",
			});
		});
	});
});

describe("build wait --latest follows the PR head", () => {
	const newHead = () =>
		pullRequest({
			...headPr(),
			lastMergeSourceCommit: { commitId: "HEAD-2" },
			lastMergeCommit: { commitId: "new-merge" },
		});
	const noBuilds = () => [{ value: [] }, { value: [] }];
	const listed = (candidate) => [{ value: [candidate] }, { value: [] }];

	function followHarness(responses, refreshed = [], options = {}) {
		let reads = 0;
		const harness = createWaitHarness(responses, {
			resolvedPr: headPr(),
			refreshedPr: () => {
				const next = refreshed[Math.min(reads++, refreshed.length - 1)];
				if (next instanceof Error) throw next;
				return next;
			},
			...options,
		});
		const events = [];
		const wait = (waitOptions = {}) =>
			harness.service.wait(42, "latest", {
				onProgress: (event) => events.push(event),
				...waitOptions,
			});
		return { ...harness, events, wait };
	}

	test("waits for a build to appear, then follows it to the end", async () => {
		const { service, events, pullRequestCalls, wait } = followHarness(
			[
				...noBuilds(),
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[headPr()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 700);
		assert.equal(result.validatesHead, true);
		assert.equal(result.pollCount, 3);
		assert.deepEqual(
			events.map(({ type }) => type),
			["waiting-for-build", "build-selected", "state", "state"],
		);
		assert.equal(
			service.formatWaitProgress(events[0]),
			"PR #42: no build validates head HEAD-1 yet; waiting for one.",
		);
		assert.equal(
			service.formatWaitProgress(events[1]),
			"PR #42, build 700: selected for head HEAD-1.",
		);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
			{ method: "get", prId: 42 },
			{ method: "get", prId: 42 },
		]);
	});

	test("ends with no-build when no build validates the head within 10 minutes", async () => {
		const { service, wait } = followHarness(
			[...noBuilds(), ...noBuilds(), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 300 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.buildId, null);
		assert.equal(result.build, null);
		assert.equal(result.timedOut, false);
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(
			service.formatWaitResult(result),
			"No build validated the head of PR #42 (commit HEAD-1) within 10 minutes; 600.0s elapsed; 3 poll(s); 0 transient failure(s).\n" +
				"Draft: yes. Check that the build policy runs for this pull request, or queue a build with `pr.sh build queue --pr 42`.",
		);
	});

	test("times out instead when the timeout is shorter than the wait for a build", async () => {
		const { service, wait } = followHarness(
			[...noBuilds(), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 30, timeoutSeconds: 60 });
		assert.equal(result.outcome, "timeout");
		assert.equal(result.buildId, null);
		assert.match(
			service.formatWaitResult(result),
			/^build wait for PR #42 timed out before a build validated head HEAD-1;/,
		);
	});

	test("switches to the build for the new head when the head moves", async () => {
		const next = build({ id: 701, sourceVersion: "new-merge" });
		const { service, events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...listed({ ...next, status: "inProgress" }),
				{ ...next, result: "succeeded" },
			],
			[newHead()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 701);
		assert.equal(result.validatesHead, true);
		assert.equal(result.pullRequest.currentHeadCommit, "HEAD-2");
		const switched = events.filter(({ type }) => type === "build-selected");
		assert.deepEqual(
			switched.map(({ buildId, previousBuildId }) => [
				buildId,
				previousBuildId,
			]),
			[
				[700, null],
				[701, 700],
			],
		);
		assert.equal(
			service.formatWaitProgress(switched[1]),
			"PR #42, build 701: selected for head HEAD-2. The head moved, so build 700 no longer counts.",
		);
	});

	test("ends with no-build when the head moves and no build follows", async () => {
		const { events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...noBuilds(),
				...noBuilds(),
				...noBuilds(),
			],
			[newHead()],
		);
		const result = await wait({ intervalSeconds: 300 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 900);
		const waiting = events.filter(({ type }) => type === "waiting-for-build");
		assert.equal(waiting.length, 1);
		assert.equal(waiting[0].pullRequest.currentHeadCommit, "HEAD-2");
	});

	test("keeps the selected build when only the merge commit changes", async () => {
		const { wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[
				pullRequest({
					...headPr(),
					lastMergeCommit: { commitId: "new-merge" },
				}),
			],
		);
		const result = await wait();
		assert.equal(result.buildId, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, false);
	});

	test("ends with no-build after 10 minutes even with a longer interval", async () => {
		const { wait } = followHarness([...noBuilds(), ...noBuilds()], [headPr()]);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(result.pollCount, 2);
	});

	test("ends with no-build on time after a transient failure", async () => {
		const { wait } = followHarness(
			[...noBuilds(), transientError("http", 503), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.transientFailureCount, 1);
		assert.equal(result.elapsedSeconds, 600);
	});

	test("caps a retry after a transient failure at the end of the wait for a build", async () => {
		const { wait } = followHarness(
			[transientError("http", 503), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(result.pollCount, 2);
	});

	test("follows the head through two moves", async () => {
		const third = pullRequest({
			...headPr(),
			lastMergeSourceCommit: { commitId: "HEAD-3" },
			lastMergeCommit: { commitId: "third-merge" },
		});
		const last = build({ id: 702, sourceVersion: "third-merge" });
		const { events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...noBuilds(),
				...listed({ ...last, status: "inProgress" }),
				{ ...last, result: "succeeded" },
			],
			[newHead(), third],
		);
		const result = await wait();
		assert.equal(result.buildId, 702);
		assert.equal(result.outcome, "succeeded");
		assert.deepEqual(
			events
				.filter(({ type }) => type === "build-selected")
				.map(({ buildId, previousBuildId }) => [buildId, previousBuildId]),
			[
				[700, null],
				[702, 700],
			],
		);
	});

	test("retries a transient failure while rereading the PR", async () => {
		const { wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[transientError("http", 503), headPr()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.transientFailureCount, 1);
	});

	test("stops with an error when the PR is not active and no build is selected", async () => {
		const completed = pullRequest({ ...headPr(), status: "completed" });
		const atStart = followHarness([], [completed], { resolvedPr: completed });
		await assert.rejects(atStart.wait(), /PR #42 is completed/);
		assert.equal(atStart.calls.length, 0);

		const whileWaiting = followHarness([...noBuilds()], [completed]);
		await assert.rejects(whileWaiting.wait(), /PR #42 is completed/);
	});

	test("keeps --build pinned when the head moves", async () => {
		const { service } = createWaitHarness(
			[build({ status: "inProgress" }), build({ result: "succeeded" })],
			{ resolvedPr: headPr(), refreshedPr: newHead() },
		);
		const result = await service.wait(42, 700, { intervalSeconds: 10 });
		assert.equal(result.buildId, 700);
		assert.equal(result.validatesHead, false);
	});
});
