import assert from "node:assert/strict";
import test from "node:test";

import { createAzureRequester } from "../shared/azure.ts";
import { createFileAnchorService } from "./file-anchors.ts";
import { countUnresolvedThreads, createThreadService } from "./threads.ts";
import { createMockFetch } from "../../tests/test-helpers.mjs";

const ctx = {
	organization: "my org",
	project: "Project/A",
	repository: "repo #1",
};
const prId = 42;
const pat = "test-pat";
const apiBase =
	"https://dev.azure.com/my%20org/Project%2FA/_apis/git/repositories/repo%20%231/pullRequests/42";
const webBase =
	"https://dev.azure.com/my%20org/Project%2FA/_git/repo%20%231/pullrequest/42";

function textComment(
	id,
	content,
	author = { id: `user-${id}`, displayName: `User ${id}` },
) {
	return { id, content, author };
}

function thread(id, overrides = {}) {
	return {
		id,
		status: "active",
		comments: [textComment(id, `comment ${id}`)],
		...overrides,
	};
}

function requestShapes(calls) {
	return calls.map(({ url, method, body }) => ({
		url,
		method,
		body: body === null ? null : JSON.parse(body),
	}));
}

function createServices(t, responses = []) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const fileAnchors = createFileAnchorService({ azure, ctx });
	const threads = createThreadService({ azure, ctx, fileAnchors });
	return { calls, fileAnchors, threads };
}

test.describe("threads", () => {
	test("list removes deleted threads/comments and threads without real comments", async (t) => {
		const relevant = thread(5, {
			comments: [
				{ id: 50, content: "build event", commentType: "system" },
				textComment(51, "  useful review  "),
			],
		});
		const { calls, threads } = createServices(t, [
			{
				json: {
					value: [
						thread(1, { isDeleted: true }),
						thread(2, { comments: [] }),
						thread(3, {
							comments: [{ id: 30, content: "system", commentType: "system" }],
						}),
						thread(4, { comments: [textComment(40, "   ")] }),
						thread(6, {
							comments: [{ ...textComment(60, "deleted"), isDeleted: true }],
						}),
						relevant,
					],
				},
			},
		]);

		const result = await threads.list(prId, {
			excludeResolved: false,
			excludeOwn: false,
		});

		assert.deepEqual(result, [relevant]);
		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads?api-version=7.1`,
				method: "GET",
				body: null,
			},
		]);
	});

	test("listAll returns system and deleted threads unfiltered", async (t) => {
		const system = thread(2, {
			comments: [
				{
					id: 20,
					content: "Copilot code review completed",
					commentType: "system",
				},
			],
		});
		const all = [thread(1, { isDeleted: true }), system];
		const { calls, threads } = createServices(t, [{ json: { value: all } }]);
		assert.deepEqual(await threads.listAll(prId), all);
		assert.equal(calls[0].url, `${apiBase}/threads?api-version=7.1`);
	});

	test("countUnresolvedThreads counts active, pending and status-less review threads", () => {
		const system = { id: 9, content: "Policy updated", commentType: "system" };
		assert.equal(
			countUnresolvedThreads([
				thread(1),
				thread(2, { status: "pending" }),
				thread(3, { status: undefined }),
				thread(4, { status: "fixed" }),
				thread(5, { status: "closed" }),
				thread(6, { isDeleted: true }),
				thread(7, { comments: [system] }),
			]),
			3,
		);
	});

	test("list keeps only active, pending, and status-less threads when excluding resolved", async (t) => {
		const active = thread(1);
		const pending = thread(2, { status: "pending" });
		const statusLess = thread(3);
		delete statusLess.status;
		const { calls, threads } = createServices(t, [
			{
				json: {
					value: [
						active,
						pending,
						statusLess,
						thread(4, { status: "fixed" }),
						thread(5, { status: "closed" }),
					],
				},
			},
		]);

		const result = await threads.list(prId, {
			excludeResolved: true,
			excludeOwn: false,
		});

		assert.deepEqual(result, [active, pending, statusLess]);
		assert.equal(
			calls.length,
			1,
			"identity lookup stays lazy when --exclude-own is disabled",
		);
	});

	test("list excludes own-only threads and requests identity after threads", async (t) => {
		const ownAuthor = { id: "me", displayName: "Current User" };
		const otherAuthor = { id: "reviewer", displayName: "Reviewer" };
		const fromReviewer = thread(2, {
			comments: [
				textComment(20, "mine", ownAuthor),
				textComment(21, "review", otherAuthor),
			],
		});
		const fromUnknownAuthor = thread(4, {
			comments: [{ id: 40, content: "anonymous review" }],
		});
		const { calls, threads } = createServices(t, [
			{
				json: {
					value: [
						thread(1, { comments: [textComment(10, "mine", ownAuthor)] }),
						fromReviewer,
						thread(3, {
							comments: [
								textComment(30, "mine", ownAuthor),
								{
									id: 31,
									content: "reviewer changed status",
									commentType: "system",
									author: otherAuthor,
								},
							],
						}),
						fromUnknownAuthor,
					],
				},
			},
			{ json: { authenticatedUser: { id: "me" } } },
		]);

		const result = await threads.list(prId, {
			excludeResolved: false,
			excludeOwn: true,
		});

		assert.deepEqual(result, [fromReviewer, fromUnknownAuthor]);
		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url:
					"https://dev.azure.com/my%20org/_apis/connectionData?" +
					"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
				method: "GET",
				body: null,
			},
		]);
	});

	test("list combines resolved and own-thread exclusions in request order", async (t) => {
		const ownAuthor = { id: "me", displayName: "Current User" };
		const otherAuthor = { id: "reviewer", displayName: "Reviewer" };
		const activeOther = thread(3, {
			comments: [textComment(30, "active review", otherAuthor)],
		});
		const { calls, threads } = createServices(t, [
			{
				json: {
					value: [
						thread(1, { comments: [textComment(10, "mine", ownAuthor)] }),
						thread(2, {
							status: "fixed",
							comments: [textComment(20, "resolved review", otherAuthor)],
						}),
						activeOther,
					],
				},
			},
			{ json: { authenticatedUser: { id: "me" } } },
		]);

		const result = await threads.list(prId, {
			excludeResolved: true,
			excludeOwn: true,
		});

		assert.deepEqual(result, [activeOther]);
		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url:
					"https://dev.azure.com/my%20org/_apis/connectionData?" +
					"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
				method: "GET",
				body: null,
			},
		]);
	});

	test("format exactly formats general threads and unknown authors", (t) => {
		const { threads } = createServices(t);
		const value = thread(7, {
			status: undefined,
			comments: [
				{ id: 70, content: "  Please explain this.  " },
				{ id: 71, content: "ignored", commentType: "system" },
				textComment(72, "   "),
			],
		});

		assert.equal(
			threads.format(value, prId),
			`### Thread 7 — General (not tied to a file/line) [active]\n${webBase}?discussionId=7\n- **unknown** (comment 70): Please explain this.`,
		);
	});

	test("format exactly formats single-line, range, and right-side-preferred locations", (t) => {
		const { threads } = createServices(t);
		const single = thread(8, {
			status: "pending",
			threadContext: {
				filePath: "/src/single.ts",
				leftFileStart: { line: 5 },
				leftFileEnd: { line: 5 },
			},
		});
		const range = thread(9, {
			status: "fixed",
			threadContext: {
				filePath: "/src/range.ts",
				rightFileStart: { line: 20 },
				rightFileEnd: { line: 24 },
				leftFileStart: { line: 2 },
				leftFileEnd: { line: 3 },
			},
		});

		assert.equal(
			threads.format(single, prId),
			`### Thread 8 — /src/single.ts:5 [pending]\n${webBase}?discussionId=8\n- **User 8** (comment 8): comment 8`,
		);
		assert.equal(
			threads.format(range, prId),
			`### Thread 9 — /src/range.ts:20-24 [fixed]\n${webBase}?discussionId=9\n- **User 9** (comment 9): comment 9`,
		);
	});

	test("formatSummary exactly formats general, file-only, single, and range rows", (t) => {
		const { threads: threadService } = createServices(t);
		const values = [
			thread(1, { status: undefined }),
			thread(2, { threadContext: { filePath: "/src/file-only.ts" } }),
			thread(3, {
				status: "pending",
				threadContext: {
					filePath: "/src/single.ts",
					rightFileStart: { line: 11 },
					rightFileEnd: { line: 11 },
					leftFileStart: { line: 1 },
					leftFileEnd: { line: 2 },
				},
			}),
			thread(4, {
				status: "fixed",
				threadContext: {
					filePath: "/src/range.ts",
					leftFileStart: { line: 30 },
					leftFileEnd: { line: 33 },
				},
			}),
		];

		assert.equal(
			threadService.formatSummary(values, prId),
			`| Thread | Location | Status | Link |\n` +
				`| --- | --- | --- | --- |\n` +
				`| 1 | General (not tied to a file/line) | active | [Open](${webBase}?discussionId=1) |\n` +
				`| 2 | /src/file-only.ts | active | [Open](${webBase}?discussionId=2) |\n` +
				`| 3 | /src/single.ts:11 | pending | [Open](${webBase}?discussionId=3) |\n` +
				`| 4 | /src/range.ts:30-33 | fixed | [Open](${webBase}?discussionId=4) |`,
		);
	});

	test("webUrl returns the exact encoded Azure DevOps discussion URL", (t) => {
		const { threads } = createServices(t);

		assert.equal(threads.webUrl(prId, 123), `${webBase}?discussionId=123`);
	});

	test("reply sends the comments request", async (t) => {
		const { calls, threads } = createServices(t, [{ json: {} }]);

		await threads.reply(prId, 17, "Reply text");

		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads/17/comments?api-version=7.1`,
				method: "POST",
				body: { content: "Reply text" },
			},
		]);
	});

	test("edit PATCHes the identified comment content", async (t) => {
		const { calls, threads } = createServices(t, [{ json: {} }]);

		await threads.edit(prId, 17, 23, "Edited text");

		assert.equal(calls.length, 1);
		const [call] = requestShapes(calls);
		assert.equal(call.url, `${apiBase}/threads/17/comments/23?api-version=7.1`);
		assert.equal(call.method, "PATCH");
		assert.deepEqual(call.body, { content: "Edited text" });
	});

	test("delete DELETEs the identified comment and accepts an empty success response", async (t) => {
		const { calls, threads } = createServices(t, [{ body: "" }]);

		await threads.delete(prId, 17, 23);

		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads/17/comments/23?api-version=7.1`,
				method: "DELETE",
				body: null,
			},
		]);
	});

	test("comment sends the general-thread request", async (t) => {
		const posted = thread(51);
		const { calls, threads } = createServices(t, [{ json: posted }]);

		const result = await threads.comment(prId, "General comment");

		assert.deepEqual(result, posted);
		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads?api-version=7.1`,
				method: "POST",
				body: { comments: [{ content: "General comment" }], status: "active" },
			},
		]);
	});

	test("comment resolves a real file anchor and sends the anchored-thread request", async (t) => {
		const posted = thread(52);
		const { calls, threads } = createServices(t, [
			{ json: { value: [{ id: 1 }, { id: 3 }, { id: 2 }] } },
			{
				json: {
					changeEntries: [
						{ changeTrackingId: 70, item: { path: "/src/other.ts" } },
						{ changeTrackingId: 77, item: { path: "/src/app.ts" } },
					],
				},
			},
			{ json: posted },
		]);

		const result = await threads.comment(prId, "Anchored comment", {
			file: "src/app.ts",
			line: 4,
			endLine: 9,
		});

		assert.deepEqual(result, posted);
		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/iterations?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url: `${apiBase}/iterations/3/changes?api-version=7.1&$top=500&$skip=0`,
				method: "GET",
				body: null,
			},
			{
				url: `${apiBase}/threads?api-version=7.1`,
				method: "POST",
				body: {
					comments: [{ content: "Anchored comment" }],
					status: "active",
					threadContext: {
						filePath: "/src/app.ts",
						rightFileStart: { line: 4, offset: 1 },
						rightFileEnd: { line: 9, offset: 1 },
					},
					pullRequestThreadContext: {
						iterationContext: {
							firstComparingIteration: 3,
							secondComparingIteration: 3,
						},
						changeTrackingId: 77,
					},
				},
			},
		]);
	});

	test("resolve sends the fixed-status request", async (t) => {
		const { calls, threads } = createServices(t, [{ json: {} }]);

		await threads.resolve(prId, 19);

		assert.deepEqual(requestShapes(calls), [
			{
				url: `${apiBase}/threads/19?api-version=7.1`,
				method: "PATCH",
				body: { status: "fixed" },
			},
		]);
	});
	for (const status of ["fixed", "wontFix", "byDesign", "closed", "active"]) {
		test(`sets the ${status} thread status`, async (t) => {
			const { calls, threads } = createServices(t, [{ json: {} }]);
			if (status === "active") await threads.reopen(prId, 19);
			else await threads.resolve(prId, 19, status);
			assert.deepEqual(requestShapes(calls), [
				{
					url: `${apiBase}/threads/19?api-version=7.1`,
					method: "PATCH",
					body: { status },
				},
			]);
		});
	}
});
