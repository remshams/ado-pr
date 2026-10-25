/**
 * Reads a pull request diff from Azure DevOps and maps it to the unified-diff model.
 *
 * Request and response shapes come from the Azure DevOps REST documentation:
 * - Iterations: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1
 * - Iteration changes: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1
 * - Items: https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1
 * - File diffs has no REST reference page. Its shapes come from the client API reference:
 *   https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/gitrestclient#azure-devops-extension-api-gitrestclient-getfilediffs
 *   https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/filediffscriteria
 *   https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/filediff
 *   https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/linediffblock
 *   The resource is in preview, so it needs the 7.1-preview.1 version that the 7.1 clients send.
 */
import type { AzureRequester } from "../shared/azure.ts";
import {
	API_VERSION,
	pullRequestApiUrl,
	reposBaseUrl,
} from "../shared/azure.ts";
import { safeJson } from "../shared/json.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type { PullRequestService } from "./pull-requests.ts";
import {
	createDiffOutput,
	type FileChangeKind,
	type FileContent,
	type FileDiff,
	formatFileDiff,
	type LineBlock,
	type LineChange,
	lineChanges,
	wholeFileBlocks,
} from "./unified-diff.ts";

const FILE_DIFFS_API_VERSION = "7.1-preview.1";
const MAX_DIFF_OUTPUT_BYTES = 100_000;
/** The documented maximum, so most pull requests need one page of iteration changes. */
const MAX_CHANGES_PAGE_SIZE = 2000;

interface AzureCommitRef {
	commitId?: string;
}

interface AzureIteration {
	id: number;
	createdDate?: string;
	sourceRefCommit?: AzureCommitRef;
	commonRefCommit?: AzureCommitRef;
}

interface AzureIterationChange {
	changeType?: string;
	originalPath?: string;
	item?: { path?: string; isFolder?: boolean };
}

interface AzureIterationChanges {
	changeEntries?: AzureIterationChange[];
	nextSkip?: number;
	nextTop?: number;
}

interface AzureItem {
	content?: string;
	contentMetadata?: { isBinary?: boolean };
}

/** Azure serializes LineDiffBlockChangeType as a camelCase name. */
interface AzureLineDiffBlock {
	changeType?: string;
	originalLineNumberStart: number;
	originalLinesCount: number;
	modifiedLineNumberStart: number;
	modifiedLinesCount: number;
}

interface AzureFileDiff {
	lineDiffBlocks?: AzureLineDiffBlock[];
}

/** A changed file in the pull request, with Azure's leading slash still on its paths. */
interface ChangedFile {
	path: string;
	originalPath: string;
	change: FileChangeKind;
	contentChanged: boolean;
}

export interface PullRequestDiffOptions {
	sinceIteration?: number;
	/**
	 * For --since-last-review: the user's last comment or vote, or null when they have none.
	 * The diff compares with the latest iteration created before it.
	 */
	lastReview?: Date | null;
	/** List changed paths without reading file content. */
	nameOnly?: boolean;
}

/** How a JSON file entry carries its content: `none` is a pure rename, `omitted` didn't fit the output limit. */
export type DiffFileContent = "text" | "binary" | "none" | "omitted";

/** One changed file. `content` and `blocks` are left out for --name-only. */
export interface PullRequestDiffFile {
	path: string;
	originalPath: string;
	change: FileChangeKind;
	content?: DiffFileContent;
	blocks?: LineChange[];
}

/** The documented `pr diff --json` shape. */
export interface PullRequestDiffJson {
	pullRequestId: number;
	iteration: number;
	/** Null when the latest iteration is compared with the merge base. */
	baseIteration: number | null;
	/** The cutoff --since-last-review used as an ISO date, otherwise null. */
	lastReview: string | null;
	files: PullRequestDiffFile[];
	/** True when some files have content `omitted`. */
	truncated: boolean;
}

export interface PullRequestDiffService {
	diff(
		requestedPrId: number | undefined,
		options?: PullRequestDiffOptions,
	): Promise<string>;
	diffJson(
		requestedPrId: number | undefined,
		options?: PullRequestDiffOptions,
	): Promise<PullRequestDiffJson>;
}

/** The two sides of a pull request diff and the files that changed between them. */
interface Comparison {
	prId: number;
	latest: AzureIteration;
	compared?: AzureIteration;
	lastReview?: Date;
	baseCommit: string;
	targetCommit: string;
	files: ChangedFile[];
}

function malformed(detail: string): Error {
	return new Error(`Malformed Azure DevOps response: ${detail}.`);
}

function commitId(ref: AzureCommitRef | undefined, label: string): string {
	if (typeof ref?.commitId !== "string" || ref.commitId === "")
		throw malformed(`${label} has no commit ID`);
	return ref.commitId;
}

/** Maps Azure's flags-style change type, such as "edit, rename", to one file change. */
function changeKind(changeType: string | undefined): {
	change: FileChangeKind;
	contentChanged: boolean;
} {
	const types = (changeType ?? "").split(",").map((type) => type.trim());
	if (types.includes("delete"))
		return { change: "delete", contentChanged: true };
	if (types.includes("add") || types.includes("undelete"))
		return { change: "add", contentChanged: true };
	if (types.includes("rename"))
		return { change: "rename", contentChanged: types.includes("edit") };
	return { change: "edit", contentChanged: true };
}

function toChangedFile(entry: AzureIterationChange): ChangedFile | undefined {
	const path = entry.item?.path;
	if (entry.item?.isFolder === true) return undefined;
	if (typeof path !== "string" || path === "")
		throw malformed("an iteration change has no item path");
	return {
		path,
		originalPath: entry.originalPath ?? path,
		...changeKind(entry.changeType),
	};
}

function latestIteration(iterations: AzureIteration[]): AzureIteration {
	return iterations.reduce((newest, iteration) =>
		iteration.id > newest.id ? iteration : newest,
	);
}

function iterationById(
	prId: number,
	iterations: AzureIteration[],
	id: number,
): AzureIteration {
	const iteration = iterations.find((candidate) => candidate.id === id);
	if (!iteration)
		throw new Error(
			`PR #${prId} has no iteration ${id}; the latest iteration is ${latestIteration(iterations).id}.`,
		);
	return iteration;
}

function createdTime(iteration: AzureIteration): number {
	const time = Date.parse(String(iteration.createdDate));
	if (Number.isNaN(time))
		throw malformed(`iteration ${iteration.id} has no creation date`);
	return time;
}

/** The latest iteration created before the user's last review, for --since-last-review. */
function iterationBefore(
	prId: number,
	iterations: AzureIteration[],
	lastReview: Date | null,
): AzureIteration {
	if (lastReview === null)
		throw new Error(
			`Found no comment or vote by you on PR #${prId}. Use --since-iteration <n> instead.`,
		);
	const earlier = iterations.filter(
		(iteration) => createdTime(iteration) < lastReview.getTime(),
	);
	if (earlier.length === 0)
		throw new Error(
			`PR #${prId} has no iteration created before your last review on ${lastReview.toISOString()}. Use --since-iteration <n> instead.`,
		);
	return latestIteration(earlier);
}

function toLineBlocks(diff: AzureFileDiff | undefined): LineBlock[] {
	if (!Array.isArray(diff?.lineDiffBlocks))
		throw malformed("file diff has no lineDiffBlocks");
	return diff.lineDiffBlocks
		.filter((block) => block.changeType !== "none")
		.map((block) => ({
			originalStart: block.originalLineNumberStart,
			originalCount: block.originalLinesCount,
			modifiedStart: block.modifiedLineNumberStart,
			modifiedCount: block.modifiedLinesCount,
		}));
}

function displayPath(path: string): string {
	return path.replace(/^\//, "");
}

function heading(comparison: Comparison): string {
	const { prId, latest, compared, lastReview } = comparison;
	const base = compared ? `iteration ${compared.id}` : "the merge base";
	const review =
		lastReview === undefined
			? ""
			: `, the latest before your last review on ${lastReview.toISOString()}`;
	return `PR #${prId}: iteration ${latest.id} compared with ${base}${review}.\n`;
}

function fileNames(file: ChangedFile): PullRequestDiffFile {
	return {
		path: displayPath(file.path),
		originalPath: displayPath(file.originalPath),
		change: file.change,
	};
}

const EMPTY_BLOCK: LineChange = {
	originalStart: 0,
	originalCount: 0,
	modifiedStart: 0,
	modifiedCount: 0,
	removed: [],
	added: [],
};

function omittedFile(file: ChangedFile): PullRequestDiffFile {
	return { ...fileNames(file), content: "omitted", blocks: [] };
}

/** Bytes a file entry takes in the printed JSON: indented two levels and followed by ",\n". */
function printedFileBytes(entry: PullRequestDiffFile): number {
	const text = safeJson(entry);
	return Buffer.byteLength(text) + 4 * text.split("\n").length + 2;
}

/**
 * Bytes the printed JSON takes besides its file entries. "[]" becomes "[\n" + entries + "\n  ]",
 * the last entry has no ",", and printing adds a newline: 3 bytes more in all.
 */
function printedEnvelopeBytes(envelope: PullRequestDiffJson): number {
	return (
		Buffer.byteLength(safeJson({ ...envelope, files: [], truncated: false })) +
		3
	);
}

/** Control and bidi characters a path must not print raw: they would break the tab format or the terminal. */
const UNSAFE_PATH_CHARACTERS =
	/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Quotes a path that contains control or bidi characters, as git does, so each entry stays on one
 * line: the path is wrapped in double quotes and those characters are written as \uXXXX escapes.
 */
function quotePath(path: string): string {
	if (path.search(UNSAFE_PATH_CHARACTERS) === -1) return path;
	const escaped = path
		.replace(/[\\"]/g, (character) => `\\${character}`)
		.replace(
			UNSAFE_PATH_CHARACTERS,
			(character) =>
				`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	return `"${escaped}"`;
}

function formatNameOnly(file: ChangedFile): string {
	const { path, originalPath } = fileNames(file);
	const paths =
		path === originalPath
			? quotePath(path)
			: `${quotePath(originalPath)} -> ${quotePath(path)}`;
	return `${file.change}\t${paths}\n`;
}

export function createPullRequestDiffService({
	azure,
	ctx,
	pullRequests,
	maxOutputBytes = MAX_DIFF_OUTPUT_BYTES,
}: {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: Pick<PullRequestService, "resolveId">;
	maxOutputBytes?: number;
}): PullRequestDiffService {
	async function listIterations(prId: number): Promise<AzureIteration[]> {
		const url = `${pullRequestApiUrl(ctx, prId, "/iterations")}?api-version=${API_VERSION}`;
		const data = await azure.request<{ value?: AzureIteration[] }>(url);
		if (!Array.isArray(data.value) || data.value.length === 0)
			throw malformed(`PR #${prId} has no iterations`);
		return data.value;
	}

	async function listChanges(
		prId: number,
		iterationId: number,
		compareTo: number | undefined,
	): Promise<ChangedFile[]> {
		const base = `${pullRequestApiUrl(ctx, prId, `/iterations/${iterationId}/changes`)}?`;
		const compare = compareTo === undefined ? "" : `$compareTo=${compareTo}&`;
		const files: ChangedFile[] = [];
		let page: string | undefined = `$top=${MAX_CHANGES_PAGE_SIZE}&`;
		do {
			const data: AzureIterationChanges =
				await azure.request<AzureIterationChanges>(
					`${base}${page}${compare}api-version=${API_VERSION}`,
				);
			for (const entry of data.changeEntries ?? []) {
				const file = toChangedFile(entry);
				if (file) files.push(file);
			}
			page =
				data.nextSkip && data.nextTop
					? `$top=${data.nextTop}&$skip=${data.nextSkip}&`
					: undefined;
		} while (page !== undefined);
		return files;
	}

	async function getItem(path: string, commit: string): Promise<AzureItem> {
		const url =
			`${reposBaseUrl(ctx)}/items?path=${encodeURIComponent(path)}` +
			`&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit` +
			`&includeContent=true&includeContentMetadata=true&$format=json&api-version=${API_VERSION}`;
		return azure.request<AzureItem>(url);
	}

	/** Fetches Azure's line blocks for one file. Replace this to take blocks from another source. */
	async function getLineBlocks(
		file: ChangedFile,
		baseCommit: string,
		targetCommit: string,
	): Promise<LineBlock[]> {
		const url = `${reposBaseUrl(ctx)}/filediffs?api-version=${FILE_DIFFS_API_VERSION}`;
		const data = await azure.request<AzureFileDiff[]>(url, {
			method: "POST",
			body: {
				baseVersionCommit: baseCommit,
				targetVersionCommit: targetCommit,
				fileDiffParams: [{ path: file.path, originalPath: file.originalPath }],
			},
		});
		if (!Array.isArray(data)) throw malformed("file diffs must be an array");
		return toLineBlocks(data[0]);
	}

	async function getContent(
		file: ChangedFile,
		baseCommit: string,
		targetCommit: string,
	): Promise<FileContent> {
		const original =
			file.change === "add"
				? undefined
				: await getItem(file.originalPath, baseCommit);
		const modified =
			file.change === "delete"
				? undefined
				: await getItem(file.path, targetCommit);
		if (
			[original, modified].some(
				(item) =>
					item?.contentMetadata?.isBinary === true ||
					item?.content?.includes("\0"),
			)
		)
			return { binary: true };
		const originalText = original?.content ?? "";
		const modifiedText = modified?.content ?? "";
		const blocks =
			file.change === "add" || file.change === "delete"
				? wholeFileBlocks(originalText, modifiedText)
				: await getLineBlocks(file, baseCommit, targetCommit);
		return {
			binary: false,
			original: originalText,
			modified: modifiedText,
			blocks,
		};
	}

	function comparedIteration(
		prId: number,
		iterations: AzureIteration[],
		options: PullRequestDiffOptions,
	): AzureIteration | undefined {
		if (options.lastReview !== undefined)
			return iterationBefore(prId, iterations, options.lastReview);
		if (options.sinceIteration === undefined) return undefined;
		return iterationById(prId, iterations, options.sinceIteration);
	}

	async function compare(
		requestedPrId: number | undefined,
		options: PullRequestDiffOptions,
	): Promise<Comparison> {
		const prId = await pullRequests.resolveId(requestedPrId);
		const iterations = await listIterations(prId);
		const latest = latestIteration(iterations);
		const compared = comparedIteration(prId, iterations, options);

		const targetCommit = commitId(
			latest.sourceRefCommit,
			`iteration ${latest.id} source`,
		);
		const baseCommit = compared
			? commitId(compared.sourceRefCommit, `iteration ${compared.id} source`)
			: commitId(latest.commonRefCommit, `iteration ${latest.id} common`);
		const files = await listChanges(prId, latest.id, compared?.id);
		return {
			prId,
			latest,
			compared,
			lastReview: options.lastReview ?? undefined,
			baseCommit,
			targetCommit,
			files,
		};
	}

	async function diff(
		requestedPrId: number | undefined,
		options: PullRequestDiffOptions = {},
	): Promise<string> {
		const comparison = await compare(requestedPrId, options);
		const { files, baseCommit, targetCommit } = comparison;
		if (options.nameOnly) return files.map(formatNameOnly).join("");
		if (files.length === 0) return `${heading(comparison)}No file changes.\n`;

		const output = createDiffOutput(maxOutputBytes);
		for (const file of files) {
			if (output.full) break;
			const fileDiff: FileDiff = {
				path: displayPath(file.path),
				originalPath: displayPath(file.originalPath),
				change: file.change,
				...(file.contentChanged
					? { content: await getContent(file, baseCommit, targetCommit) }
					: {}),
			};
			output.add(fileDiff.path, formatFileDiff(fileDiff));
		}
		return `${heading(comparison)}${output.finish(files.length)}`;
	}

	async function textOrBinaryContent(
		file: ChangedFile,
		comparison: Comparison,
	): Promise<Pick<PullRequestDiffFile, "content" | "blocks">> {
		const content = await getContent(
			file,
			comparison.baseCommit,
			comparison.targetCommit,
		);
		if (content.binary) return { content: "binary", blocks: [] };
		return {
			content: "text",
			blocks: lineChanges(
				displayPath(file.path),
				content.original,
				content.modified,
				content.blocks,
			),
		};
	}

	/**
	 * Reads a file's content if it fits the remaining bytes, otherwise marks it `omitted`. Content
	 * isn't read when not even one empty block would fit.
	 */
	async function fileWithContent(
		file: ChangedFile,
		comparison: Comparison,
		remainingBytes: number,
	): Promise<PullRequestDiffFile> {
		const omitted = omittedFile(file);
		if (!file.contentChanged) return { ...omitted, content: "none" };
		const cost = (entry: PullRequestDiffFile) =>
			printedFileBytes(entry) - printedFileBytes(omitted);
		if (
			cost({ ...omitted, content: "text", blocks: [EMPTY_BLOCK] }) >
			remainingBytes
		)
			return omitted;
		const entry = {
			...fileNames(file),
			...(await textOrBinaryContent(file, comparison)),
		};
		return cost(entry) > remainingBytes ? omitted : entry;
	}

	/**
	 * Lists every file and adds content while the printed JSON stays within the output limit. The
	 * budget first reserves each file's `omitted` entry; a file that doesn't fit stays `omitted`
	 * and later files still get content if they fit.
	 */
	async function filesWithContent(
		comparison: Comparison,
		budget: number,
	): Promise<PullRequestDiffFile[]> {
		let remainingBytes = comparison.files.reduce(
			(bytes, file) => bytes - printedFileBytes(omittedFile(file)),
			budget,
		);
		const files: PullRequestDiffFile[] = [];
		for (const file of comparison.files) {
			const entry = await fileWithContent(file, comparison, remainingBytes);
			remainingBytes -=
				printedFileBytes(entry) - printedFileBytes(omittedFile(file));
			files.push(entry);
		}
		return files;
	}

	async function diffJson(
		requestedPrId: number | undefined,
		options: PullRequestDiffOptions = {},
	): Promise<PullRequestDiffJson> {
		const comparison = await compare(requestedPrId, options);
		const envelope: PullRequestDiffJson = {
			pullRequestId: comparison.prId,
			iteration: comparison.latest.id,
			baseIteration: comparison.compared?.id ?? null,
			lastReview: comparison.lastReview?.toISOString() ?? null,
			files: [],
			truncated: false,
		};
		if (options.nameOnly)
			return { ...envelope, files: comparison.files.map(fileNames) };
		const files = await filesWithContent(
			comparison,
			maxOutputBytes - printedEnvelopeBytes(envelope),
		);
		return {
			...envelope,
			files,
			truncated: files.some((file) => file.content === "omitted"),
		};
	}

	return { diff, diffJson };
}
