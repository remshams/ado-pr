import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runPr } from "../tests/test-helpers.mjs";
import {
	apiBase,
	assertSucceeded,
	createRepo,
	request,
	semanticRequest,
	webBase,
} from "../tests/pr-cli-helpers.mjs";

test("list uses an explicit PR and prints the filtered response as JSON", (t) => {
	const cwd = createRepo(t);
	const threads = [
		{
			id: 12,
			status: "active",
			comments: [
				{ id: 1, content: "Review this", author: { displayName: "Ada" } },
			],
		},
	];
	const result = runPr(t, ["comment", "list", "--pr", "42", "--json"], {
		cwd,
		responses: [{ json: { value: threads } }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify(threads, null, 2)}\n`);
});

test("list forwards exclude flags, fetches connection data after threads, and prints only threads surviving both filters", (t) => {
	const cwd = createRepo(t);
	const currentUser = { id: "me", displayName: "Current User" };
	const reviewer = { id: "reviewer", displayName: "Reviewer" };
	const survivor = {
		id: 13,
		status: "active",
		comments: [{ id: 3, content: "Keep this", author: reviewer }],
	};
	const result = runPr(
		t,
		[
			"comment",
			"list",
			"--pr",
			"42",
			"--json",
			"--exclude-own",
			"--exclude-resolved",
		],
		{
			cwd,
			responses: [
				{
					json: {
						value: [
							{
								id: 11,
								status: "active",
								comments: [{ id: 1, content: "My note", author: currentUser }],
							},
							{
								id: 12,
								status: "fixed",
								comments: [
									{ id: 2, content: "Already resolved", author: reviewer },
								],
							},
							survivor,
						],
					},
				},
				{ json: { authenticatedUser: { id: currentUser.id } } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url:
				"https://dev.azure.com/acme/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, `${JSON.stringify([survivor], null, 2)}\n`);
});

test("list auto-resolves the branch PR before fetching threads and handles an empty text result", (t) => {
	const cwd = createRepo(t, "feature/dispatch-order");
	const result = runPr(t, ["comment", "list"], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							pullRequestId: 73,
							title: "Resolved from branch",
							sourceRefName: "refs/heads/feature/dispatch-order",
						},
					],
				},
			},
			{ json: { value: [] } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url:
				`${apiBase}/pullrequests?` +
				"searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fdispatch-order&" +
				"searchCriteria.status=active&api-version=7.1",
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/73/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(result.stdout, "No matching comment threads on PR #73.\n");
});

test("list prints representative nonempty text output", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["comment", "list", "--pr", "42"], {
		cwd,
		responses: [
			{
				json: {
					value: [
						{
							id: 9,
							status: "active",
							comments: [
								{
									id: 1,
									content: " Looks good ",
									author: { displayName: "Ada" },
								},
							],
						},
					],
				},
			},
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stdout,
		`Comment threads on PR #42:\n\n` +
			`### Thread 9 — General (not tied to a file/line) [active]\n` +
			`${webBase}/42?discussionId=9\n` +
			`- **Ada** (comment 1): Looks good\n\n` +
			`---\n\nSummary:\n\n` +
			`| Thread | Location | Status | Link |\n` +
			`| --- | --- | --- | --- |\n` +
			`| 9 | General (not tied to a file/line) | active | [Open](${webBase}/42?discussionId=9) |\n`,
	);
});

test("comment dispatches a general top-level thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "create", "--pr", "42", "--message", "General note"],
		{
			cwd,
			responses: [{ json: { id: 31, comments: [] } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				comments: [{ content: "General note" }],
				status: "active",
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Posted new comment thread 31 on PR #42.\n${webBase}/42?discussionId=31\n`,
	);
});

test("comment resolves and dispatches an anchored top-level thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"Anchored note",
			"--file",
			"src/app.ts",
			"--line",
			"3",
			"--end-line",
			"5",
		],
		{
			cwd,
			responses: [
				{ json: { value: [{ id: 2 }, { id: 7 }] } },
				{
					json: {
						changeEntries: [
							{ changeTrackingId: 88, item: { path: "/src/app.ts" } },
						],
					},
				},
				{ json: { id: 32, comments: [] } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/iterations?api-version=7.1`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/iterations/7/changes?api-version=7.1&$top=500&$skip=0`,
			method: "GET",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({
				comments: [{ content: "Anchored note" }],
				status: "active",
				threadContext: {
					filePath: "/src/app.ts",
					rightFileStart: { line: 3, offset: 1 },
					rightFileEnd: { line: 5, offset: 1 },
				},
				pullRequestThreadContext: {
					iterationContext: {
						firstComparingIteration: 7,
						secondComparingIteration: 7,
					},
					changeTrackingId: 88,
				},
			}),
		},
	]);
	assert.equal(
		result.stdout,
		`Posted new comment thread 32 on PR #42.\n${webBase}/42?discussionId=32\n`,
	);
});

function writeAttachment(cwd, name = "log.txt") {
	const path = join(cwd, name);
	writeFileSync(path, "AB");
	return path;
}

const logAttachment = {
	displayName: "log.txt",
	url: "https://files.test/log.txt",
};

const logLink = "[log.txt](<https://files.test/log.txt>)";

test("comment create uploads the attachment and appends its link to the thread", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"See log",
			"--attachment",
			path,
		],
		{
			cwd,
			responses: [{ json: logAttachment }, { json: { id: 33, comments: [] } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/attachments/log.txt?api-version=7.1`,
			method: "POST",
			body: { encoding: "base64", data: "QUI=" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: {
				comments: [{ content: `See log\n\n${logLink}` }],
				status: "active",
			},
		},
	]);
	assert.equal(
		result.stdout,
		`Posted new comment thread 33 on PR #42 with attachment log.txt.\n${webBase}/42?discussionId=33\n`,
	);
});

test("comment reply uploads the attachment under --attachment-name and appends its link", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd, "raw.bin");
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Output attached",
			"--attachment",
			path,
			"--attachment-name",
			"log.txt",
		],
		{ cwd, responses: [{ json: logAttachment }, { json: { id: 2 } }] },
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/attachments/log.txt?api-version=7.1`,
			method: "POST",
			body: { encoding: "base64", data: "QUI=" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: `Output attached\n\n${logLink}` },
		},
	]);
	assert.equal(
		result.stdout,
		`Posted reply to thread 8 on PR #42 with attachment log.txt.\n`,
	);
});

test("comment create uploads first, then anchors the thread and appends the link", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"See log",
			"--file",
			"src/app.ts",
			"--line",
			"3",
			"--attachment",
			path,
		],
		{
			cwd,
			responses: [
				{ json: logAttachment },
				{ json: { value: [{ id: 7 }] } },
				{
					json: {
						changeEntries: [
							{ changeTrackingId: 88, item: { path: "/src/app.ts" } },
						],
					},
				},
				{ json: { id: 34, comments: [] } },
			],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(
		result.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`),
		[
			`POST ${apiBase}/pullRequests/42/attachments/log.txt`,
			`GET ${apiBase}/pullRequests/42/iterations`,
			`GET ${apiBase}/pullRequests/42/iterations/7/changes`,
			`POST ${apiBase}/pullRequests/42/threads`,
		],
	);
	const thread = semanticRequest(result.calls[3]).body;
	assert.deepEqual(thread.comments, [{ content: `See log\n\n${logLink}` }]);
	assert.equal(thread.threadContext.filePath, "/src/app.ts");
	assert.deepEqual(thread.threadContext.rightFileStart, {
		line: 3,
		offset: 1,
	});
	assert.equal(
		result.stdout,
		`Posted new comment thread 34 on PR #42 with attachment log.txt.\n${webBase}/42?discussionId=34\n`,
	);
});

test("comment reply combines --attachment with --status", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Fixed, see log",
			"--attachment",
			path,
			"--status",
			"fixed",
		],
		{
			cwd,
			responses: [{ json: logAttachment }, { json: { id: 2 } }, { json: {} }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/attachments/log.txt?api-version=7.1`,
			method: "POST",
			body: { encoding: "base64", data: "QUI=" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: `Fixed, see log\n\n${logLink}` },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/8?api-version=7.1`,
			method: "PATCH",
			body: { status: "fixed" },
		},
	]);
	assert.equal(
		result.stdout,
		"Posted reply to thread 8 on PR #42 with attachment log.txt and marked it as fixed.\n",
	);
});

test("comment reply reports a posted reply when the status update fails after an attachment", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Fixed, see log",
			"--attachment",
			path,
			"--status",
			"fixed",
		],
		{
			cwd,
			responses: [
				{ json: logAttachment },
				{ json: { id: 2 } },
				{
					status: 500,
					statusText: "Internal Server Error",
					body: '{"message":"Unavailable"}',
				},
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.calls.length, 3);
	assert.match(
		result.stderr,
		/Reply posted to thread 8, but setting its status to fixed failed: [\s\S]*500 Internal Server Error/,
	);
	assert.match(
		result.stderr,
		/The reply includes the uploaded attachment: \[log\.txt\]\(<https:\/\/files\.test\/log\.txt>\)/,
	);
	assert.doesNotMatch(result.stderr, /not posted/);
});

test("comment create with an unreadable attachment sends no request", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"See log",
			"--attachment",
			join(cwd, "missing.txt"),
		],
		{ cwd },
	);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /ENOENT/);
	assert.deepEqual(result.calls, []);
});

test("comment reply posts nothing when the attachment upload fails", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Output attached",
			"--attachment",
			path,
		],
		{
			cwd,
			responses: [
				{
					status: 400,
					statusText: "Bad Request",
					body: '{"message":"Unsupported file type"}',
				},
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.calls.length, 1);
	assert.match(
		result.stderr,
		/400 Bad Request[\s\S]*Unsupported file type[\s\S]*--attachment-name "attachment.txt"/,
	);
	assert.doesNotMatch(result.stderr, /Reuse this link/);
});

test("comment create reports the uploaded link when posting fails", (t) => {
	const cwd = createRepo(t);
	const path = writeAttachment(cwd);
	const result = runPr(
		t,
		[
			"comment",
			"create",
			"--pr",
			"42",
			"--message",
			"See log",
			"--attachment",
			path,
		],
		{
			cwd,
			responses: [
				{ json: logAttachment },
				{
					status: 500,
					statusText: "Internal Server Error",
					body: '{"message":"Unavailable"}',
				},
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.calls.length, 2);
	assert.match(result.stderr, /500 Internal Server Error/);
	assert.match(
		result.stderr,
		/The attachment was uploaded but the comment was not posted\. Reuse this link: \[log\.txt\]\(<https:\/\/files\.test\/log\.txt>\)/,
	);
});

test("reply dispatches to the selected thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"8",
			"--message",
			"Reply text",
		],
		{
			cwd,
			responses: [{ json: { id: 2 } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: JSON.stringify({ content: "Reply text" }),
		},
	]);
	assert.equal(result.stdout, "Posted reply to thread 8 on PR #42.\n");
});

test("edit dispatches a comment content update and prints success", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"edit",
			"--pr",
			"42",
			"--thread",
			"8",
			"--comment",
			"3",
			"--message",
			"Revised text",
		],
		{
			cwd,
			responses: [{ json: { id: 3, content: "Revised text" } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
			method: "PATCH",
			body: { content: "Revised text" },
		},
	]);
	assert.equal(result.stdout, "Edited comment 3 in thread 8 on PR #42.\n");
});

test("delete dispatches a bodyless comment deletion and prints success", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "delete", "--pr", "42", "--thread", "8", "--comment", "3"],
		{
			cwd,
			responses: [{ body: "" }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
	]);
	assert.equal(result.stdout, "Deleted comment 3 from thread 8 on PR #42.\n");
});

test("resolve dispatches a fixed status update to the selected thread", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		["comment", "resolve", "--pr", "42", "--thread", "9"],
		{
			cwd,
			responses: [{ json: { id: 9, status: "fixed" } }],
		},
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: JSON.stringify({ status: "fixed" }),
		},
	]);
	assert.equal(result.stdout, "Marked thread 9 on PR #42 as fixed.\n");
});

for (const [command, flags, status, confirmation] of [
	[
		"resolve",
		["--status", "wontFix"],
		"wontFix",
		"Marked thread 9 on PR #42 as wontFix.",
	],
	["reopen", [], "active", "Reopened thread 9 on PR #42."],
]) {
	test(`comment ${command} dispatches ${status}`, (t) => {
		const cwd = createRepo(t);
		const result = runPr(
			t,
			["comment", command, "--pr", "42", "--thread", "9", ...flags],
			{
				cwd,
				responses: [{ json: { id: 9, status } }],
			},
		);
		assertSucceeded(result);
		assert.deepEqual(result.calls.map(request), [
			{
				url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
				method: "PATCH",
				body: JSON.stringify({ status }),
			},
		]);
		assert.equal(result.stdout, `${confirmation}\n`);
	});
}

test("reply --status posts the reply, then sets the thread status", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"9",
			"--message",
			"Done",
			"--status",
			"ByDesign",
		],
		{ cwd, responses: [{ json: { id: 2 } }, { json: { id: 9 } }] },
	);

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/9/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Done" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: { status: "byDesign" },
		},
	]);
	assert.equal(
		result.stdout,
		"Posted reply to thread 9 on PR #42 and marked it as byDesign.\n",
	);
});

test("reply --status reports the posted reply when the status update fails", (t) => {
	const cwd = createRepo(t);
	const result = runPr(
		t,
		[
			"comment",
			"reply",
			"--pr",
			"42",
			"--thread",
			"9",
			"--message",
			"Done",
			"--status",
			"fixed",
		],
		{
			cwd,
			responses: [
				{ json: { id: 2 } },
				{ status: 500, statusText: "Server Error", body: "boom" },
			],
		},
	);

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/Reply posted to thread 9, but setting its status to fixed failed: /,
	);
});

test("batch dispatches reply and resolve statuses and reopen", (t) => {
	const cwd = createRepo(t);
	const operations = [
		{ command: "comment.reply", thread: 8, message: "Done", status: "closed" },
		{ command: "comment.resolve", thread: 9, status: "wontFix" },
		{ command: "comment.reopen", pr: 77, thread: 10 },
	];
	const result = runPr(t, ["comment", "batch", "--pr", "42"], {
		cwd,
		stdin: JSON.stringify(operations),
		responses: [{ json: {} }, { json: {} }, { json: {} }, { json: {} }],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Done" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/8?api-version=7.1`,
			method: "PATCH",
			body: { status: "closed" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
			method: "PATCH",
			body: { status: "wontFix" },
		},
		{
			url: `${apiBase}/pullRequests/77/threads/10?api-version=7.1`,
			method: "PATCH",
			body: { status: "active" },
		},
	]);
	assert.equal(
		result.stdout,
		"[1/3] comment.reply: posted reply to thread 8 on PR #42 and marked it as closed\n" +
			"[2/3] comment.resolve: marked thread 9 on PR #42 as wontFix\n" +
			"[3/3] comment.reopen: reopened thread 10 on PR #77\n",
	);
});

test("batch reads stdin and dispatches operations in order with per-operation PR overrides", (t) => {
	const cwd = createRepo(t);
	const operations = [
		{ command: "comment.create", message: "Batch note" },
		{ command: "comment.reply", pr: 77, thread: 8, message: "Batch reply" },
		{ command: "comment.edit", thread: 9, comment: 3, message: "Batch edit" },
		{ command: "comment.delete", thread: 10, comment: 4 },
		{ command: "comment.resolve", thread: 11 },
	];
	const result = runPr(t, ["comment", "batch", "--pr", "42"], {
		cwd,
		stdin: JSON.stringify(operations),
		responses: [
			{ json: { id: 51, comments: [] } },
			{ json: { id: 2 } },
			{ json: { id: 3, content: "Batch edit" } },
			{ body: "" },
			{ json: { id: 11, status: "fixed" } },
		],
	});

	assertSucceeded(result);
	assert.deepEqual(result.calls.map(semanticRequest), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "POST",
			body: {
				comments: [{ content: "Batch note" }],
				status: "active",
			},
		},
		{
			url: `${apiBase}/pullRequests/77/threads/8/comments?api-version=7.1`,
			method: "POST",
			body: { content: "Batch reply" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/9/comments/3?api-version=7.1`,
			method: "PATCH",
			body: { content: "Batch edit" },
		},
		{
			url: `${apiBase}/pullRequests/42/threads/10/comments/4?api-version=7.1`,
			method: "DELETE",
			body: null,
		},
		{
			url: `${apiBase}/pullRequests/42/threads/11?api-version=7.1`,
			method: "PATCH",
			body: { status: "fixed" },
		},
	]);
	assert.equal(
		result.stdout,
		`[1/5] comment.create: posted new comment thread 51 on PR #42 (${webBase}/42?discussionId=51)\n` +
			`[2/5] comment.reply: posted reply to thread 8 on PR #77\n` +
			`[3/5] comment.edit: edited comment 3 in thread 9 on PR #42\n` +
			`[4/5] comment.delete: deleted comment 4 from thread 10 on PR #42\n` +
			`[5/5] comment.resolve: marked thread 11 on PR #42 as fixed\n`,
	);
});

test("a top-level Azure error is printed and exits nonzero", (t) => {
	const cwd = createRepo(t);
	const result = runPr(t, ["comment", "list", "--pr", "42"], {
		cwd,
		responses: [
			{
				status: 503,
				statusText: "Service Unavailable",
				body: "Azure is temporarily unavailable",
			},
		],
	});

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.deepEqual(result.calls.map(request), [
		{
			url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
			method: "GET",
			body: null,
		},
	]);
	assert.equal(
		result.stderr,
		`Azure DevOps API request (GET ${apiBase}/pullRequests/42/threads?api-version=7.1) failed: ` +
			`503 Service Unavailable\nAzure is temporarily unavailable\n`,
	);
});
