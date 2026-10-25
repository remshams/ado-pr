import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	createDiffOutput,
	formatFileDiff,
	lineChanges,
	wholeFileBlocks,
} from "./unified-diff.ts";

function lines(count, label = "line") {
	return Array.from(
		{ length: count },
		(_, index) => `${label} ${index + 1}\n`,
	).join("");
}

function block(originalStart, originalCount, modifiedStart, modifiedCount) {
	return { originalStart, originalCount, modifiedStart, modifiedCount };
}

function textContent(original, modified, blocks) {
	return { binary: false, original, modified, blocks };
}

describe("unified diff formatting", () => {
	test("formats an edit with three lines of context", () => {
		const original = lines(10);
		const modified = original.replace("line 5\n", "changed 5\n");
		assert.equal(
			formatFileDiff({
				path: "src/a.ts",
				change: "edit",
				content: textContent(original, modified, [block(5, 1, 5, 1)]),
			}),
			[
				"diff --git a/src/a.ts b/src/a.ts",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -2,7 +2,7 @@",
				" line 2",
				" line 3",
				" line 4",
				"-line 5",
				"+changed 5",
				" line 6",
				" line 7",
				" line 8",
				"",
			].join("\n"),
		);
	});

	test("merges blocks whose context overlaps and splits distant ones", () => {
		const original = lines(30);
		const modified = original
			.replace("line 2\n", "")
			.replace("line 8\n", "line 8\nnew 8a\n")
			.replace("line 25\n", "changed 25\n");
		const output = formatFileDiff({
			path: "a.txt",
			change: "edit",
			content: textContent(original, modified, [
				block(2, 1, 2, 0),
				block(9, 0, 8, 1),
				block(25, 1, 25, 1),
			]),
		});
		assert.deepEqual(
			output.split("\n").filter((line) => line.startsWith("@@")),
			["@@ -1,11 +1,11 @@", "@@ -22,7 +22,7 @@"],
		);
		assert.match(output, / line 1\n-line 2\n line 3\n/);
		assert.match(output, / line 8\n\+new 8a\n line 9\n/);
	});

	test("derives the start of an empty side from the unchanged gap", () => {
		const original = lines(5);
		const modified = original.replace("line 3\n", "line 3\ninserted\n");
		// Both blocks describe the same insertion with different empty-side conventions.
		for (const originalStart of [4, 99]) {
			assert.match(
				formatFileDiff({
					path: "a.txt",
					change: "edit",
					content: textContent(original, modified, [
						block(originalStart, 0, 4, 1),
					]),
				}),
				/@@ -1,5 \+1,6 @@\n line 1\n line 2\n line 3\n\+inserted\n line 4\n line 5\n$/,
			);
		}
		const deleted = original.replace("line 3\n", "");
		assert.match(
			formatFileDiff({
				path: "a.txt",
				change: "edit",
				content: textContent(original, deleted, [block(3, 1, 0, 0)]),
			}),
			/@@ -1,5 \+1,4 @@\n line 1\n line 2\n-line 3\n line 4\n line 5\n$/,
		);
	});

	test("formats added and deleted files against /dev/null", () => {
		assert.equal(
			formatFileDiff({
				path: "new.txt",
				change: "add",
				content: textContent("", "a\nb\n", wholeFileBlocks("", "a\nb\n")),
			}),
			"diff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n",
		);
		assert.equal(
			formatFileDiff({
				path: "old.txt",
				change: "delete",
				content: textContent("a\n", "", wholeFileBlocks("a\n", "")),
			}),
			"diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n",
		);
		assert.equal(
			formatFileDiff({
				path: "empty.txt",
				change: "add",
				content: textContent("", "", wholeFileBlocks("", "")),
			}),
			"diff --git a/empty.txt b/empty.txt\n--- /dev/null\n+++ b/empty.txt\n",
		);
	});

	test("formats renames with and without content changes", () => {
		assert.equal(
			formatFileDiff({
				path: "b.txt",
				originalPath: "a.txt",
				change: "rename",
			}),
			"diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n",
		);
		assert.equal(
			formatFileDiff({
				path: "b.txt",
				originalPath: "a.txt",
				change: "rename",
				content: textContent("x\n", "y\n", [block(1, 1, 1, 1)]),
			}),
			"diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n",
		);
	});

	test("lists binary files without content", () => {
		assert.equal(
			formatFileDiff({
				path: "logo.png",
				change: "edit",
				content: { binary: true },
			}),
			"diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
		);
		assert.equal(
			formatFileDiff({
				path: "logo.png",
				change: "add",
				content: { binary: true },
			}),
			"diff --git a/logo.png b/logo.png\nBinary files /dev/null and b/logo.png differ\n",
		);
		assert.equal(
			formatFileDiff({
				path: "logo.png",
				change: "delete",
				content: { binary: true },
			}),
			"diff --git a/logo.png b/logo.png\nBinary files a/logo.png and /dev/null differ\n",
		);
	});

	test("marks a missing final newline on each side", () => {
		assert.equal(
			formatFileDiff({
				path: "a.txt",
				change: "edit",
				content: textContent("a\nb", "a\nc", [block(2, 1, 2, 1)]),
			}),
			"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
		);
	});

	test("prints only the header when there are no line changes", () => {
		assert.equal(
			formatFileDiff({
				path: "a.txt",
				change: "edit",
				content: textContent("a\n", "a\n", []),
			}),
			"diff --git a/a.txt b/a.txt\n",
		);
	});

	test("rejects blocks that do not fit the file content", () => {
		for (const blocks of [
			[block(4, 1, 4, 1)],
			[block(2, 1, 3, 1)],
			[block(1, 1, 1, 2)],
		]) {
			assert.throws(
				() =>
					formatFileDiff({
						path: "a.txt",
						change: "edit",
						content: textContent(lines(3), lines(3), blocks),
					}),
				/^Error: Line diff blocks for a\.txt do not match the file content\.$/,
			);
		}
	});
});

describe("line changes", () => {
	test("lists the removed and added lines of each aligned block", () => {
		const original = lines(6);
		const modified = original
			.replace("line 2\n", "two\n")
			.replace("line 4\n", "line 4\nnew a\nnew b\n")
			.replace("line 6\n", "");
		assert.deepEqual(
			lineChanges("a.txt", original, modified, [
				block(2, 1, 2, 1),
				block(99, 0, 5, 2),
				block(6, 1, 99, 0),
			]),
			[
				{ ...block(2, 1, 2, 1), removed: ["line 2"], added: ["two"] },
				{ ...block(5, 0, 5, 2), removed: [], added: ["new a", "new b"] },
				{ ...block(6, 1, 8, 0), removed: ["line 6"], added: [] },
			],
		);
	});

	test("rejects blocks that do not match the content", () => {
		assert.throws(
			() => lineChanges("a.txt", lines(1), lines(1), [block(3, 1, 3, 1)]),
			/^Error: Line diff blocks for a\.txt do not match the file content\.$/,
		);
	});
});

describe("diff output limit", () => {
	test("returns every file without a notice when under the limit", () => {
		const output = createDiffOutput(100);
		output.add("a", "aaa\n");
		output.add("b", "bbb\n");
		assert.equal(output.full, false);
		assert.equal(output.finish(2), "aaa\nbbb\n");
	});

	test("cuts the crossing file at a line boundary and names it", () => {
		const output = createDiffOutput(10);
		output.add("a", "aaaa\n");
		output.add("b", "bb\nbb\nbb\n");
		assert.equal(output.full, true);
		assert.equal(
			output.finish(3),
			"aaaa\nbb\nDiff truncated at the 10-byte limit in file 2 of 3 (b).\n",
		);
	});

	test("reports the shown file count when nothing of the next file fits", () => {
		const output = createDiffOutput(6);
		output.add("a", "aaaa\n");
		output.add("b", "bbbb\n");
		assert.equal(
			output.finish(2),
			"aaaa\nDiff truncated at the 6-byte limit after 1 of 2 files.\n",
		);
	});

	test("is full once the limit is reached exactly", () => {
		const output = createDiffOutput(5);
		output.add("a", "aaaa\n");
		assert.equal(output.full, true);
		assert.equal(
			output.finish(4),
			"aaaa\nDiff truncated at the 5-byte limit after 1 of 4 files.\n",
		);
	});

	test("counts bytes, not characters", () => {
		const output = createDiffOutput(4);
		output.add("a", "é\néé\n");
		assert.equal(
			output.finish(1),
			"é\nDiff truncated at the 4-byte limit in file 1 of 1 (a).\n",
		);
	});
});
