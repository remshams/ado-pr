import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	branchBuild,
	build,
	buildBase,
	headPr,
	listUrl,
	pullRequest,
	requestShapes,
	setup,
} from "../../tests/support/builds.mjs";

function branchListUrl() {
	return (
		`${buildBase}?branchName=refs%2Fheads%2Ffeature%2Fwidgets&` +
		"repositoryId=Repo-ID&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&api-version=7.1"
	);
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
