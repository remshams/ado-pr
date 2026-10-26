import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
import { createPullRequestCompletionService } from "./completion.ts";

const ctx = {
	organization: "test-org",
	project: "test-project",
	repository: "test-repository",
};
const prUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository/pullRequests/42?api-version=7.1";
const webUrl =
	"https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42";
const connectionDataUrl =
	"https://dev.azure.com/test-org/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1";
const head = "1111111111111111111111111111111111111111";
const pushedHead = "3333333333333333333333333333333333333333";
const statusHint =
	"Run `pr.sh pr status --pr 42` to see blocking policies, merge conflicts and the current head.";

function pullRequest(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Add widgets",
		status: "active",
		sourceRefName: "refs/heads/feature/widgets",
		lastMergeSourceCommit: { commitId: head },
		...overrides,
	};
}

function createService(t, responses, current = pullRequest()) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat: "test-only-fake-pat", fetch });
	const resolved = [];
	const service = createPullRequestCompletionService({
		azure,
		ctx,
		pullRequests: {
			resolve: async (prId) => {
				resolved.push(prId);
				return current;
			},
		},
	});
	return { service, calls, resolved };
}

function sent(call) {
	return { method: call.method, url: call.url, body: JSON.parse(call.body) };
}

const user = { json: { authenticatedUser: { id: "user-1" } } };

// Azure answers the PATCH with the updated pull request.
function updated(overrides = {}) {
	return { json: pullRequest(overrides) };
}

// Azure error bodies carry the reason in `message`; statuses and wording are not verified.
function rejection(status, statusText, message) {
	return {
		status,
		statusText,
		json: { $id: "1", innerException: null, message, errorCode: 0 },
	};
}

// The server accepts only the head it has now and rejects any other head with 409.
function serverAtHead(serverHead) {
	return {
		whenBodyIncludes: `"lastMergeSourceCommit":{"commitId":"${serverHead}"}`,
		matched: updated({ status: "completed", mergeStatus: "succeeded" }),
		otherwise: rejection(
			409,
			"Conflict",
			"TF401192: The source branch has been updated since the pull request was last merged.",
		),
	};
}

const squash = { mergeStrategy: "squash", deleteSourceBranch: false };

describe("pull request completion", () => {
	test("completes at the head read just now with the merge strategy", async (t) => {
		const { service, calls, resolved } = createService(t, [
			updated({ status: "completed", mergeStatus: "queued" }),
		]);

		const result = await service.complete(undefined, {
			...squash,
			auto: false,
		});

		assert.deepEqual(resolved, [undefined]);
		assert.deepEqual(calls.map(sent), [
			{
				method: "PATCH",
				url: prUrl,
				body: {
					status: "completed",
					lastMergeSourceCommit: { commitId: head },
					completionOptions: { mergeStrategy: "squash" },
				},
			},
		]);
		assert.deepEqual(result, {
			pullRequestId: 42,
			title: "Add widgets",
			outcome: "merging",
			headCommit: head,
			mergeStatus: "queued",
			mergeStrategy: "squash",
			deleteSourceBranch: false,
		});
	});

	test("keeps completion options set earlier and overlays only the flags given", async (t) => {
		const earlier = {
			transitionWorkItems: true,
			mergeCommitMessage: "Merged from the UI",
			mergeStrategy: "squash",
			deleteSourceBranch: true,
		};
		const { service, calls } = createService(
			t,
			[updated({ status: "completed" }), updated({ status: "completed" })],
			pullRequest({ completionOptions: earlier }),
		);

		const kept = await service.complete(42, {
			mergeStrategy: "rebase",
			deleteSourceBranch: false,
			auto: false,
		});
		await service.complete(42, {
			mergeStrategy: "merge",
			deleteSourceBranch: true,
			auto: false,
		});

		assert.deepEqual(
			calls.map((call) => sent(call).body.completionOptions),
			[
				{ ...earlier, mergeStrategy: "rebase" },
				{ ...earlier, mergeStrategy: "noFastForward" },
			],
		);
		assert.equal(kept.deleteSourceBranch, true);
	});

	test("sets source branch deletion when asked", async (t) => {
		const { service, calls } = createService(
			t,
			[updated({ status: "completed" })],
			pullRequest({ completionOptions: { deleteSourceBranch: false } }),
		);

		const result = await service.complete(42, {
			mergeStrategy: "squash",
			deleteSourceBranch: true,
			auto: false,
		});

		assert.deepEqual(sent(calls[0]).body.completionOptions, {
			deleteSourceBranch: true,
			mergeStrategy: "squash",
		});
		assert.equal(result.deleteSourceBranch, true);
	});

	test("maps every merge strategy name to Azure's merge strategy", async (t) => {
		const strategies = {
			merge: "noFastForward",
			squash: "squash",
			rebase: "rebase",
			"rebase-merge": "rebaseMerge",
		};
		const { service, calls } = createService(
			t,
			Object.keys(strategies).map(() => updated()),
		);

		for (const mergeStrategy of Object.keys(strategies)) {
			await service.complete(42, {
				mergeStrategy,
				deleteSourceBranch: false,
				auto: false,
			});
		}

		assert.deepEqual(
			calls.map((call) => sent(call).body.completionOptions),
			Object.values(strategies).map((mergeStrategy) => ({ mergeStrategy })),
		);
	});

	test("--auto sets auto-complete for the authenticated user without a status or head", async (t) => {
		const { service, calls, resolved } = createService(
			t,
			[user, updated({ mergeStatus: "conflicts" })],
			pullRequest({ completionOptions: { transitionWorkItems: true } }),
		);

		const result = await service.complete(42, {
			mergeStrategy: "rebase-merge",
			deleteSourceBranch: true,
			auto: true,
		});

		assert.deepEqual(resolved, [42]);
		assert.deepEqual(calls.map(sent), [
			{ method: "GET", url: connectionDataUrl, body: null },
			{
				method: "PATCH",
				url: prUrl,
				body: {
					autoCompleteSetBy: { id: "user-1" },
					completionOptions: {
						transitionWorkItems: true,
						mergeStrategy: "rebaseMerge",
						deleteSourceBranch: true,
					},
				},
			},
		]);
		assert.equal(result.outcome, "autoCompleteSet");
		assert.equal(result.headCommit, null);
	});

	test("Azure accepts the completion when the head sent is its current head", async (t) => {
		const { service, calls } = createService(t, [serverAtHead(head)]);
		const result = await service.complete(42, { ...squash, auto: false });
		assert.equal(result.outcome, "merged");
		assert.deepEqual(sent(calls[0]).body.lastMergeSourceCommit, {
			commitId: head,
		});
	});

	test("makes Azure's rejection of a changed head readable", async (t) => {
		const { service, calls } = createService(t, [serverAtHead(pushedHead)]);

		await assert.rejects(service.complete(42, { ...squash, auto: false }), {
			message: [
				"Azure DevOps rejected completing PR #42 (HTTP 409): TF401192: The source branch has been updated since the pull request was last merged.",
				`Sent head commit ${head}. If the source branch has moved since, review the new commits before completing again.`,
				statusHint,
			].join("\n"),
		});
		assert.deepEqual(sent(calls[0]).body, {
			status: "completed",
			lastMergeSourceCommit: { commitId: head },
			completionOptions: { mergeStrategy: "squash" },
		});
	});

	test("prints Azure's policy rejection with the pr status hint for auto-complete", async (t) => {
		const { service } = createService(t, [
			user,
			rejection(
				400,
				"Bad Request",
				"The merge strategy squash is not allowed by policy.",
			),
		]);

		await assert.rejects(service.complete(42, { ...squash, auto: true }), {
			message: [
				"Azure DevOps rejected setting auto-complete on PR #42 (HTTP 400): The merge strategy squash is not allowed by policy.",
				statusHint,
			].join("\n"),
		});
	});

	test("keeps the whole requester message when Azure gives no message", async (t) => {
		const { service } = createService(t, [
			{ status: 403, statusText: "Forbidden", body: "Access denied" },
		]);

		await assert.rejects(
			service.complete(42, { ...squash, auto: false }),
			(error) => {
				assert.match(
					error.message,
					/^Azure DevOps rejected completing PR #42 \(HTTP 403\): Azure DevOps API request \(PATCH .*\) failed: 403 Forbidden\nAccess denied\n/,
				);
				assert.ok(error.message.endsWith(statusHint));
				return true;
			},
		);
	});

	test("says the request may have been applied after a network failure", async (t) => {
		const completion = createService(t, []);
		const autoComplete = createService(t, [user]);

		await assert.rejects(
			completion.service.complete(42, { ...squash, auto: false }),
			(error) => {
				assert.match(error.message, /network request failed/);
				assert.ok(
					error.message.endsWith(
						"\nThe completion may have been applied. Run `pr.sh pr status --pr 42` before retrying.",
					),
				);
				return true;
			},
		);
		await assert.rejects(
			autoComplete.service.complete(42, { ...squash, auto: true }),
			/\nThe auto-complete may have been applied\. Run `pr\.sh pr status --pr 42` before retrying\.$/,
		);
	});

	test("says the request may have been applied after a server error", async (t) => {
		const { service } = createService(t, [
			{ status: 503, statusText: "Service Unavailable", body: "" },
		]);

		await assert.rejects(
			service.complete(42, { ...squash, auto: false }),
			(error) => {
				assert.match(error.message, /503 Service Unavailable/);
				assert.doesNotMatch(error.message, /rejected/);
				assert.ok(
					error.message.endsWith(
						"\nThe completion may have been applied. Run `pr.sh pr status --pr 42` before retrying.",
					),
				);
				return true;
			},
		);
	});

	test("passes failures that are not Azure request errors through unchanged", async () => {
		const failure = new Error("requester bug");
		const service = createPullRequestCompletionService({
			azure: {
				request: async () => {
					throw failure;
				},
			},
			ctx,
			pullRequests: { resolve: async () => pullRequest() },
		});

		await assert.rejects(
			service.complete(42, { ...squash, auto: false }),
			(error) => error === failure,
		);
	});

	test("reports a merge that fails after the request as an error", async (t) => {
		const { service } = createService(t, [
			updated({
				status: "active",
				mergeStatus: "conflicts",
				mergeFailureMessage: "Merge conflicts in src/widgets.ts.",
			}),
			updated({ status: "active", mergeStatus: "rejectedByPolicy" }),
			updated({ status: "active", mergeStatus: "failure" }),
		]);
		const failure = (mergeStatus, reason) =>
			`Azure DevOps could not merge PR #42 (merge status: ${mergeStatus}): ${reason}\n${statusHint}`;

		await assert.rejects(service.complete(42, { ...squash, auto: false }), {
			message: failure("conflicts", "Merge conflicts in src/widgets.ts."),
		});
		for (const mergeStatus of ["rejectedByPolicy", "failure"]) {
			await assert.rejects(service.complete(42, { ...squash, auto: false }), {
				message: failure(mergeStatus, "Azure gave no reason."),
			});
		}
	});

	test("treats only a completed PR outside queued and notSet as merged", async (t) => {
		const cases = [
			[{ status: "completed", mergeStatus: "succeeded" }, "merged"],
			[{ status: "completed", mergeStatus: undefined }, "merged"],
			[{ status: "completed", mergeStatus: "queued" }, "merging"],
			[{ status: "completed", mergeStatus: "notSet" }, "merging"],
			[{ status: "active", mergeStatus: "succeeded" }, "merging"],
		];
		const { service } = createService(
			t,
			cases.map(([response]) => updated(response)),
		);

		for (const [, outcome] of cases) {
			const result = await service.complete(42, { ...squash, auto: false });
			assert.equal(result.outcome, outcome);
		}
	});

	test("refuses to complete a PR without a source head commit", async (t) => {
		const { service, calls } = createService(
			t,
			[],
			pullRequest({ lastMergeSourceCommit: undefined }),
		);

		await assert.rejects(service.complete(42, { ...squash, auto: false }), {
			message: `PR #42 has no source head commit to complete.\n${statusHint}`,
		});
		assert.equal(calls.length, 0);
	});

	test("formats each outcome", (t) => {
		const { service } = createService(t, []);
		const result = {
			pullRequestId: 42,
			title: "Add widgets",
			headCommit: head,
			mergeStatus: "queued",
			mergeStrategy: "squash",
			deleteSourceBranch: true,
		};

		assert.equal(
			service.format({ ...result, outcome: "merged" }),
			[
				"Completed PR #42: Add widgets",
				`Head commit: ${head}`,
				"Options: merge strategy squash, delete source branch",
				webUrl,
			].join("\n"),
		);
		assert.equal(
			service.format({
				...result,
				outcome: "merging",
				deleteSourceBranch: false,
			}),
			[
				"Requested completion of PR #42: Add widgets",
				`Head commit: ${head}`,
				"Azure DevOps is still merging (merge status: queued). Run `pr.sh pr status --pr 42` to check the result.",
				"Options: merge strategy squash",
				webUrl,
			].join("\n"),
		);
		assert.match(
			service.format({ ...result, outcome: "merging", mergeStatus: null }),
			/\(merge status: unknown\)/,
		);
		assert.equal(
			service.format({
				...result,
				outcome: "autoCompleteSet",
				headCommit: null,
				mergeStrategy: "rebase",
			}),
			[
				"Set auto-complete on PR #42: Add widgets",
				"Azure DevOps completes it once the required policies pass, at whatever head passes them, including later pushes.",
				"Options: merge strategy rebase, delete source branch",
				webUrl,
			].join("\n"),
		);
	});
});
