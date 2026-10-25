import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
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
function fileDiffs(path, lineDiffBlocks) {
	return { json: [{ path, originalPath: path, lineDiffBlocks }] };
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
					{ json: [{ path: "/a.txt" }] },
				],
				/file diff has no lineDiffBlocks/,
			],
			[
				[
					iterations(1),
					changes([change("edit", "/a.txt")]),
					item("a\n"),
					item("b\n"),
					{ json: { value: [] } },
				],
				/file diffs must be an array/,
			],
		];
		for (const [responses, message] of cases) {
			const { service } = createService(t, responses);
			await assert.rejects(service.diff(42), message);
		}
	});
});
