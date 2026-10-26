import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
import { safeJson } from "../shared/json.ts";
import { createPullRequestDiffService } from "./diff.ts";

const ctx = {
	organization: "test-org",
	project: "test-project",
	repository: "test-repository",
};
const repositoryUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository";
const prUrl = `${repositoryUrl}/pullRequests/42`;

function createService(t, responses, options = {}) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat: "test-only-fake-pat", fetch });
	const service = createPullRequestDiffService({
		azure,
		ctx,
		pullRequests: { resolveId: async (prId) => prId ?? 42 },
		...options,
	});
	return { service, calls };
}

// Shapes follow https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1
function iterations(count = 2) {
	return {
		json: {
			count,
			value: Array.from({ length: count }, (_, index) => ({
				id: index + 1,
				sourceRefCommit: { commitId: `source-${index + 1}` },
				targetRefCommit: { commitId: "target" },
				commonRefCommit: { commitId: `common-${index + 1}` },
				createdDate: `2026-10-0${index + 1}T12:00:00Z`,
			})),
		},
	};
}

// Shapes follow https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1
function changes(changeEntries, page = {}) {
	return { json: { changeEntries, ...page } };
}

function change(changeType, path, extra = {}) {
	return {
		changeTrackingId: 1,
		changeId: 1,
		item: { objectId: "object", path },
		changeType,
		...extra,
	};
}

// Shapes follow https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1
function item(content, isBinary = false) {
	return {
		json: {
			objectId: "object",
			gitObjectType: "blob",
			commitId: "commit",
			path: "/path",
			content,
			contentMetadata: { isBinary },
		},
	};
}

// Shapes follow https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/filediff
function fileDiff(path, lineDiffBlocks) {
	return { path, originalPath: path, lineDiffBlocks };
}

function fileDiffs(path, lineDiffBlocks) {
	return { json: { count: 1, value: [fileDiff(path, lineDiffBlocks)] } };
}

function lineBlock(changeType, original, modified) {
	return {
		changeType,
		originalLineNumberStart: original[0],
		originalLinesCount: original[1],
		modifiedLineNumberStart: modified[0],
		modifiedLinesCount: modified[1],
	};
}

function itemUrl(path, commit) {
	return `${repositoryUrl}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json&api-version=7.1`;
}

describe("pull request diff", () => {
	test("diffs the latest iteration against the merge base", async (t) => {
		const { service, calls } = createService(t, [
			iterations(),
			changes([change("edit", "/src/a.ts")]),
			item("one\ntwo\nthree\n"),
			item("one\n2\nthree\n"),
			fileDiffs("/src/a.ts", [
				lineBlock("none", [1, 1], [1, 1]),
				lineBlock("edit", [2, 1], [2, 1]),
				lineBlock("none", [3, 1], [3, 1]),
			]),
		]);

		assert.equal(
			await service.diff(42),
			[
				"PR #42: iteration 2 compared with the merge base.",
				"diff --git a/src/a.ts b/src/a.ts",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1,3 +1,3 @@",
				" one",
				"-two",
				"+2",
				" three",
				"",
			].join("\n"),
		);
		assert.deepEqual(
			calls.map((call) => call.url),
			[
				`${prUrl}/iterations?api-version=7.1`,
				`${prUrl}/iterations/2/changes?$top=2000&api-version=7.1`,
				itemUrl("/src/a.ts", "common-2"),
				itemUrl("/src/a.ts", "source-2"),
				`${repositoryUrl}/filediffs?api-version=7.1-preview.1`,
			],
		);
		assert.equal(calls[4].method, "POST");
		assert.deepEqual(JSON.parse(calls[4].body), {
			baseVersionCommit: "common-2",
			targetVersionCommit: "source-2",
			fileDiffParams: [{ path: "/src/a.ts", originalPath: "/src/a.ts" }],
		});
	});

	test("accepts file diffs as a bare array", async (t) => {
		const { service } = createService(t, [
			iterations(1),
			changes([change("edit", "/a.txt")]),
			item("a\n"),
			item("b\n"),
			{ json: [fileDiff("/a.txt", [lineBlock("edit", [1, 1], [1, 1])])] },
		]);

		assert.match(await service.diff(42), /-a\n\+b\n$/);
	});

	test("compares with an earlier iteration for --since-iteration", async (t) => {
		const { service, calls } = createService(t, [
			iterations(3),
			changes([change("edit", "/a.txt")]),
			item("a\n"),
			item("b\n"),
			fileDiffs("/a.txt", [lineBlock("edit", [1, 1], [1, 1])]),
		]);

		const output = await service.diff(42, { sinceIteration: 1 });
		assert.match(output, /^PR #42: iteration 3 compared with iteration 1\.\n/);
		assert.match(output, /-a\n\+b\n$/);
		assert.equal(
			calls[1].url,
			`${prUrl}/iterations/3/changes?$top=2000&$compareTo=1&api-version=7.1`,
		);
		assert.equal(calls[2].url, itemUrl("/a.txt", "source-1"));
		assert.equal(calls[3].url, itemUrl("/a.txt", "source-3"));
		assert.equal(JSON.parse(calls[4].body).baseVersionCommit, "source-1");
	});

	test("rejects an iteration the pull request does not have", async (t) => {
		const { service, calls } = createService(t, [iterations(2)]);
		await assert.rejects(
			service.diff(42, { sinceIteration: 3 }),
			/^Error: PR #42 has no iteration 3; the latest iteration is 2\.$/,
		);
		assert.equal(calls.length, 1);
	});

	test("reads added files at the target and deleted files at the base only", async (t) => {
		const { service, calls } = createService(t, [
			iterations(1),
			changes([change("add", "/new.txt"), change("delete", "/old.txt")]),
			item("hello\n"),
			item("bye\n"),
		]);

		assert.equal(
			await service.diff(42),
			[
				"PR #42: iteration 1 compared with the merge base.",
				"diff --git a/new.txt b/new.txt",
				"--- /dev/null",
				"+++ b/new.txt",
				"@@ -0,0 +1,1 @@",
				"+hello",
				"diff --git a/old.txt b/old.txt",
				"--- a/old.txt",
				"+++ /dev/null",
				"@@ -1,1 +0,0 @@",
				"-bye",
				"",
			].join("\n"),
		);
		assert.equal(calls[2].url, itemUrl("/new.txt", "source-1"));
		assert.equal(calls[3].url, itemUrl("/old.txt", "common-1"));
	});

	test("reads a renamed file's original path and skips content for a pure rename", async (t) => {
		const { service, calls } = createService(t, [
			iterations(1),
			changes([
				change("rename", "/moved.txt", { originalPath: "/plain.txt" }),
				change("edit, rename", "/b.txt", { originalPath: "/a.txt" }),
			]),
			item("x\n"),
			item("y\n"),
			fileDiffs("/b.txt", [lineBlock("edit", [1, 1], [1, 1])]),
		]);

		assert.equal(
			await service.diff(42),
			[
				"PR #42: iteration 1 compared with the merge base.",
				"diff --git a/plain.txt b/moved.txt",
				"rename from plain.txt",
				"rename to moved.txt",
				"diff --git a/a.txt b/b.txt",
				"rename from a.txt",
				"rename to b.txt",
				"--- a/a.txt",
				"+++ b/b.txt",
				"@@ -1,1 +1,1 @@",
				"-x",
				"+y",
				"",
			].join("\n"),
		);
		assert.equal(calls[2].url, itemUrl("/a.txt", "common-1"));
		assert.equal(calls[3].url, itemUrl("/b.txt", "source-1"));
		assert.deepEqual(JSON.parse(calls[4].body).fileDiffParams, [
			{ path: "/b.txt", originalPath: "/a.txt" },
		]);
	});

	test("lists binary files without content or line blocks", async (t) => {
		const { service, calls } = createService(t, [
			iterations(1),
			changes([change("edit", "/logo.png"), change("add", "/data.bin")]),
			item("PNG", true),
			item("PNG2", true),
			item("a\u0000b"),
		]);

		assert.equal(
			await service.diff(42),
			[
				"PR #42: iteration 1 compared with the merge base.",
				"diff --git a/logo.png b/logo.png",
				"Binary files a/logo.png and b/logo.png differ",
				"diff --git a/data.bin b/data.bin",
				"Binary files /dev/null and b/data.bin differ",
				"",
			].join("\n"),
		);
		assert.equal(calls.length, 5);
	});

	test("skips folders and pages through iteration changes", async (t) => {
		const { service, calls } = createService(t, [
			iterations(1),
			changes(
				[
					{
						changeType: "add",
						item: { path: "/dir", isFolder: true },
					},
				],
				{ nextSkip: 1, nextTop: 100 },
			),
			changes([change("add", "/dir/a.txt")], { nextSkip: 0, nextTop: 0 }),
			item("a\n"),
		]);

		assert.match(await service.diff(42), /diff --git a\/dir\/a\.txt/);
		assert.equal(
			calls[2].url,
			`${prUrl}/iterations/1/changes?$top=100&$skip=1&api-version=7.1`,
		);
	});

	test("reports when the iteration has no file changes", async (t) => {
		const { service } = createService(t, [iterations(2), changes([])]);
		assert.equal(
			await service.diff(42, { sinceIteration: 2 }),
			"PR #42: iteration 2 compared with iteration 2.\nNo file changes.\n",
		);
	});

	test("stops reading files once the output limit is reached", async (t) => {
		const { service, calls } = createService(
			t,
			[
				iterations(1),
				changes([
					change("add", "/a.txt"),
					change("add", "/b.txt"),
					change("add", "/c.txt"),
				]),
				item("a\n".repeat(5)),
				item("b\n".repeat(20)),
			],
			{ maxOutputBytes: 170 },
		);

		const output = await service.diff(42);
		assert.match(
			output,
			/\n(\+b\n){5}Diff truncated at the 170-byte limit in file 2 of 3 \(b\.txt\)\.\n$/,
		);
		assert.equal(calls.length, 4);
	});

	test("rejects malformed Azure responses", async (t) => {
		const cases = [
			[[{ json: { value: [] } }], /PR #42 has no iterations/],
			[
				[{ json: { value: [{ id: 1, sourceRefCommit: {} }] } }],
				/iteration 1 source has no commit ID/,
			],
			[
				[iterations(1), changes([{ changeType: "edit", item: {} }])],
				/an iteration change has no item path/,
			],
			[
				[
					iterations(1),
					changes([change("edit", "/a.txt")]),
					item("a\n"),
					item("b\n"),
					{ json: { count: 1, value: [{ path: "/a.txt" }] } },
				],
				/file diff has no lineDiffBlocks/,
			],
			[
				[
					iterations(1),
					changes([change("edit", "/a.txt")]),
					item("a\n"),
					item("b\n"),
					{ json: { count: 0, value: [] } },
				],
				/file diff has no lineDiffBlocks/,
			],
			[
				[
					iterations(1),
					changes([change("edit", "/a.txt")]),
					item("a\n"),
					item("b\n"),
					{ json: {} },
				],
				/file diffs response must be an array or have a value array/,
			],
			[
				[
					iterations(1),
					changes([change("edit", "/a.txt")]),
					item("a\n"),
					item("b\n"),
					{ json: null },
				],
				/file diffs response must be an array or have a value array/,
			],
		];
		for (const [responses, message] of cases) {
			const { service } = createService(t, responses);
			await assert.rejects(service.diff(42), message);
		}
	});

	test("compares with the latest iteration created before the last review", async (t) => {
		const { service, calls } = createService(t, [
			iterations(3),
			changes([change("edit", "/a.txt")]),
			item("a\n"),
			item("b\n"),
			fileDiffs("/a.txt", [lineBlock("edit", [1, 1], [1, 1])]),
		]);

		const output = await service.diff(42, {
			lastReview: new Date("2026-10-02T15:00:00Z"),
		});
		assert.match(
			output,
			/^PR #42: iteration 3 compared with iteration 2, the latest before your last review on 2026-10-02T15:00:00\.000Z\.\n/,
		);
		assert.equal(
			calls[1].url,
			`${prUrl}/iterations/3/changes?$top=2000&$compareTo=2&api-version=7.1`,
		);
		assert.equal(calls[2].url, itemUrl("/a.txt", "source-2"));
	});

	test("compares the latest iteration with itself when the review came after it", async (t) => {
		const { service, calls } = createService(t, [iterations(3), changes([])]);

		assert.equal(
			await service.diff(42, { lastReview: new Date("2026-10-03T13:00:00Z") }),
			"PR #42: iteration 3 compared with iteration 3, the latest before your last review on 2026-10-03T13:00:00.000Z.\nNo file changes.\n",
		);
		assert.equal(
			calls[1].url,
			`${prUrl}/iterations/3/changes?$top=2000&$compareTo=3&api-version=7.1`,
		);
	});

	test("fails --since-last-review without a comment or vote by the user", async (t) => {
		const { service, calls } = createService(t, [iterations(2)]);
		await assert.rejects(
			service.diff(42, { lastReview: null }),
			/^Error: Found no comment or vote by you on PR #42\. Use --since-iteration <n> instead\.$/,
		);
		assert.equal(calls.length, 1);
	});

	test("fails --since-last-review when no iteration was created before the review", async (t) => {
		const { service } = createService(t, [iterations(2)]);
		await assert.rejects(
			service.diff(42, { lastReview: new Date("2026-10-01T12:00:00Z") }),
			/^Error: PR #42 has no iteration created before your last review on 2026-10-01T12:00:00\.000Z\. Use --since-iteration <n> instead\.$/,
		);
	});

	test("rejects an iteration without a creation date for --since-last-review", async (t) => {
		const undated = iterations(2);
		delete undated.json.value[1].createdDate;
		const { service } = createService(t, [undated]);
		await assert.rejects(
			service.diff(42, { lastReview: new Date("2026-10-05T12:00:00Z") }),
			/^Error: Malformed Azure DevOps response: iteration 2 has no creation date\.$/,
		);
	});

	test("lists only changed paths with their change type and reads no content", async (t) => {
		const { service, calls } = createService(t, [
			iterations(1),
			changes([
				change("edit", "/src/a.ts"),
				change("add", "/new.txt"),
				change("delete", "/old.txt"),
				change("edit, rename", "/b.txt", { originalPath: "/a.txt" }),
			]),
		]);

		assert.equal(
			await service.diff(42, { nameOnly: true }),
			[
				"edit\tsrc/a.ts",
				"add\tnew.txt",
				"delete\told.txt",
				"rename\ta.txt -> b.txt",
				"",
			].join("\n"),
		);
		assert.equal(calls.length, 2);
	});

	test("quotes --name-only paths that contain control or bidi characters", async (t) => {
		const { service } = createService(t, [
			iterations(1),
			changes([
				change("add", "/tab\there.txt"),
				change("edit", '/esc\u001b[31m"red".txt'),
				change("edit, rename", "/new\u202eline.txt", {
					originalPath: "/old\nname.txt",
				}),
			]),
		]);

		assert.equal(
			await service.diff(42, { nameOnly: true }),
			[
				'add\t"tab\\u0009here.txt"',
				'edit\t"esc\\u001b[31m\\"red\\".txt"',
				'rename\t"old\\u000aname.txt" -> "new\\u202eline.txt"',
				"",
			].join("\n"),
		);
	});

	test("prints nothing for --name-only without file changes", async (t) => {
		const { service } = createService(t, [iterations(1), changes([])]);
		assert.equal(await service.diff(42, { nameOnly: true }), "");
	});

	test("returns files, change types and line blocks as JSON", async (t) => {
		const { service } = createService(t, [
			iterations(2),
			changes([
				change("edit", "/src/a.ts"),
				change("rename", "/moved.txt", { originalPath: "/plain.txt" }),
				change("add", "/logo.png"),
				change("delete", "/old.txt"),
			]),
			item("one\ntwo\nthree\n"),
			item("one\n2\nthree\nfour\n"),
			fileDiffs("/src/a.ts", [
				lineBlock("none", [1, 1], [1, 1]),
				lineBlock("edit", [2, 1], [2, 1]),
				lineBlock("none", [3, 1], [3, 1]),
				lineBlock("add", [4, 0], [4, 1]),
			]),
			item("PNG", true),
			item("bye\n"),
		]);

		assert.deepEqual(await service.diffJson(42, { sinceIteration: 1 }), {
			pullRequestId: 42,
			iteration: 2,
			baseIteration: 1,
			lastReview: null,
			files: [
				{
					path: "src/a.ts",
					originalPath: "src/a.ts",
					change: "edit",
					content: "text",
					blocks: [
						{
							originalStart: 2,
							originalCount: 1,
							modifiedStart: 2,
							modifiedCount: 1,
							removed: ["two"],
							added: ["2"],
						},
						{
							originalStart: 4,
							originalCount: 0,
							modifiedStart: 4,
							modifiedCount: 1,
							removed: [],
							added: ["four"],
						},
					],
				},
				{
					path: "moved.txt",
					originalPath: "plain.txt",
					change: "rename",
					content: "none",
					blocks: [],
				},
				{
					path: "logo.png",
					originalPath: "logo.png",
					change: "add",
					content: "binary",
					blocks: [],
				},
				{
					path: "old.txt",
					originalPath: "old.txt",
					change: "delete",
					content: "text",
					blocks: [
						{
							originalStart: 1,
							originalCount: 1,
							modifiedStart: 1,
							modifiedCount: 0,
							removed: ["bye"],
							added: [],
						},
					],
				},
			],
			truncated: false,
		});
	});

	test("returns only paths and change types as JSON for --name-only", async (t) => {
		const { service, calls } = createService(t, [
			iterations(3),
			changes([change("edit", "/a.txt")]),
		]);

		assert.deepEqual(
			await service.diffJson(42, {
				lastReview: new Date("2026-10-03T12:00:01Z"),
				nameOnly: true,
			}),
			{
				pullRequestId: 42,
				iteration: 3,
				baseIteration: 3,
				lastReview: "2026-10-03T12:00:01.000Z",
				files: [{ path: "a.txt", originalPath: "a.txt", change: "edit" }],
				truncated: false,
			},
		);
		assert.equal(calls.length, 2);
	});

	describe("JSON output limit", () => {
		// The first file's lines take about 3,000 bytes, the others less than 300 together.
		const addedFiles = [
			change("add", "/big.txt"),
			change("add", "/a.txt"),
			change("add", "/c.txt"),
		];
		const contents = () => [
			item("bigline\n".repeat(300)),
			item("a\n".repeat(3)),
			item("c\n"),
		];

		function printedBytes(result) {
			return Buffer.byteLength(`${safeJson(result)}\n`);
		}

		async function printedSizeWithoutLimit(t) {
			const { service } = createService(
				t,
				[iterations(1), changes(addedFiles), ...contents()],
				{ maxOutputBytes: Number.MAX_SAFE_INTEGER },
			);
			return printedBytes(await service.diffJson(42));
		}

		test("measures the output as printed, envelope included", async (t) => {
			const fullSize = await printedSizeWithoutLimit(t);
			const { service } = createService(
				t,
				[iterations(1), changes(addedFiles), ...contents()],
				{ maxOutputBytes: fullSize },
			);
			const result = await service.diffJson(42);
			assert.equal(result.truncated, false);
			assert.equal(printedBytes(result), fullSize);
		});

		test("omits the file that passes the limit by one byte", async (t) => {
			const maxOutputBytes = (await printedSizeWithoutLimit(t)) - 1;
			const { service } = createService(
				t,
				[iterations(1), changes(addedFiles), ...contents()],
				{ maxOutputBytes },
			);
			const result = await service.diffJson(42);
			assert.deepEqual(
				result.files.map((file) => file.content),
				["text", "text", "omitted"],
			);
			assert.equal(result.truncated, true);
			assert.ok(printedBytes(result) <= maxOutputBytes);
		});

		test("reads content only when at least one empty block fits", async (t) => {
			const oneEmptyBlock = printedBytes({
				pullRequestId: 42,
				iteration: 1,
				baseIteration: null,
				lastReview: null,
				files: [
					{
						path: "c.txt",
						originalPath: "c.txt",
						change: "add",
						content: "text",
						blocks: [
							{
								originalStart: 0,
								originalCount: 0,
								modifiedStart: 0,
								modifiedCount: 0,
								removed: [],
								added: [],
							},
						],
					},
				],
				truncated: false,
			});
			for (const [maxOutputBytes, requests] of [
				[oneEmptyBlock, 3],
				[oneEmptyBlock - 1, 2],
			]) {
				const { service, calls } = createService(
					t,
					[
						iterations(1),
						changes([change("add", "/c.txt")]),
						...(requests === 3 ? [item("c\n")] : []),
					],
					{ maxOutputBytes },
				);
				const result = await service.diffJson(42);
				assert.equal(result.files[0].content, "omitted");
				assert.equal(calls.length, requests);
			}
		});

		test("omits only a file that doesn't fit and still reads later files", async (t) => {
			const maxOutputBytes = (await printedSizeWithoutLimit(t)) - 1000;
			const { service, calls } = createService(
				t,
				[iterations(1), changes(addedFiles), ...contents()],
				{ maxOutputBytes },
			);
			const result = await service.diffJson(42);
			assert.deepEqual(
				result.files.map((file) => [
					file.path,
					file.content,
					file.blocks.length,
				]),
				[
					["big.txt", "omitted", 0],
					["a.txt", "text", 1],
					["c.txt", "text", 1],
				],
			);
			assert.equal(result.truncated, true);
			assert.ok(printedBytes(result) <= maxOutputBytes);
			assert.equal(calls.length, 5);
		});

		test("keeps a pure rename and reads no content when no block fits", async (t) => {
			const { service, calls } = createService(
				t,
				[
					iterations(1),
					changes([
						change("rename", "/b", { originalPath: "/a" }),
						change("add", "/c"),
					]),
				],
				{ maxOutputBytes: 0 },
			);
			const result = await service.diffJson(42);
			assert.deepEqual(
				result.files.map((file) => file.content),
				["none", "omitted"],
			);
			assert.equal(result.truncated, true);
			assert.equal(calls.length, 2);
		});
	});
});
