import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
import { createPullRequestService } from "./pull-requests.ts";
import {
	createPullRequestStateChangeService,
	findVoteName,
	VOTE_NAMES,
	VOTES,
} from "./state-changes.ts";

const ctx = {
	organization: "test-org",
	project: "test-project",
	repository: "test-repository",
};
const repositoryUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository";
const connectionDataUrl =
	"https://dev.azure.com/test-org/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1";

function createService(t, responses, getCurrentBranch) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat: "test-only-fake-pat", fetch });
	const pullRequests = createPullRequestService({
		azure,
		ctx,
		getCurrentBranch:
			getCurrentBranch ??
			(async () => assert.fail("Unexpected current branch lookup")),
	});
	const service = createPullRequestStateChangeService({
		azure,
		ctx,
		pullRequests,
	});
	return { service, calls };
}

function requests(calls) {
	return calls.map(({ method, url, body }) => ({
		method,
		url,
		body: typeof body === "string" ? JSON.parse(body) : body,
	}));
}

describe("votes", () => {
	test("maps each vote name to its Azure value", () => {
		assert.deepEqual(VOTES, {
			approve: 10,
			"approve-with-suggestions": 5,
			wait: -5,
			reject: -10,
			reset: 0,
		});
		assert.deepEqual(VOTE_NAMES, Object.keys(VOTES));
	});

	test("finds vote names case-insensitively", () => {
		assert.equal(
			findVoteName("Approve-With-Suggestions"),
			"approve-with-suggestions",
		);
		assert.equal(findVoteName("maybe"), undefined);
	});

	for (const [name, value] of Object.entries(VOTES)) {
		test(`sends the ${name} vote for the authenticated user`, async (t) => {
			const { service, calls } = createService(t, [
				{ json: { authenticatedUser: { id: "user/id +?#" } } },
				{ json: { id: "user/id +?#", vote: value } },
			]);
			assert.equal(await service.vote(42, name), 42);
			assert.deepEqual(requests(calls), [
				{ method: "GET", url: connectionDataUrl, body: null },
				{
					method: "PUT",
					url: `${repositoryUrl}/pullRequests/42/reviewers/user%2Fid%20%2B%3F%23?api-version=7.1`,
					body: { vote: value },
				},
			]);
		});
	}

	test("votes on the active pull request of the current branch", async (t) => {
		const { service, calls } = createService(
			t,
			[
				{
					json: {
						value: [{ pullRequestId: 7, title: "Branch PR" }],
					},
				},
				{ json: { authenticatedUser: { id: "me" } } },
				{ json: {} },
			],
			async () => "feature/x",
		);
		assert.equal(await service.vote(undefined, "approve"), 7);
		assert.equal(
			calls[2].url,
			`${repositoryUrl}/pullRequests/7/reviewers/me?api-version=7.1`,
		);
	});

	test("includes Azure's status and message in the error", async (t) => {
		const { service } = createService(t, [
			{ json: { authenticatedUser: { id: "me" } } },
			{ status: 403, statusText: "Forbidden", body: "No permission to vote" },
		]);
		await assert.rejects(
			service.vote(42, "reject"),
			/403 Forbidden\nNo permission to vote/,
		);
	});
});

describe("status changes", () => {
	test("abandons an explicit pull request", async (t) => {
		const { service, calls } = createService(t, [{ json: {} }]);
		assert.equal(await service.abandon(42), 42);
		assert.deepEqual(requests(calls), [
			{
				method: "PATCH",
				url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
				body: { status: "abandoned" },
			},
		]);
	});

	test("abandons the active pull request of the current branch", async (t) => {
		const { service, calls } = createService(
			t,
			[
				{ json: { value: [{ pullRequestId: 9, title: "Branch PR" }] } },
				{ json: {} },
			],
			async () => "feature/x",
		);
		assert.equal(await service.abandon(undefined), 9);
		assert.equal(calls[1].method, "PATCH");
		assert.deepEqual(requests(calls)[1].body, { status: "abandoned" });
	});

	test("reactivates a pull request without a branch lookup", async (t) => {
		const { service, calls } = createService(t, [{ json: {} }]);
		assert.equal(await service.reactivate(42), 42);
		assert.deepEqual(requests(calls), [
			{
				method: "PATCH",
				url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
				body: { status: "active" },
			},
		]);
	});

	test("includes Azure's status and message in the error", async (t) => {
		const { service } = createService(t, [
			{
				status: 400,
				statusText: "Bad Request",
				body: "Pull request is completed",
			},
		]);
		await assert.rejects(
			service.reactivate(42),
			/400 Bad Request\nPull request is completed/,
		);
	});
});
