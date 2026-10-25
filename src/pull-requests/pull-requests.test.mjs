import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
import {
	attachmentMarkdownLink,
	createPullRequestService,
	formatReviewerVotes,
	summarizeReviewers,
	removeAttachmentMarkdown,
	validateImagePlaceholders,
} from "./pull-requests.ts";

const ctx = {
	organization: "test-org",
	project: "test-project",
	repository: "test-repository",
};
const pat = "test-only-fake-pat";
const repositoryUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository";
const pullRequestsUrl = `${repositoryUrl}/pullrequests?api-version=7.1`;

function pullRequest(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Test pull request",
		sourceRefName: "refs/heads/feature/test",
		...overrides,
	};
}

function createService(
	t,
	responses = [],
	getCurrentBranch = async () =>
		assert.fail("Unexpected current branch lookup"),
) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const service = createPullRequestService({ azure, ctx, getCurrentBranch });
	return { service, calls };
}

function createTempImage(t, filename, bytes = [0, 255, 16]) {
	const directory = mkdtempSync(join(tmpdir(), "ado-pr-image-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, filename);
	writeFileSync(path, Buffer.from(bytes));
	return path;
}

describe("pull request listing, resolution, creation, and updates", () => {
	test("uploads any file using the shared attachment upload request", async (t) => {
		const path = createTempImage(t, "change.patch", [65, 66]);
		const { service, calls } = createService(t, [
			{
				json: {
					displayName: "review.txt",
					url: "https://files.test/review.txt",
				},
			},
		]);
		assert.deepEqual(await service.attach(42, path, "review.txt"), {
			displayName: "review.txt",
			url: "https://files.test/review.txt",
		});
		assert.equal(calls[0].method, "POST");
		assert.match(calls[0].url, /pullRequests\/42\/attachments\/review.txt/);
		assert.deepEqual(calls[0].body, { encoding: "base64", data: "QUI=" });
	});
	test("rejects an empty attachment name before any request", async (t) => {
		const path = createTempImage(t, "change.patch");
		const { service, calls } = createService(t);
		await assert.rejects(
			service.attach(42, path, ""),
			/--name must not be empty\./,
		);
		assert.equal(calls.length, 0);
	});
	test("escapes brackets and backslashes in attachment Markdown links", () => {
		assert.equal(
			attachmentMarkdownLink({
				displayName: "a\\b]c[.patch",
				url: "https://files.test/x",
			}),
			"[a\\\\b\\]c\\[.patch](<https://files.test/x>)",
		);
	});
	test("adds a rename suggestion to Azure upload rejection details", async (t) => {
		const path = createTempImage(t, "change.patch");
		const { service } = createService(t, [
			{
				status: 400,
				statusText: "Bad Request",
				body: '{"message":"Unsupported file"}',
			},
		]);
		await assert.rejects(
			service.attach(42, path),
			/400 Bad Request[\s\S]*Unsupported file[\s\S]*--name "attachment.txt"/,
		);
	});
	test("does not suggest renaming after an unauthorized upload rejection", async (t) => {
		const path = createTempImage(t, "change.patch");
		const { service } = createService(t, [
			{
				status: 401,
				statusText: "Unauthorized",
				body: '{"message":"Invalid PAT"}',
			},
		]);
		await assert.rejects(service.attach(42, path), (error) => {
			assert.match(error.message, /401 Unauthorized/);
			assert.doesNotMatch(error.message, /Try renaming/);
			return true;
		});
	});
	test("does not suggest renaming after a server upload failure", async (t) => {
		const path = createTempImage(t, "change.patch");
		const { service } = createService(t, [
			{
				status: 500,
				statusText: "Internal Server Error",
				body: '{"message":"Unavailable"}',
			},
		]);
		await assert.rejects(service.attach(42, path), (error) => {
			assert.match(error.message, /500 Internal Server Error/);
			assert.doesNotMatch(error.message, /Try renaming/);
			return true;
		});
	});
	test("lists the current identity's active repository pull requests in response order", async (t) => {
		const expected = [
			pullRequest({ pullRequestId: 91, title: "Second by ID" }),
			pullRequest({ pullRequestId: 12, title: "First by ID" }),
		];
		const { service, calls } = createService(t, [
			{ json: { authenticatedUser: { id: "creator/id +?#" } } },
			{ json: { count: expected.length, value: expected } },
		]);

		assert.deepEqual(await service.list(), expected);
		assert.deepEqual(
			calls.map(({ method, url, body }) => ({ method, url, body })),
			[
				{
					method: "GET",
					url:
						"https://dev.azure.com/test-org/_apis/connectionData?" +
						"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
					body: null,
				},
				{
					method: "GET",
					url:
						`${repositoryUrl}/pullrequests?` +
						"searchCriteria.creatorId=creator%2Fid%20%2B%3F%23&" +
						"searchCriteria.status=active&api-version=7.1",
					body: null,
				},
			],
		);
	});

	test("lists pull requests assigned to the authenticated reviewer for a target branch", async (t) => {
		const expected = [pullRequest({ reviewers: [{ id: "me", vote: 10 }] })];
		const { service, calls } = createService(t, [
			{ json: { authenticatedUser: { id: "reviewer/id" } } },
			{ json: { value: expected } },
		]);

		assert.deepEqual(
			await service.list({ reviewing: true, target: "release/2026" }),
			expected,
		);
		assert.equal(
			calls.at(-1).url,
			`${repositoryUrl}/pullrequests?searchCriteria.reviewerId=reviewer%2Fid&` +
				"searchCriteria.status=active&searchCriteria.targetRefName=refs%2Fheads%2Frelease%2F2026&api-version=7.1",
		);
	});

	test("lists every active pull request without resolving the authenticated identity", async (t) => {
		const expected = [pullRequest()];
		const { service, calls } = createService(t, [
			{ json: { value: expected } },
		]);

		assert.deepEqual(await service.list({ all: true }), expected);
		assert.equal(calls.length, 1);
		assert.equal(
			calls[0].url,
			`${repositoryUrl}/pullrequests?searchCriteria.status=active&api-version=7.1`,
		);
	});

	test("an explicit pull request ID short-circuits without looking up the branch or fetching", async (t) => {
		const { service, calls } = createService(t);

		assert.equal(await service.resolveId(123), 123);
		assert.deepEqual(calls, []);
	});

	test("fetches full pull request details for an explicit ID", async (t) => {
		const expected = pullRequest({
			description: "Review the account validation changes.",
			status: "active",
			isDraft: true,
			targetRefName: "refs/heads/main",
			repository: { id: "repository-id", name: "test-repository" },
			lastMergeCommit: { commitId: "merge-commit-id" },
		});
		const { service, calls } = createService(t, [{ json: expected }]);

		assert.deepEqual(await service.get(42), expected);
		assert.deepEqual(
			calls.map(({ method, url, body }) => ({ method, url, body })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: null,
				},
			],
		);
	});

	test("resolves an explicit ID to full pull request details", async (t) => {
		const expected = pullRequest({
			pullRequestId: 123,
			description: "Explicit PR",
		});
		const { service, calls } = createService(t, [{ json: expected }]);

		assert.deepEqual(await service.resolve(123), expected);
		assert.equal(calls.length, 1);
		assert.equal(
			calls[0].url,
			`${repositoryUrl}/pullRequests/123?api-version=7.1`,
		);
	});

	test("forwards bounded read controls through explicit and branch resolution", async () => {
		const controller = new AbortController();
		const controls = {
			signal: controller.signal,
			timeoutMs: 12_345,
			maxResponseBytes: 54_321,
		};
		const requests = [];
		const branchControls = [];
		const azure = {
			async request(url, options) {
				requests.push({ url, options });
				return url.includes("searchCriteria.sourceRefName")
					? { value: [pullRequest()] }
					: pullRequest();
			},
			async requestWithMetadata() {
				assert.fail("Unexpected metadata request");
			},
		};
		const service = createPullRequestService({
			azure,
			ctx,
			async getCurrentBranch(options) {
				branchControls.push(options);
				return "feature/test";
			},
		});

		await service.resolve(42, controls);
		await service.resolve(undefined, controls);

		assert.equal(requests.length, 3);
		assert.ok(requests.every(({ options }) => options === controls));
		assert.deepEqual(branchControls, [{ signal: controller.signal }]);
	});

	test("turns branch-discovery cancellation into a classified abort", async () => {
		const controller = new AbortController();
		controller.abort(new Error("untrusted abort reason"));
		let azureCalls = 0;
		const service = createPullRequestService({
			azure: {
				async request() {
					azureCalls += 1;
					assert.fail("Unexpected Azure request");
				},
				async requestWithMetadata() {
					assert.fail("Unexpected metadata request");
				},
			},
			ctx,
			async getCurrentBranch({ signal }) {
				assert.equal(signal, controller.signal);
				throw signal.reason;
			},
		});

		await assert.rejects(
			service.resolve(undefined, { signal: controller.signal }),
			(error) => {
				assert.equal(error.kind, "abort");
				assert.doesNotMatch(error.message, /untrusted abort reason/);
				return true;
			},
		);
		assert.equal(azureCalls, 0);
	});

	test("binds explicit and branch-selected IDs to their hydrated responses", async (t) => {
		const explicit = createService(t, [
			{ json: pullRequest({ pullRequestId: 999 }) },
		]);
		await assert.rejects(explicit.service.resolve(123), {
			message:
				"Malformed Azure DevOps response: hydrated pull request ID 999 did not match selected PR #123.",
		});

		const branch = createService(
			t,
			[
				{ json: { value: [pullRequest({ pullRequestId: 74 })] } },
				{ json: pullRequest({ pullRequestId: 75 }) },
			],
			async () => "feature/bound-selection",
		);
		await assert.rejects(branch.service.resolve(undefined), {
			message:
				"Malformed Azure DevOps response: hydrated pull request ID 75 did not match selected PR #74.",
		});
	});

	test("rejects malformed branch-search collections before hydrating a candidate", async (t) => {
		const malformedEnvelope = createService(
			t,
			[{ json: { value: {} } }],
			async () => "feature/malformed-collection",
		);
		await assert.rejects(
			malformedEnvelope.service.findForCurrentBranch(),
			/pull request collection value must be an array/,
		);

		const unsafeId = createService(
			t,
			[
				{
					json: {
						value: [
							pullRequest({ pullRequestId: Number.MAX_SAFE_INTEGER + 1 }),
						],
					},
				},
			],
			async () => "feature/unsafe-id",
		);
		await assert.rejects(
			unsafeId.service.findForCurrentBranch(),
			/pull request collection value\[0\]\.pullRequestId must be a positive safe integer/,
		);
		assert.equal(unsafeId.calls.length, 1);
	});

	test("uses the current branch and URL-encodes its full source ref", async (t) => {
		const { service, calls } = createService(
			t,
			[{ json: { value: [pullRequest({ pullRequestId: 73 })] } }],
			async () => "feature/a+b",
		);

		assert.equal(await service.resolveId(undefined), 73);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "GET");
		assert.equal(
			calls[0].url,
			`${repositoryUrl}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fa%2Bb&searchCriteria.status=active&api-version=7.1`,
		);
		assert.equal(calls[0].body, null);
	});

	test("hydrates branch search results so the full description is returned", async (t) => {
		const candidate = pullRequest({
			pullRequestId: 74,
			description: "Truncated collection description",
		});
		const expected = pullRequest({
			pullRequestId: 74,
			description: "Full description ".repeat(30),
			status: "active",
			isDraft: false,
			targetRefName: "refs/heads/main",
		});
		const { service, calls } = createService(
			t,
			[{ json: { value: [candidate] } }, { json: expected }],
			async () => "feature/show-details",
		);

		assert.deepEqual(await service.resolve(undefined), expected);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fshow-details&searchCriteria.status=active&api-version=7.1`,
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/74?api-version=7.1`,
				},
			],
		);
	});

	test("formats human-readable pull request details and strips branch ref prefixes", (t) => {
		const { service } = createService(t);

		assert.equal(
			service.format(
				pullRequest({
					description: "Line one\n\nLine two",
					status: "active",
					isDraft: true,
					targetRefName: "refs/heads/main",
				}),
			),
			"PR #42: Test pull request\n" +
				"Status: active\n" +
				"Draft: yes\n" +
				"Source: feature/test\n" +
				"Target: main\n" +
				"URL: https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42\n" +
				"Description:\n" +
				"Line one\n\nLine two",
		);
	});

	test("formats missing metadata and an empty description explicitly", (t) => {
		const { service } = createService(t);

		assert.equal(
			service.format(pullRequest({ description: "" })),
			"PR #42: Test pull request\n" +
				"Status: unknown\n" +
				"Draft: unknown\n" +
				"Source: feature/test\n" +
				"Target: unknown\n" +
				"URL: https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42\n" +
				"Description:\n" +
				"(empty)",
		);
	});

	test("formats concise list items with refs, links, and draft state", (t) => {
		const { service } = createService(t);

		assert.equal(
			service.formatListItem(
				pullRequest({
					pullRequestId: 17,
					title: "Draft item",
					isDraft: true,
					sourceRefName: "refs/heads/feature/draft-item",
					targetRefName: "refs/heads/main",
				}),
			),
			"- PR #17: Draft item [draft]\n" +
				"  feature/draft-item -> main\n" +
				"  https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/17",
		);
		assert.equal(
			service.formatListItem(pullRequest({ targetRefName: undefined })),
			"- PR #42: Test pull request\n" +
				"  feature/test -> unknown\n" +
				"  https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
		);
	});

	test("formats every Azure reviewer vote in list items", (t) => {
		const { service } = createService(t);
		const reviewers = [
			{ id: "reject", displayName: "Reject", vote: -10 },
			{ id: "wait", displayName: "Wait", vote: -5 },
			{ id: "none", displayName: "None", vote: 0 },
			{ id: "suggest", displayName: "Suggest", vote: 5 },
			{ id: "approve", displayName: "Approve", vote: 10 },
			{ id: "unknown", displayName: "Unknown", vote: 3 },
		];

		assert.equal(
			service.formatListItem(pullRequest({ reviewers })),
			"- PR #42: Test pull request\n" +
				"  feature/test -> unknown\n" +
				"  Reviewers: Reject: rejected, Wait: waiting for author, None: no vote, " +
				"Suggest: approved with suggestions, Approve: approved, Unknown: vote 3\n" +
				"  https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
		);
	});

	test("formatReviewerVotes labels reviewers by name and tolerates a missing list", () => {
		assert.deepEqual(formatReviewerVotes(undefined), []);
		assert.deepEqual(
			formatReviewerVotes([
				{ id: "a", displayName: "Ada", vote: 10 },
				{ id: "b", uniqueName: "bob@example.test" },
				{ id: "c" },
			]),
			["Ada: approved", "bob@example.test: no vote", "c: no vote"],
		);
	});

	test("summarizeReviewers reports the vote, its label and the required flag", () => {
		assert.deepEqual(summarizeReviewers(undefined), []);
		assert.deepEqual(
			summarizeReviewers([
				{ id: "a", displayName: "Ada", vote: -10, isRequired: true },
				{ id: "b", uniqueName: "bob@example.test", isRequired: false },
				{ id: "c", vote: 3 },
			]),
			[
				{ name: "Ada", vote: -10, voteLabel: "rejected", required: true },
				{
					name: "bob@example.test",
					vote: 0,
					voteLabel: "no vote",
					required: false,
				},
				{ name: "c", vote: 3, voteLabel: "vote 3", required: false },
			],
		);
	});

	test("reports when the current branch has no active pull request", async (t) => {
		const { service, calls } = createService(
			t,
			[{ json: { value: [] } }],
			async () => "feature/missing",
		);

		await assert.rejects(service.resolveId(undefined), {
			message:
				'No active pull request found for branch "feature/missing" in test-org/test-project/test-repository.',
		});

		assert.equal(calls.length, 1);
	});

	test("reports every candidate when the current branch has multiple active pull requests", async (t) => {
		const { service, calls } = createService(
			t,
			[
				{
					json: {
						value: [
							pullRequest({ pullRequestId: 10, title: "First candidate" }),
							pullRequest({ pullRequestId: 20, title: "Second candidate" }),
						],
					},
				},
			],
			async () => "feature/ambiguous",
		);

		await assert.rejects(service.resolveId(undefined), {
			message:
				'Multiple active pull requests found for branch "feature/ambiguous"; pass --pr <id> to disambiguate:\n' +
				"  #10: First candidate\n" +
				"  #20: Second candidate",
		});

		assert.equal(calls.length, 1);
	});

	test("updates only the pull request description", async (t) => {
		const updated = pullRequest({ description: "Updated description" });
		const { service, calls } = createService(t, [{ json: updated }]);

		assert.deepEqual(
			await service.update(42, { description: "Updated description" }),
			updated,
		);
		assert.deepEqual(
			calls.map(({ method, url, body }) => ({
				method,
				url,
				body: JSON.parse(body),
			})),
			[
				{
					method: "PATCH",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: { description: "Updated description" },
				},
			],
		);
	});

	test("sends an explicitly empty description so an existing description can be cleared", async (t) => {
		const updated = pullRequest({ description: "" });
		const { service, calls } = createService(t, [{ json: updated }]);

		assert.deepEqual(await service.update(42, { description: "" }), updated);
		assert.deepEqual(JSON.parse(calls[0].body), { description: "" });
	});

	test("marks a pull request as draft without sending description", async (t) => {
		const updated = pullRequest({ isDraft: true });
		const { service, calls } = createService(t, [{ json: updated }]);

		assert.deepEqual(await service.update(42, { draft: true }), updated);
		assert.deepEqual(JSON.parse(calls[0].body), { isDraft: true });
	});

	test("updates description and draft state in one request", async (t) => {
		const updated = pullRequest({
			description: "Work in progress",
			isDraft: true,
		});
		const { service, calls } = createService(t, [{ json: updated }]);

		assert.deepEqual(
			await service.update(42, {
				description: "Work in progress",
				draft: true,
			}),
			updated,
		);
		assert.deepEqual(JSON.parse(calls[0].body), {
			description: "Work in progress",
			isDraft: true,
		});
	});

	test("accepts a 4,000-character description and rejects 4,001 before a request", async (t) => {
		const boundaryDescription = "x".repeat(4_000);
		const accepted = createService(t, [
			{ json: pullRequest({ description: boundaryDescription }) },
		]);

		await accepted.service.update(42, { description: boundaryDescription });
		assert.equal(JSON.parse(accepted.calls[0].body).description.length, 4_000);

		const rejected = createService(t);
		await assert.rejects(
			rejected.service.update(42, { description: "x".repeat(4_001) }),
			{
				message:
					"Pull request description exceeds Azure DevOps' 4,000-character limit (received 4001 characters).",
			},
		);
		assert.deepEqual(rejected.calls, []);
	});

	test("rejects an update without fields before making a request", async (t) => {
		const { service, calls } = createService(t);

		await assert.rejects(service.update(42, {}), {
			message: "At least one pull request field is required for an update.",
		});
		assert.deepEqual(calls, []);
	});

	test("creates from explicit source and target branches while normalizing only plain refs", async (t) => {
		const created = pullRequest({ pullRequestId: 88 });
		const { service, calls } = createService(t, [{ json: created }]);

		assert.deepEqual(
			await service.create({
				title: "Release fix",
				description: "Ready to merge",
				sourceBranch: "feature/release-fix",
				targetBranch: "refs/heads/release/2026",
				draft: false,
			}),
			created,
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, pullRequestsUrl);
		assert.equal(calls[0].method, "POST");
		assert.deepEqual(JSON.parse(calls[0].body), {
			sourceRefName: "refs/heads/feature/release-fix",
			targetRefName: "refs/heads/release/2026",
			title: "Release fix",
			description: "Ready to merge",
			isDraft: false,
		});
	});

	test("resolves the current source and default target before posting the creation request", async (t) => {
		const created = pullRequest({ pullRequestId: 91 });
		const { service, calls } = createService(
			t,
			[{ json: { defaultBranch: "refs/heads/main" } }, { json: created }],
			async () => "feature/from-git",
		);

		assert.deepEqual(
			await service.create({
				title: "Detected branches",
				draft: false,
			}),
			created,
		);

		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{ method: "GET", url: `${repositoryUrl}?api-version=7.1` },
				{ method: "POST", url: pullRequestsUrl },
			],
		);
		assert.deepEqual(JSON.parse(calls[1].body), {
			sourceRefName: "refs/heads/feature/from-git",
			targetRefName: "refs/heads/main",
			title: "Detected branches",
			description: "",
			isDraft: false,
		});
	});

	test("does not post when the repository has no default branch", async (t) => {
		const { service, calls } = createService(t, [{ json: {} }]);

		await assert.rejects(
			service.create({
				title: "Cannot target",
				sourceBranch: "feature/known-source",
				draft: false,
			}),
			{
				message:
					"Could not determine the default branch for test-org/test-project/test-repository; pass --target explicitly.",
			},
		);

		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[{ method: "GET", url: `${repositoryUrl}?api-version=7.1` }],
		);
	});

	test("rejects an over-limit create description before any Azure request", async (t) => {
		const { service, calls } = createService(t);

		await assert.rejects(
			service.create({
				title: "Too much detail",
				description: "x".repeat(4_001),
				sourceBranch: "feature/known",
				targetBranch: "main",
				draft: false,
			}),
			{
				message:
					"Pull request description exceeds Azure DevOps' 4,000-character limit (received 4001 characters).",
			},
		);
		assert.deepEqual(calls, []);
	});

	test("sends an empty description and the requested draft state", async (t) => {
		const { service, calls } = createService(t, [{ json: pullRequest() }]);

		await service.create({
			title: "Draft without description",
			sourceBranch: "refs/heads/feature/draft",
			targetBranch: "main",
			draft: true,
		});

		assert.equal(calls.length, 1);
		assert.deepEqual(JSON.parse(calls[0].body), {
			sourceRefName: "refs/heads/feature/draft",
			targetRefName: "refs/heads/main",
			title: "Draft without description",
			description: "",
			isDraft: true,
		});
	});

	test("checks a newly created PR for attachment collisions before its first image upload", async (t) => {
		const path = createTempImage(t, "flow.png");
		const created = pullRequest({ pullRequestId: 93 });
		const { service, calls } = createService(t, [
			{ json: created },
			{
				json: {
					value: [
						{
							displayName: "flow.png",
							url: "https://attachments.test/existing.png",
						},
					],
				},
			},
		]);

		await assert.rejects(
			service.create({
				title: "Collision",
				description: "{{image:flow.png}}",
				sourceBranch: "feature/collision",
				targetBranch: "main",
				draft: false,
				images: [path],
			}),
			/Cannot upload attachment filename "flow\.png" because it already exists on PR #93/,
		);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{ method: "POST", url: pullRequestsUrl },
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/93/attachments?api-version=7.1`,
				},
			],
		);
	});

	test("validates exact image placeholder sets while allowing repeated matching instances", () => {
		assert.doesNotThrow(() =>
			validateImagePlaceholders(
				"First {{image:flow.png}} and again {{image:flow.png}} plus {{image:arch.png}}",
				[{ filename: "flow.png" }, { filename: "arch.png" }],
			),
		);
		assert.throws(
			() =>
				validateImagePlaceholders("Only {{image:other.png}}", [
					{ filename: "flow.png" },
				]),
			{
				message:
					"Image placeholder mismatch: missing {{image:flow.png}} for --image flow.png; no --image was supplied for {{image:other.png}}.",
			},
		);
		assert.throws(() => validateImagePlaceholders("{{image:orphan.png}}", []), {
			message:
				"Image placeholder mismatch: no --image was supplied for {{image:orphan.png}}.",
		});
	});

	test("removes repeated marked references and preserves unmarked text inside and outside code", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/flow.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const marked = `${image}<!-- ado-pr-image:flow.png -->`;

		assert.equal(
			removeAttachmentMarkdown(
				`Remove ${marked} keep ${image} and \`${image}\`; remove ${marked}`,
				attachment,
			),
			`Remove  keep ${image} and \`${image}\`; remove `,
		);
	});

	test("preserves custom, malformed, nested, and edited-marker references", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/actual.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const description =
			`${image} ` +
			`${image}<!-- ado-pr-image:edited.png --> ` +
			`![custom](<${attachment.url}>)<!-- ado-pr-image:flow.png --> ` +
			`![outer [flow.png]](<${attachment.url}>) ` +
			`![flow.png](${attachment.url}) ` +
			`![flow.png](<${attachment.url}>`;

		assert.equal(
			removeAttachmentMarkdown(description, attachment),
			description,
		);
	});

	test("strictly encodes escaped filenames in ownership markers", () => {
		const attachment = {
			displayName: "flow[1]-->.png",
			url: "https://example.test/a_(1).png?x=1&y=2",
		};
		const marked =
			`![flow\\[1\\]-->.png](<${attachment.url}>)` +
			"<!-- ado-pr-image:flow%5B1%5D%2D%2D%3E.png -->";

		assert.equal(
			removeAttachmentMarkdown(`Before ${marked} after`, attachment),
			"Before  after",
		);
		assert.equal(
			marked.slice(marked.indexOf("<!--")),
			"<!-- ado-pr-image:flow%5B1%5D%2D%2D%3E.png -->",
		);
	});

	test("handles long marked and unmarked input in linear work", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/long.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const marked = `${image}<!-- ado-pr-image:flow.png -->`;
		const unmarked = image.repeat(5_000);
		const malformed = `![${"\\".repeat(200_000)} without a closing bracket`;

		assert.equal(
			removeAttachmentMarkdown(
				`${unmarked} ${malformed} ${marked.repeat(5_000)}`,
				attachment,
			),
			`${unmarked} ${malformed} `,
		);
	});

	test("adds an image using the current full description and escapes its Markdown alt text", async (t) => {
		const path = createTempImage(t, "flow[1].png", [0, 255, 16, 32]);
		const attachmentUrl = "https://attachments.test/flow(1).png?token=x";
		const current = pullRequest({ description: "Flow {{image:flow[1].png}}" });
		const updated = pullRequest({
			description:
				`Flow ![flow\\[1\\].png](<${attachmentUrl}>)` +
				"<!-- ado-pr-image:flow%5B1%5D.png -->",
		});
		const { service, calls } = createService(t, [
			{ json: current },
			{ json: { value: [] } },
			{ json: { displayName: "flow[1].png", url: attachmentUrl } },
			{ json: updated },
		]);

		assert.equal(await service.edit(42, { images: [path] }), 42);
		assert.deepEqual(
			calls.map(({ method, url, body }) => ({ method, url, body })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: null,
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/attachments?api-version=7.1`,
					body: null,
				},
				{
					method: "POST",
					url: `${repositoryUrl}/pullRequests/42/attachments/flow%5B1%5D.png?api-version=7.1`,
					body: { encoding: "base64", data: "AP8QIA==" },
				},
				{
					method: "PATCH",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: JSON.stringify({ description: updated.description }),
				},
			],
		);
	});

	test("rejects an over-limit description without removals before attachment mutation", async (t) => {
		const path = createTempImage(t, "flow.png");
		const { service, calls } = createService(t, [
			{
				json: pullRequest({
					description: `${"x".repeat(4_001)}{{image:flow.png}}`,
				}),
			},
		]);

		await assert.rejects(service.edit(42, { images: [path] }), {
			message:
				"Pull request description exceeds Azure DevOps' 4,000-character limit (received 4019 characters).",
		});
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
				},
			],
		);
	});

	test("cleans up its uploaded attachment when generated Markdown exceeds the limit", async (t) => {
		const path = createTempImage(t, "flow.png");
		const placeholder = "{{image:flow.png}}";
		const description = `${"x".repeat(4_000 - placeholder.length)}${placeholder}`;
		const attachmentUrl =
			"https://attachments.test/flow.png?token=generated-overflow";
		const generatedLength =
			4_000 -
			placeholder.length +
			`![flow.png](<${attachmentUrl}>)<!-- ado-pr-image:flow.png -->`.length;
		const { service, calls } = createService(t, [
			{ json: { value: [] } },
			{ json: { displayName: "flow.png", url: attachmentUrl } },
			{ status: 204 },
		]);

		await assert.rejects(service.edit(42, { description, images: [path] }), {
			message:
				`Generated pull request description exceeds Azure DevOps' 4,000-character limit (received ${generatedLength} characters).\n` +
				"PR #42 was not updated; successfully uploaded attachments were cleaned up where safe.",
		});
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/attachments?api-version=7.1`,
				},
				{
					method: "POST",
					url: `${repositoryUrl}/pullRequests/42/attachments/flow.png?api-version=7.1`,
				},
				{
					method: "DELETE",
					url: `${repositoryUrl}/pullRequests/42/attachments/flow.png?api-version=7.1`,
				},
			],
		);
	});

	test("applies the final length limit after combined removals and placeholder expansion", async (t) => {
		const path = createTempImage(t, "new.png");
		const oldUrl = "https://attachments.test/old.png?token=old";
		const newUrl = "https://attachments.test/new.png?token=new";
		const oldMarked = `![old.png](<${oldUrl}>)<!-- ado-pr-image:old.png -->`;
		const newMarked = `![new.png](<${newUrl}>)<!-- ado-pr-image:new.png -->`;
		const placeholder = "{{image:new.png}}";
		const finalDescription = `${"x".repeat(4_000 - newMarked.length)}${newMarked}`;
		const intermediateDescription = `${"x".repeat(4_000 - newMarked.length)}${oldMarked}${placeholder}`;
		assert.ok(
			intermediateDescription.replace(placeholder, newMarked).length > 4_000,
		);

		const { service, calls } = createService(t, [
			{ json: { value: [{ displayName: "old.png", url: oldUrl }] } },
			{ json: { displayName: "new.png", url: newUrl } },
			{ json: pullRequest({ description: finalDescription }) },
			{ status: 204 },
		]);

		assert.equal(
			await service.edit(42, {
				description: intermediateDescription,
				images: [path],
				removeImages: ["old.png"],
			}),
			42,
		);
		assert.deepEqual(
			calls.map(({ method, body }) => ({ method, body })),
			[
				{ method: "GET", body: null },
				{ method: "POST", body: { encoding: "base64", data: "AP8Q" } },
				{
					method: "PATCH",
					body: JSON.stringify({ description: finalDescription }),
				},
				{ method: "DELETE", body: null },
			],
		);
	});

	test("rejects every existing upload basename before any edit mutation", async (t) => {
		const newImage = createTempImage(t, "new.png");
		const flow = createTempImage(t, "flow.png");
		const architecture = createTempImage(t, "architecture.png");
		const { service, calls } = createService(t, [
			{
				json: {
					value: [
						{
							displayName: "flow.png",
							url: "https://attachments.test/flow.png",
						},
						{
							displayName: "architecture.png",
							url: "https://attachments.test/architecture.png",
						},
					],
				},
			},
		]);

		await assert.rejects(
			service.edit(42, {
				description:
					"{{image:new.png}} {{image:flow.png}} {{image:architecture.png}}",
				images: [newImage, flow, architecture],
			}),
			{
				message:
					'Cannot upload attachment filenames "flow.png", "architecture.png" because they already exist on PR #42. ' +
					"Attachment filename collisions are case-sensitive; remove existing attachments in a separate command because replacement is not supported.",
			},
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "GET");
	});

	test("allows a case-distinct upload basename under Azure displayName semantics", async (t) => {
		const path = createTempImage(t, "flow.png");
		const attachmentUrl = "https://attachments.test/new-flow.png";
		const { service, calls } = createService(t, [
			{
				json: {
					value: [
						{
							displayName: "Flow.png",
							url: "https://attachments.test/existing.png",
						},
					],
				},
			},
			{ json: { displayName: "flow.png", url: attachmentUrl } },
			{
				json: pullRequest({
					description: `![flow.png](<${attachmentUrl}>)<!-- ado-pr-image:flow.png -->`,
				}),
			},
		]);

		assert.equal(
			await service.edit(42, {
				description: "{{image:flow.png}}",
				images: [path],
			}),
			42,
		);
		assert.deepEqual(
			calls.map(({ method }) => method),
			["GET", "POST", "PATCH"],
		);
	});

	test("does not mask generated overflow when cleanup also fails", async (t) => {
		const path = createTempImage(t, "flow.png");
		const placeholder = "{{image:flow.png}}";
		const description = `${"x".repeat(4_000 - placeholder.length)}${placeholder}`;
		const attachmentUrl = "https://attachments.test/cleanup-failure.png";
		const { service, calls } = createService(t, [
			{ json: { value: [] } },
			{ json: { displayName: "flow.png", url: attachmentUrl } },
			{ status: 503, statusText: "Service Unavailable", body: "delete failed" },
		]);

		await assert.rejects(
			service.edit(42, { description, images: [path] }),
			(error) => {
				assert.match(
					error.message,
					/^Generated pull request description exceeds Azure DevOps' 4,000-character limit/,
				);
				assert.match(error.message, /cleanup failed for "flow\.png"/);
				assert.match(error.message, /503 Service Unavailable/);
				return true;
			},
		);
		assert.deepEqual(
			calls.map(({ method }) => method),
			["GET", "POST", "DELETE"],
		);
	});

	test("cleans up earlier uploads when a later upload fails", async (t) => {
		const first = createTempImage(t, "first.png", [1]);
		const second = createTempImage(t, "second.png", [2]);
		const firstUrl = "https://attachments.test/first.png";
		const { service, calls } = createService(t, [
			{ json: { value: [] } },
			{ json: { displayName: "first.png", url: firstUrl } },
			{ status: 503, statusText: "Service Unavailable", body: "upload failed" },
			{ status: 204 },
		]);

		await assert.rejects(
			service.edit(42, {
				description: "{{image:first.png}} {{image:second.png}}",
				images: [first, second],
			}),
			/Azure DevOps API request .* failed: 503 Service Unavailable[\s\S]*PR #42 was not updated/,
		);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/attachments?api-version=7.1`,
				},
				{
					method: "POST",
					url: `${repositoryUrl}/pullRequests/42/attachments/first.png?api-version=7.1`,
				},
				{
					method: "POST",
					url: `${repositoryUrl}/pullRequests/42/attachments/second.png?api-version=7.1`,
				},
				{
					method: "DELETE",
					url: `${repositoryUrl}/pullRequests/42/attachments/first.png?api-version=7.1`,
				},
			],
		);
	});

	test("does not clean up an upload after an uncertain description PATCH failure", async (t) => {
		const path = createTempImage(t, "flow.png");
		const attachmentUrl = "https://attachments.test/flow.png";
		const { service, calls } = createService(t, [
			{ json: { value: [] } },
			{ json: { displayName: "flow.png", url: attachmentUrl } },
			{ status: 503, statusText: "Service Unavailable", body: "patch failed" },
		]);

		await assert.rejects(
			service.edit(42, { description: "{{image:flow.png}}", images: [path] }),
			/The PR update outcome is uncertain\. Newly uploaded attachments were left in place/,
		);
		assert.deepEqual(
			calls.map(({ method }) => method),
			["GET", "POST", "PATCH"],
		);
	});

	test("rejects duplicate image basenames before any Azure request", async (t) => {
		const first = createTempImage(t, "same.png", [1]);
		const second = createTempImage(t, "same.png", [2]);
		const { service, calls } = createService(t);

		await assert.rejects(service.edit(42, { images: [first, second] }), {
			message: 'Duplicate image basename "same.png".',
		});
		assert.deepEqual(calls, []);
	});

	test("rejects adding and removing the same image filename before any Azure request", async (t) => {
		const path = createTempImage(t, "same.png", [1]);
		const { service, calls } = createService(t);

		await assert.rejects(
			service.edit(42, { images: [path], removeImages: ["same.png"] }),
			{
				message: 'Cannot add and remove image "same.png" in the same command.',
			},
		);
		assert.deepEqual(calls, []);
	});

	test("requires one exact attachment match before any edit mutation", async (t) => {
		const { service, calls } = createService(t, [{ json: { value: [] } }]);

		await assert.rejects(
			service.edit(42, {
				description: "Replacement",
				removeImages: ["missing.png"],
			}),
			{ message: 'Attachment "missing.png" was not found on PR #42.' },
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "GET");
		assert.match(calls[0].url, /\/attachments\?api-version=7\.1$/);
	});

	test("rejects ambiguous exact attachment matches before any edit mutation", async (t) => {
		const attachment = {
			displayName: "duplicate.png",
			url: "https://attachments.test/one",
		};
		const { service, calls } = createService(t, [
			{
				json: {
					value: [
						attachment,
						{ ...attachment, url: "https://attachments.test/two" },
					],
				},
			},
		]);

		await assert.rejects(
			service.edit(42, {
				description: "Replacement",
				removeImages: ["duplicate.png"],
			}),
			{ message: 'Attachment "duplicate.png" is ambiguous on PR #42.' },
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "GET");
	});

	test("fetches the current description, patches exact references, then deletes the attachment", async (t) => {
		const url = "https://attachments.test/remove.png?token=exact";
		const { service, calls } = createService(t, [
			{
				json: pullRequest({
					description:
						`Before ![remove.png](<${url}>)` +
						"<!-- ado-pr-image:remove.png --> After",
				}),
			},
			{ json: { value: [{ displayName: "remove.png", url }] } },
			{ json: pullRequest({ description: "Before  After" }) },
			{ status: 204 },
		]);

		assert.equal(await service.edit(42, { removeImages: ["remove.png"] }), 42);
		assert.deepEqual(
			calls.map(({ method, url: requestUrl, body }) => ({
				method,
				url: requestUrl,
				body,
			})),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: null,
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/attachments?api-version=7.1`,
					body: null,
				},
				{
					method: "PATCH",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
					body: JSON.stringify({ description: "Before  After" }),
				},
				{
					method: "DELETE",
					url: `${repositoryUrl}/pullRequests/42/attachments/remove.png?api-version=7.1`,
					body: null,
				},
			],
		);
	});

	test("intentionally leaves a custom-edited reference unchanged when deleting its attachment", async (t) => {
		const url = "https://attachments.test/custom.png";
		const description = `Keep ![custom label](<${url}>)`;
		const { service, calls } = createService(t, [
			{ json: pullRequest({ description }) },
			{ json: { value: [{ displayName: "custom.png", url }] } },
			{ status: 204 },
		]);

		assert.equal(await service.edit(42, { removeImages: ["custom.png"] }), 42);
		assert.deepEqual(
			calls.map(({ method, url: requestUrl }) => ({ method, url: requestUrl })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/attachments?api-version=7.1`,
				},
				{
					method: "DELETE",
					url: `${repositoryUrl}/pullRequests/42/attachments/custom.png?api-version=7.1`,
				},
			],
		);
	});

	test("resolves an active reviewer by exact Account property and uses the dedicated endpoint", async (t) => {
		const { service, calls } = createService(t, [
			{
				json: {
					value: [
						{
							id: "reviewer/id +?#",
							providerDisplayName: "Ada Lovelace",
							isActive: true,
							properties: { Account: { $value: "ada@example.test" } },
						},
						{
							id: "inactive",
							providerDisplayName: "ada@example.test",
							isActive: false,
						},
					],
				},
			},
			{ json: { value: [] } },
			{ body: "" },
		]);

		assert.equal(
			await service.edit(42, { reviewers: ["ADA@EXAMPLE.TEST"] }),
			42,
		);
		assert.deepEqual(
			calls.map(({ method, url, body }) => ({ method, url, body })),
			[
				{
					method: "GET",
					url:
						"https://vssps.dev.azure.com/test-org/_apis/identities?" +
						"searchFilter=General&filterValue=ADA%40EXAMPLE.TEST&queryMembership=None&api-version=7.1",
					body: null,
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/reviewers?api-version=7.1`,
					body: null,
				},
				{
					method: "PUT",
					url:
						`${repositoryUrl}/pullRequests/42/reviewers/` +
						"reviewer%2Fid%20%2B%3F%23?api-version=7.1",
					body: JSON.stringify({ id: "reviewer/id +?#", vote: 0 }),
				},
			],
		);
	});

	test("does not reset the vote when adding an existing reviewer", async (t) => {
		const identity = {
			id: "existing-reviewer",
			providerDisplayName: "Ada Lovelace",
			isActive: true,
		};
		const { service, calls } = createService(t, [
			{ json: { value: [identity] } },
			{
				json: {
					value: [
						{
							id: "EXISTING-REVIEWER",
							displayName: "Ada Lovelace",
							uniqueName: "ada@example.test",
							vote: 10,
						},
					],
				},
			},
		]);

		assert.equal(await service.edit(42, { reviewers: ["Ada Lovelace"] }), 42);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url:
						"https://vssps.dev.azure.com/test-org/_apis/identities?" +
						"searchFilter=General&filterValue=Ada%20Lovelace&queryMembership=None&api-version=7.1",
				},
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/reviewers?api-version=7.1`,
				},
			],
		);
	});

	test("accepts an exact case-insensitive custom display name and prefers it in labels", async (t) => {
		const identity = {
			id: "custom-reviewer",
			customDisplayName: "Ada Team Alias",
			providerDisplayName: "Provider Name",
			isActive: true,
		};
		const { service, calls } = createService(t, [
			{ json: { value: [identity] } },
			{ json: { value: [] } },
			{ body: "" },
		]);

		assert.equal(await service.edit(42, { reviewers: ["ADA TEAM ALIAS"] }), 42);
		assert.deepEqual(
			calls.map(({ method }) => method),
			["GET", "GET", "PUT"],
		);

		const ambiguous = createService(t, [
			{
				json: {
					value: [identity, { ...identity, id: "other-reviewer" }],
				},
			},
		]);
		await assert.rejects(
			ambiguous.service.edit(42, { reviewers: ["ada team alias"] }),
			{
				message:
					'Reviewer "ada team alias" is ambiguous; exact matches were:\n' +
					"  Ada Team Alias (custom-reviewer)\n" +
					"  Ada Team Alias (other-reviewer)",
			},
		);
	});

	test("rejects zero and ambiguous exact active reviewer matches", async (t) => {
		const zero = createService(t, [
			{
				json: {
					value: [
						{ id: "inactive", providerDisplayName: "Ada", isActive: false },
						{
							id: "partial",
							providerDisplayName: "Ada Example",
							isActive: true,
						},
					],
				},
			},
		]);
		await assert.rejects(zero.service.edit(42, { reviewers: ["Ada"] }), {
			message:
				'No active Azure DevOps identity exactly matched reviewer "Ada" by custom display name, display name, account, or mail.',
		});

		const ambiguous = createService(t, [
			{
				json: {
					value: [
						{ id: "one", providerDisplayName: "Ada", isActive: true },
						{ id: "two", providerDisplayName: "ADA", isActive: true },
					],
				},
			},
		]);
		await assert.rejects(
			ambiguous.service.edit(42, { reviewers: ["ada"] }),
			/Reviewer "ada" is ambiguous; exact matches were:/,
		);
	});

	test("removes an inactive current reviewer without an identity lookup", async (t) => {
		const { service, calls } = createService(t, [
			{
				json: {
					value: [
						{
							id: "inactive/id",
							displayName: "Former Reviewer",
							uniqueName: "former@example.test",
							inactive: true,
							vote: 10,
						},
					],
				},
			},
			{ status: 204 },
		]);

		assert.equal(
			await service.edit(42, { removeReviewers: ["FORMER@EXAMPLE.TEST"] }),
			42,
		);
		assert.deepEqual(
			calls.map(({ method, url }) => ({ method, url })),
			[
				{
					method: "GET",
					url: `${repositoryUrl}/pullRequests/42/reviewers?api-version=7.1`,
				},
				{
					method: "DELETE",
					url: `${repositoryUrl}/pullRequests/42/reviewers/inactive%2Fid?api-version=7.1`,
				},
			],
		);
	});

	test("rejects zero and ambiguous current reviewer removal matches before mutation", async (t) => {
		const zero = createService(t, [{ json: { value: [] } }]);
		await assert.rejects(
			zero.service.edit(42, { removeReviewers: ["Missing"] }),
			{
				message:
					'No current reviewer exactly matched "Missing" by display name or unique name on PR #42.',
			},
		);
		assert.ok(zero.calls.every((call) => call.method === "GET"));

		const ambiguous = createService(t, [
			{
				json: {
					value: [
						{ id: "one", displayName: "Ada", uniqueName: "one@example.test" },
						{ id: "two", displayName: "ADA", uniqueName: "two@example.test" },
					],
				},
			},
		]);
		await assert.rejects(
			ambiguous.service.edit(42, { removeReviewers: ["ada"] }),
			/Current reviewer "ada" is ambiguous on PR #42; exact matches were:/,
		);
		assert.ok(ambiguous.calls.every((call) => call.method === "GET"));
	});

	test("rejects the same resolved reviewer in add and remove sets before mutation", async (t) => {
		const identity = { id: "same", providerDisplayName: "Ada", isActive: true };
		const { service, calls } = createService(t, [
			{ json: { value: [identity] } },
			{
				json: {
					value: [
						{
							id: "same",
							displayName: "ADA",
							uniqueName: "ada@example.test",
							vote: 5,
						},
					],
				},
			},
		]);

		await assert.rejects(
			service.edit(42, { reviewers: ["Ada"], removeReviewers: ["ada"] }),
			{
				message:
					"Cannot add and remove reviewer Ada (same) in the same command.",
			},
		);
		assert.equal(calls.length, 2);
		assert.ok(calls.every((call) => call.method === "GET"));
	});
});
