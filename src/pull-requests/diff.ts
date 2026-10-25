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
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type { PullRequestService } from "./pull-requests.ts";
import {
	createDiffOutput,
	type FileChangeKind,
	type FileContent,
	type FileDiff,
	formatFileDiff,
	type LineBlock,
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
}

export interface PullRequestDiffService {
	diff(
		requestedPrId: number | undefined,
		options?: PullRequestDiffOptions,
	): Promise<string>;
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

/** Picks the latest iteration and, for --since-iteration, the one to compare with. */
function selectIterations(
	prId: number,
	iterations: AzureIteration[],
	since: number | undefined,
): { latest: AzureIteration; compared?: AzureIteration } {
	const latest = iterations.reduce((newest, iteration) =>
		iteration.id > newest.id ? iteration : newest,
	);
	if (since === undefined) return { latest };
	const compared = iterations.find((iteration) => iteration.id === since);
	if (!compared)
		throw new Error(
			`PR #${prId} has no iteration ${since}; the latest iteration is ${latest.id}.`,
		);
	return { latest, compared };
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

	async function diff(
		requestedPrId: number | undefined,
		options: PullRequestDiffOptions = {},
	): Promise<string> {
		const prId = await pullRequests.resolveId(requestedPrId);
		const { latest, compared } = selectIterations(
			prId,
			await listIterations(prId),
			options.sinceIteration,
		);

		const targetCommit = commitId(
			latest.sourceRefCommit,
			`iteration ${latest.id} source`,
		);
		const baseCommit = compared
			? commitId(compared.sourceRefCommit, `iteration ${compared.id} source`)
			: commitId(latest.commonRefCommit, `iteration ${latest.id} common`);
		const files = await listChanges(prId, latest.id, compared?.id);

		const heading = `PR #${prId}: iteration ${latest.id} compared with ${
			compared ? `iteration ${compared.id}` : "the merge base"
		}.\n`;
		if (files.length === 0) return `${heading}No file changes.\n`;

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
		return `${heading}${output.finish(files.length)}`;
	}

	return { diff };
}
