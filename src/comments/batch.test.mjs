import assert from "node:assert/strict";
import test from "node:test";

import { createAzureRequester } from "../shared/azure.ts";
import { createBatchRunner } from "./batch.ts";
import { createFileAnchorService } from "./file-anchors.ts";
import { createThreadService } from "./threads.ts";
import {
	captureConsole,
	createMockFetch,
	isolateExitCode,
	mockStdin,
} from "../../tests/test-helpers.mjs";

const ctx = {
	organization: "test-org",
	project: "test project",
	repository: "test/repo",
};
const pat = "test-only-pat";
const defaultPrId = 42;
const apiBase =
	"https://dev.azure.com/test-org/test%20project/_apis/git/repositories/test%2Frepo/pullRequests";
const webBase =
	"https://dev.azure.com/test-org/test%20project/_git/test%2Frepo/pullrequest";

function threadUrl(prId, suffix = "") {
	return `${apiBase}/${prId}/threads${suffix}?api-version=7.1`;
}

function requestShapes(calls) {
	return calls.map(({ url, method, body }) => ({ url, method, body }));
}

function semanticRequestShapes(calls) {
	return calls.map(({ url, method, body }) => ({
		url,
		method,
		body: body === null ? null : JSON.parse(body),
	}));
}

function prepareBatchTest(t, input, responses = []) {
	isolateExitCode(t);
	const stdin = mockStdin(t, Buffer.from(input));
	const consoleCalls = captureConsole(t);
	const { fetch, calls: fetchCalls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const fileAnchors = createFileAnchorService({ azure, ctx });
	const threads = createThreadService({ azure, ctx, fileAnchors });
	const runner = createBatchRunner({ threads });
	return { runner, stdin, consoleCalls, fetchCalls };
}

async function assertInputRejected(t, input, expected, { tty = false } = {}) {
	const { runner, stdin, consoleCalls, fetchCalls } = prepareBatchTest(
		t,
		input,
	);
	if (tty) {
		Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
	}

	await assert.rejects(runner.run(defaultPrId), expected);
	assert.deepEqual(
		fetchCalls,
		[],
		"invalid input must not make an API request",
	);
	assert.deepEqual(consoleCalls, [], "invalid input must not print progress");
	assert.equal(process.exitCode, undefined);
}

test.describe("createBatchRunner", { concurrency: false }, () => {
	test("rejects terminal stdin with actionable guidance", async (t) => {
		await assertInputRejected(
			t,
			"",
			{
				message:
					"comment batch reads its operations from stdin, but none was piped/redirected in (stdin is a terminal). Use e.g. `pr.sh comment batch < operations.json`.",
			},
			{ tty: true },
		);
	});

	test("rejects empty stdin", async (t) => {
		await assertInputRejected(t, " \n\t", {
			message:
				"No batch operations provided on stdin. Pipe/redirect a JSON array of operations in, e.g. `pr.sh comment batch < operations.json`.",
		});
	});

	test("rejects malformed JSON", async (t) => {
		await assertInputRejected(t, '[{"command":"comment.create"}', {
			message: /^Failed to parse batch operations as JSON: /,
		});
	});

	test("rejects non-array JSON", async (t) => {
		await assertInputRejected(
			t,
			'{"command":"comment.create","message":"hello"}',
			{
				message: "Batch operations must be a JSON array.",
			},
		);
	});

	test("accepts an empty operations array without making requests", async (t) => {
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, "[]");

		await runner.run(defaultPrId);

		assert.deepEqual(fetchCalls, []);
		assert.deepEqual(consoleCalls, [
			{ method: "log", args: ["No batch operations to run."] },
		]);
		assert.equal(process.exitCode, undefined);
	});

	const invalidOperationCases = [
		{
			name: "non-object entry",
			operation: null,
			message: "Batch operation 1 must be a JSON object.",
		},
		{
			name: "array entry",
			operation: [],
			message: "Batch operation 1 must be a JSON object.",
		},
		{
			name: "missing command",
			operation: { message: "hello" },
			message:
				'Batch operation 1 has an invalid "command" (must be one of: comment.create, comment.reply, comment.edit, comment.delete, comment.resolve).',
		},
		{
			name: "legacy action discriminator",
			operation: { action: "comment", message: "hello" },
			message:
				'Batch operation 1 has an invalid "command" (must be one of: comment.create, comment.reply, comment.edit, comment.delete, comment.resolve).',
		},
		{
			name: "unknown command",
			operation: { command: "comment.archive" },
			message:
				'Batch operation 1 has an invalid "command" (must be one of: comment.create, comment.reply, comment.edit, comment.delete, comment.resolve).',
		},
		{
			name: "non-positive PR",
			operation: { command: "comment.create", message: "hello", pr: 0 },
			message:
				'Batch operation 1 has an invalid "pr" (must be a positive integer).',
		},
		{
			name: "fractional thread",
			operation: { command: "comment.reply", message: "hello", thread: 1.5 },
			message:
				'Batch operation 1 has an invalid "thread" (must be a positive integer).',
		},
		{
			name: "invalid comment",
			operation: {
				command: "comment.edit",
				thread: 7,
				comment: 0,
				message: "hello",
			},
			message:
				'Batch operation 1 has an invalid "comment" (must be a positive integer).',
		},
		{
			name: "string line",
			operation: {
				command: "comment.create",
				message: "hello",
				file: "src/a.ts",
				line: "2",
			},
			message:
				'Batch operation 1 has an invalid "line" (must be a positive integer).',
		},
		{
			name: "zero end line",
			operation: {
				command: "comment.create",
				message: "hello",
				file: "src/a.ts",
				line: 1,
				endLine: 0,
			},
			message:
				'Batch operation 1 has an invalid "endLine" (must be a positive integer).',
		},
		{
			name: "reply missing thread",
			operation: { command: "comment.reply", message: "hello" },
			message: 'Batch operation 1 ("comment.reply") requires a "thread".',
		},
		{
			name: "resolve missing thread",
			operation: { command: "comment.resolve" },
			message: 'Batch operation 1 ("comment.resolve") requires a "thread".',
		},
		{
			name: "delete missing comment",
			operation: { command: "comment.delete", thread: 7 },
			message: 'Batch operation 1 ("comment.delete") requires a "comment".',
		},
		{
			name: "edit missing message",
			operation: { command: "comment.edit", thread: 7, comment: 3 },
			message: 'Batch operation 1 ("comment.edit") requires a "message".',
		},
		{
			name: "create missing message",
			operation: { command: "comment.create" },
			message: 'Batch operation 1 ("comment.create") requires a "message".',
		},
		{
			name: "reply empty message",
			operation: { command: "comment.reply", thread: 7, message: "" },
			message: 'Batch operation 1 ("comment.reply") requires a "message".',
		},
		{
			name: "line without file",
			operation: { command: "comment.create", message: "hello", line: 3 },
			message: 'Batch operation 1 ("comment.create") has "line" but no "file".',
		},
		{
			name: "end line without line",
			operation: {
				command: "comment.create",
				message: "hello",
				file: "src/a.ts",
				endLine: 4,
			},
			message:
				'Batch operation 1 ("comment.create") has "endLine" but no "line".',
		},
		{
			name: "reversed line range",
			operation: {
				command: "comment.create",
				message: "hello",
				file: "src/a.ts",
				line: 8,
				endLine: 4,
			},
			message: 'Batch operation 1 ("comment.create") has "endLine" < "line".',
		},
	];

	test("rejects invalid operations", async (t) => {
		for (const { name, operation, message } of invalidOperationCases) {
			await t.test(name, async (t) => {
				await assertInputRejected(t, JSON.stringify([operation]), { message });
			});
		}
	});

	const validOperationByCommand = {
		"comment.create": { command: "comment.create", message: "Create" },
		"comment.reply": { command: "comment.reply", thread: 1, message: "Reply" },
		"comment.edit": {
			command: "comment.edit",
			thread: 1,
			comment: 2,
			message: "Edit",
		},
		"comment.delete": { command: "comment.delete", thread: 1, comment: 2 },
		"comment.resolve": { command: "comment.resolve", thread: 1 },
	};

	test("rejects unknown fields for every command", async (t) => {
		const unknownFields = [
			["unexpected", true],
			["action", "reply"],
		];
		for (const [command, validOperation] of Object.entries(
			validOperationByCommand,
		)) {
			for (const [field, value] of unknownFields) {
				await t.test(`${command} / ${field}`, async (t) => {
					const operation = { ...validOperation, [field]: value };
					await assertInputRejected(t, JSON.stringify([operation]), {
						message: `Batch operation 1 ("${command}") has an unknown field "${field}".`,
					});
				});
			}
		}
	});

	test("rejects every cross-command field", async (t) => {
		const fieldValues = {
			thread: 1,
			comment: 2,
			message: "Irrelevant",
			file: "src/a.ts",
			line: 3,
			endLine: 4,
		};
		const irrelevantFieldsByCommand = {
			"comment.create": ["thread", "comment"],
			"comment.reply": ["comment", "file", "line", "endLine"],
			"comment.edit": ["file", "line", "endLine"],
			"comment.delete": ["message", "file", "line", "endLine"],
			"comment.resolve": ["comment", "message", "file", "line", "endLine"],
		};

		for (const [command, fields] of Object.entries(irrelevantFieldsByCommand)) {
			for (const field of fields) {
				await t.test(`${command} / ${field}`, async (t) => {
					const operation = {
						...validOperationByCommand[command],
						[field]: fieldValues[field],
					};
					await assertInputRejected(t, JSON.stringify([operation]), {
						message: `Batch operation 1 ("${command}") has an irrelevant field "${field}".`,
					});
				});
			}
		}
	});

	test("rejects malformed supplied optional fields", async (t) => {
		const cases = [
			{
				name: "string PR",
				operation: { ...validOperationByCommand["comment.resolve"], pr: "42" },
				message:
					'Batch operation 1 has an invalid "pr" (must be a positive integer).',
			},
			{
				name: "null PR",
				operation: { ...validOperationByCommand["comment.resolve"], pr: null },
				message:
					'Batch operation 1 has an invalid "pr" (must be a positive integer).',
			},
			{
				name: "numeric file",
				operation: { ...validOperationByCommand["comment.create"], file: 12 },
				message:
					'Batch operation 1 has an invalid "file" (must be a non-empty string).',
			},
			{
				name: "null file",
				operation: { ...validOperationByCommand["comment.create"], file: null },
				message:
					'Batch operation 1 has an invalid "file" (must be a non-empty string).',
			},
			{
				name: "boolean line",
				operation: {
					...validOperationByCommand["comment.create"],
					file: "src/a.ts",
					line: true,
				},
				message:
					'Batch operation 1 has an invalid "line" (must be a positive integer).',
			},
			{
				name: "string end line",
				operation: {
					...validOperationByCommand["comment.create"],
					file: "src/a.ts",
					line: 1,
					endLine: "2",
				},
				message:
					'Batch operation 1 has an invalid "endLine" (must be a positive integer).',
			},
		];

		for (const { name, operation, message } of cases) {
			await t.test(name, async (t) => {
				await assertInputRejected(t, JSON.stringify([operation]), { message });
			});
		}
	});

	test("rejects an empty file", async (t) => {
		const operation = {
			...validOperationByCommand["comment.create"],
			file: "",
		};
		await assertInputRejected(t, JSON.stringify([operation]), {
			message:
				'Batch operation 1 has an invalid "file" (must be a non-empty string).',
		});
	});

	test("parses every operation before making any request", async (t) => {
		const input = JSON.stringify([
			{ command: "comment.create", message: "would otherwise be posted" },
			{ command: "comment.resolve" },
		]);
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, input);

		await assert.rejects(runner.run(defaultPrId), {
			message: 'Batch operation 2 ("comment.resolve") requires a "thread".',
		});

		assert.deepEqual(fetchCalls, []);
		assert.deepEqual(consoleCalls, []);
		assert.equal(process.exitCode, undefined);
	});

	test("executes mixed operations sequentially and prints exact progress", async (t) => {
		const input = JSON.stringify([
			{ command: "comment.create", message: "Top-level comment" },
			{ command: "comment.reply", thread: 17, message: "Reply text" },
			{
				command: "comment.edit",
				thread: 19,
				comment: 4,
				message: "Edited text",
			},
			{ command: "comment.delete", thread: 21, comment: 6 },
			{ command: "comment.resolve", thread: 23 },
		]);
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, input, [
			{ json: { id: 101, comments: [] } },
			{ json: {} },
			{ json: {} },
			{ body: "" },
			{ json: {} },
		]);

		await runner.run(defaultPrId);

		assert.deepEqual(semanticRequestShapes(fetchCalls), [
			{
				url: threadUrl(42),
				method: "POST",
				body: {
					comments: [{ content: "Top-level comment" }],
					status: "active",
				},
			},
			{
				url: threadUrl(42, "/17/comments"),
				method: "POST",
				body: { content: "Reply text" },
			},
			{
				url: threadUrl(42, "/19/comments/4"),
				method: "PATCH",
				body: { content: "Edited text" },
			},
			{
				url: threadUrl(42, "/21/comments/6"),
				method: "DELETE",
				body: null,
			},
			{
				url: threadUrl(42, "/23"),
				method: "PATCH",
				body: { status: "fixed" },
			},
		]);
		assert.deepEqual(consoleCalls, [
			{
				method: "log",
				args: [
					`[1/5] comment.create: posted new comment thread 101 on PR #42 (${webBase}/42?discussionId=101)`,
				],
			},
			{
				method: "log",
				args: ["[2/5] comment.reply: posted reply to thread 17 on PR #42"],
			},
			{
				method: "log",
				args: ["[3/5] comment.edit: edited comment 4 in thread 19 on PR #42"],
			},
			{
				method: "log",
				args: [
					"[4/5] comment.delete: deleted comment 6 from thread 21 on PR #42",
				],
			},
			{
				method: "log",
				args: ["[5/5] comment.resolve: marked thread 23 on PR #42 as resolved"],
			},
		]);
		assert.equal(process.exitCode, undefined);
	});

	test("uses an operation PR override instead of the default PR", async (t) => {
		const input = JSON.stringify([
			{ command: "comment.reply", pr: 91, thread: 8, message: "Override" },
		]);
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, input, [
			{ json: {} },
		]);

		await runner.run(defaultPrId);

		assert.deepEqual(requestShapes(fetchCalls), [
			{
				url: threadUrl(91, "/8/comments"),
				method: "POST",
				body: '{"content":"Override"}',
			},
		]);
		assert.deepEqual(consoleCalls, [
			{
				method: "log",
				args: ["[1/1] comment.reply: posted reply to thread 8 on PR #91"],
			},
		]);
		assert.equal(process.exitCode, undefined);
	});

	test("continues after an API failure and sets the final exit code", async (t) => {
		const input = JSON.stringify([
			{ command: "comment.reply", thread: 5, message: "This fails" },
			{ command: "comment.resolve", thread: 6 },
		]);
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, input, [
			{
				status: 503,
				statusText: "Service Unavailable",
				body: "temporary outage",
			},
			{ json: {} },
		]);

		await runner.run(defaultPrId);

		assert.deepEqual(requestShapes(fetchCalls), [
			{
				url: threadUrl(42, "/5/comments"),
				method: "POST",
				body: '{"content":"This fails"}',
			},
			{
				url: threadUrl(42, "/6"),
				method: "PATCH",
				body: '{"status":"fixed"}',
			},
		]);
		assert.deepEqual(consoleCalls, [
			{
				method: "error",
				args: [
					`[1/2] comment.reply: FAILED - Azure DevOps API request (POST ${threadUrl(42, "/5/comments")}) failed: 503 Service Unavailable\ntemporary outage`,
				],
			},
			{
				method: "log",
				args: ["[2/2] comment.resolve: marked thread 6 on PR #42 as resolved"],
			},
		]);
		assert.equal(process.exitCode, 1);
	});

	test("leaves the exit code clear when every operation succeeds", async (t) => {
		const input = JSON.stringify([{ command: "comment.resolve", thread: 12 }]);
		const { runner } = prepareBatchTest(t, input, [{ json: {} }]);

		await runner.run(defaultPrId);

		assert.equal(process.exitCode, undefined);
	});

	test("shares one file-anchor cache across repeated file comments", async (t) => {
		const input = JSON.stringify([
			{
				command: "comment.create",
				message: "First",
				file: "src/shared.ts",
				line: 4,
			},
			{
				command: "comment.create",
				message: "Second",
				file: "/src/shared.ts",
				line: 9,
				endLine: 11,
			},
		]);
		const { runner, consoleCalls, fetchCalls } = prepareBatchTest(t, input, [
			{ json: { value: [{ id: 2 }, { id: 7 }] } },
			{
				json: {
					changeEntries: [
						{ changeTrackingId: 88, item: { path: "/src/shared.ts" } },
					],
				},
			},
			{ json: { id: 201, comments: [] } },
			{ json: { id: 202, comments: [] } },
		]);

		await runner.run(defaultPrId);

		assert.deepEqual(requestShapes(fetchCalls), [
			{
				url: `${apiBase}/42/iterations?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url: `${apiBase}/42/iterations/7/changes?api-version=7.1&$top=500&$skip=0`,
				method: "GET",
				body: null,
			},
			{
				url: threadUrl(42),
				method: "POST",
				body: '{"comments":[{"content":"First"}],"status":"active","threadContext":{"filePath":"/src/shared.ts","rightFileStart":{"line":4,"offset":1},"rightFileEnd":{"line":4,"offset":1}},"pullRequestThreadContext":{"iterationContext":{"firstComparingIteration":7,"secondComparingIteration":7},"changeTrackingId":88}}',
			},
			{
				url: threadUrl(42),
				method: "POST",
				body: '{"comments":[{"content":"Second"}],"status":"active","threadContext":{"filePath":"/src/shared.ts","rightFileStart":{"line":9,"offset":1},"rightFileEnd":{"line":11,"offset":1}},"pullRequestThreadContext":{"iterationContext":{"firstComparingIteration":7,"secondComparingIteration":7},"changeTrackingId":88}}',
			},
		]);
		assert.deepEqual(consoleCalls, [
			{
				method: "log",
				args: [
					`[1/2] comment.create: posted new comment thread 201 on PR #42 (${webBase}/42?discussionId=201)`,
				],
			},
			{
				method: "log",
				args: [
					`[2/2] comment.create: posted new comment thread 202 on PR #42 (${webBase}/42?discussionId=202)`,
				],
			},
		]);
		assert.equal(process.exitCode, undefined);
	});

	test("keeps file-anchor iteration and change tracking lookups isolated by PR", async (t) => {
		const input = JSON.stringify([
			{
				command: "comment.create",
				pr: 42,
				message: "First PR",
				file: "src/shared.ts",
				line: 4,
			},
			{
				command: "comment.create",
				pr: 91,
				message: "Second PR",
				file: "src/shared.ts",
				line: 9,
			},
		]);
		const { runner, fetchCalls } = prepareBatchTest(t, input, [
			{ json: { value: [{ id: 4 }] } },
			{
				json: {
					changeEntries: [
						{ changeTrackingId: 401, item: { path: "/src/shared.ts" } },
					],
				},
			},
			{ json: { id: 301, comments: [] } },
			{ json: { value: [{ id: 12 }] } },
			{
				json: {
					changeEntries: [
						{ changeTrackingId: 912, item: { path: "/src/shared.ts" } },
					],
				},
			},
			{ json: { id: 302, comments: [] } },
		]);

		await runner.run(defaultPrId);

		assert.deepEqual(requestShapes(fetchCalls), [
			{
				url: `${apiBase}/42/iterations?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url: `${apiBase}/42/iterations/4/changes?api-version=7.1&$top=500&$skip=0`,
				method: "GET",
				body: null,
			},
			{
				url: threadUrl(42),
				method: "POST",
				body: '{"comments":[{"content":"First PR"}],"status":"active","threadContext":{"filePath":"/src/shared.ts","rightFileStart":{"line":4,"offset":1},"rightFileEnd":{"line":4,"offset":1}},"pullRequestThreadContext":{"iterationContext":{"firstComparingIteration":4,"secondComparingIteration":4},"changeTrackingId":401}}',
			},
			{
				url: `${apiBase}/91/iterations?api-version=7.1`,
				method: "GET",
				body: null,
			},
			{
				url: `${apiBase}/91/iterations/12/changes?api-version=7.1&$top=500&$skip=0`,
				method: "GET",
				body: null,
			},
			{
				url: threadUrl(91),
				method: "POST",
				body: '{"comments":[{"content":"Second PR"}],"status":"active","threadContext":{"filePath":"/src/shared.ts","rightFileStart":{"line":9,"offset":1},"rightFileEnd":{"line":9,"offset":1}},"pullRequestThreadContext":{"iterationContext":{"firstComparingIteration":12,"secondComparingIteration":12},"changeTrackingId":912}}',
			},
		]);
		assert.equal(process.exitCode, undefined);
	});
});
