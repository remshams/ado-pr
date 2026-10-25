/**
 * Formats file changes as a unified diff. This domain service only knows file text and line blocks,
 * so any source of line blocks (Azure DevOps or a local diff) can feed it.
 */

/** A changed run of lines. Line numbers are 1-based; a count of zero means an empty side. */
export interface LineBlock {
	originalStart: number;
	originalCount: number;
	modifiedStart: number;
	modifiedCount: number;
}

export type FileChangeKind = "add" | "edit" | "delete" | "rename";

export type FileContent =
	| { binary: true }
	| {
			binary: false;
			original: string;
			modified: string;
			blocks: readonly LineBlock[];
	  };

export interface FileDiff {
	path: string;
	/** The path before a rename. */
	originalPath?: string;
	change: FileChangeKind;
	/** Omitted when only the path changed. */
	content?: FileContent;
}

const CONTEXT_LINES = 3;
const NO_NEWLINE = "\\ No newline at end of file";

interface FileLines {
	lines: string[];
	endsWithNewline: boolean;
}

function splitLines(text: string): FileLines {
	return {
		lines: text === "" ? [] : text.replace(/\n$/, "").split("\n"),
		endsWithNewline: text === "" || text.endsWith("\n"),
	};
}

/** The single block of an added or deleted file: every line changes. */
export function wholeFileBlocks(
	original: string,
	modified: string,
): LineBlock[] {
	const originalCount = splitLines(original).lines.length;
	const modifiedCount = splitLines(modified).lines.length;
	if (originalCount === 0 && modifiedCount === 0) return [];
	return [{ originalStart: 1, originalCount, modifiedStart: 1, modifiedCount }];
}

/**
 * Places each block against both files. The start of an empty side is derived from the unchanged
 * gap before the block, which is the same length on both sides, so its numbering convention can't
 * shift the output.
 */
function alignBlocks(
	path: string,
	blocks: readonly LineBlock[],
	original: FileLines,
	modified: FileLines,
): LineBlock[] {
	const mismatch = () =>
		new Error(`Line diff blocks for ${path} do not match the file content.`);
	let nextOriginal = 1;
	let nextModified = 1;
	const aligned = blocks.map((block) => {
		const originalStart =
			block.originalCount > 0
				? block.originalStart
				: nextOriginal + (block.modifiedStart - nextModified);
		const modifiedStart =
			block.modifiedCount > 0
				? block.modifiedStart
				: nextModified + (block.originalStart - nextOriginal);
		const gap = originalStart - nextOriginal;
		if (gap < 0 || modifiedStart - nextModified !== gap) throw mismatch();
		nextOriginal = originalStart + block.originalCount;
		nextModified = modifiedStart + block.modifiedCount;
		return { ...block, originalStart, modifiedStart };
	});
	if (
		original.lines.length + 1 - nextOriginal !==
			modified.lines.length + 1 - nextModified ||
		nextOriginal > original.lines.length + 1
	)
		throw mismatch();
	return aligned;
}

function groupHunks(blocks: LineBlock[]): LineBlock[][] {
	const hunks: LineBlock[][] = [];
	for (const block of blocks) {
		const current = hunks.at(-1);
		const previous = current?.at(-1);
		if (
			current &&
			previous &&
			block.originalStart - (previous.originalStart + previous.originalCount) <=
				2 * CONTEXT_LINES
		) {
			current.push(block);
		} else {
			hunks.push([block]);
		}
	}
	return hunks;
}

function hunkRange(start: number, count: number): string {
	return `${count === 0 ? start - 1 : start},${count}`;
}

function formatHunk(
	blocks: LineBlock[],
	original: FileLines,
	modified: FileLines,
): string[] {
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	const originalFrom = Math.max(1, first.originalStart - CONTEXT_LINES);
	const modifiedFrom =
		first.modifiedStart - (first.originalStart - originalFrom);
	const originalTo = Math.min(
		original.lines.length + 1,
		last.originalStart + last.originalCount + CONTEXT_LINES,
	);

	const body: string[] = [];
	const emit = (prefix: string, file: FileLines, line: number) => {
		body.push(`${prefix}${file.lines[line - 1]}`);
		if (line === file.lines.length && !file.endsWithNewline)
			body.push(NO_NEWLINE);
	};
	let cursor = originalFrom;
	let modifiedCount = 0;
	for (const block of blocks) {
		for (; cursor < block.originalStart; cursor += 1)
			emit(" ", original, cursor);
		for (let line = 0; line < block.originalCount; line += 1)
			emit("-", original, block.originalStart + line);
		for (let line = 0; line < block.modifiedCount; line += 1)
			emit("+", modified, block.modifiedStart + line);
		cursor = block.originalStart + block.originalCount;
		modifiedCount += block.modifiedCount - block.originalCount;
	}
	for (; cursor < originalTo; cursor += 1) emit(" ", original, cursor);

	const originalCount = originalTo - originalFrom;
	return [
		`@@ -${hunkRange(originalFrom, originalCount)} +${hunkRange(modifiedFrom, originalCount + modifiedCount)} @@`,
		...body,
	];
}

function sidePaths(file: FileDiff): { from: string; to: string } {
	const originalPath = file.originalPath ?? file.path;
	return {
		from: file.change === "add" ? "/dev/null" : `a/${originalPath}`,
		to: file.change === "delete" ? "/dev/null" : `b/${file.path}`,
	};
}

/** Formats one file as a git-style unified diff section ending in a newline. */
export function formatFileDiff(file: FileDiff): string {
	const originalPath = file.originalPath ?? file.path;
	const lines = [`diff --git a/${originalPath} b/${file.path}`];
	if (file.change === "rename")
		lines.push(`rename from ${originalPath}`, `rename to ${file.path}`);
	const { from, to } = sidePaths(file);
	const content = file.content;
	if (content?.binary) {
		lines.push(`Binary files ${from} and ${to} differ`);
	} else if (content) {
		const original = splitLines(content.original);
		const modified = splitLines(content.modified);
		const blocks = alignBlocks(file.path, content.blocks, original, modified);
		if (blocks.length > 0 || file.change === "add" || file.change === "delete")
			lines.push(`--- ${from}`, `+++ ${to}`);
		for (const hunk of groupHunks(blocks))
			lines.push(...formatHunk(hunk, original, modified));
	}
	return `${lines.join("\n")}\n`;
}

function prefixWithinBytes(text: string, maxBytes: number): string {
	let used = 0;
	let end = 0;
	for (const line of text.split(/(?<=\n)/)) {
		used += Buffer.byteLength(line);
		if (used > maxBytes) break;
		end += line.length;
	}
	return text.slice(0, end);
}

/**
 * Collects file diffs up to a byte limit. The file that crosses the limit is cut at a line boundary
 * and `finish` appends a notice saying where the output stopped.
 */
export function createDiffOutput(maxBytes: number) {
	const parts: string[] = [];
	let usedBytes = 0;
	let shownFiles = 0;
	let partialPath: string | undefined;
	let full = false;

	return {
		get full(): boolean {
			return full;
		},
		add(path: string, text: string): void {
			const bytes = Buffer.byteLength(text);
			if (usedBytes + bytes <= maxBytes) {
				parts.push(text);
				usedBytes += bytes;
				shownFiles += 1;
				full = usedBytes === maxBytes;
				return;
			}
			const prefix = prefixWithinBytes(text, maxBytes - usedBytes);
			parts.push(prefix);
			if (prefix !== "") partialPath = path;
			full = true;
		},
		finish(totalFiles: number): string {
			const output = parts.join("");
			if (shownFiles === totalFiles) return output;
			const limit = maxBytes.toLocaleString("en-US");
			const notice =
				partialPath === undefined
					? `Diff truncated at the ${limit}-byte limit after ${shownFiles} of ${totalFiles} files.`
					: `Diff truncated at the ${limit}-byte limit in file ${shownFiles + 1} of ${totalFiles} (${partialPath}).`;
			return `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${notice}\n`;
		},
	};
}
