import {
	API_VERSION,
	type AzureRequester,
	getAuthenticatedUserId,
	isAzureRequestError,
	pullRequestApiUrl,
	pullRequestWebUrl,
} from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type { PullRequest, PullRequestService } from "./pull-requests.ts";

/** CLI merge strategy names and the Azure DevOps merge strategies they select. */
const AZURE_MERGE_STRATEGIES = {
	merge: "noFastForward",
	squash: "squash",
	rebase: "rebase",
	"rebase-merge": "rebaseMerge",
} as const;

export type MergeStrategy = keyof typeof AZURE_MERGE_STRATEGIES;
export const MERGE_STRATEGIES = Object.keys(
	AZURE_MERGE_STRATEGIES,
) as MergeStrategy[];

export interface CompletePullRequestOptions {
	mergeStrategy: MergeStrategy;
	deleteSourceBranch: boolean;
	auto: boolean;
}

/** What a completion request led to: auto-complete set, the PR merged, or Azure still merging. */
export type CompletionOutcome = "autoCompleteSet" | "merged" | "merging";

/** What `pr complete` asked Azure DevOps to do and what came of it. */
export interface PullRequestCompletion {
	pullRequestId: number;
	title: string;
	outcome: CompletionOutcome;
	/** The head commit sent with the completion; null when only auto-complete was set. */
	headCommit: string | null;
	/** Azure's merge status, shown while Azure is still merging. */
	mergeStatus: string | null;
	mergeStrategy: MergeStrategy;
	deleteSourceBranch: boolean;
}

export interface PullRequestCompletionService {
	complete(
		requestedPrId: number | undefined,
		options: CompletePullRequestOptions,
	): Promise<PullRequestCompletion>;
	format(result: PullRequestCompletion): string;
}

const FAILED_MERGE_STATUSES = new Set<string | undefined>([
	"conflicts",
	"rejectedByPolicy",
	"failure",
]);
const PENDING_MERGE_STATUSES = new Set<string | undefined>([
	"queued",
	"notSet",
]);

/** Maps Azure's status and merge status after a completion request to the merge progress. */
function mergeProgress(pr: PullRequest): "merged" | "merging" | "failed" {
	if (FAILED_MERGE_STATUSES.has(pr.mergeStatus)) return "failed";
	return pr.status === "completed" &&
		!PENDING_MERGE_STATUSES.has(pr.mergeStatus)
		? "merged"
		: "merging";
}

function statusCommand(prId: number): string {
	return `\`pr.sh pr status --pr ${prId}\``;
}

function statusHint(prId: number): string {
	return `Run ${statusCommand(prId)} to see blocking policies, merge conflicts and the current head.`;
}

function completionRequestError(
	error: unknown,
	prId: number,
	headCommit: string | null,
): unknown {
	if (!isAzureRequestError(error)) return error;
	if (error.kind !== "http") {
		const request = headCommit ? "completion" : "auto-complete";
		return new Error(
			`${error.message}\nThe ${request} may have been applied. Run ${statusCommand(prId)} before retrying.`,
		);
	}
	const action = headCommit ? "completing" : "setting auto-complete on";
	return new Error(
		[
			`Azure DevOps rejected ${action} PR #${prId} (HTTP ${error.status}): ${error.azureMessage ?? error.message}`,
			...(headCommit
				? [
						`Sent head commit ${headCommit}. If the source branch has moved since, review the new commits before completing again.`,
					]
				: []),
			statusHint(prId),
		].join("\n"),
	);
}

function formatOptions(result: PullRequestCompletion): string {
	return `Options: merge strategy ${result.mergeStrategy}${result.deleteSourceBranch ? ", delete source branch" : ""}`;
}

export function createPullRequestCompletionService({
	azure,
	ctx,
	pullRequests,
}: {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: PullRequestService;
}): PullRequestCompletionService {
	/** Sets auto-complete for the authenticated user; Azure merges whatever head passes policy. */
	async function autoCompleteBody(): Promise<Record<string, unknown>> {
		const userId = await getAuthenticatedUserId(azure, ctx.organization);
		return { autoCompleteSetBy: { id: userId } };
	}

	/** The head read just now, sent as lastMergeSourceCommit like the Azure CLI does. */
	function headCommitOf(pr: PullRequest): string {
		const headCommit = pr.lastMergeSourceCommit?.commitId;
		if (headCommit) return headCommit;
		throw new Error(
			`PR #${pr.pullRequestId} has no source head commit to complete.\n${statusHint(pr.pullRequestId)}`,
		);
	}

	async function patch(
		prId: number,
		body: Record<string, unknown>,
		headCommit: string | null,
	): Promise<PullRequest> {
		const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
		try {
			return await azure.request<PullRequest>(url, { method: "PATCH", body });
		} catch (error) {
			throw completionRequestError(error, prId, headCommit);
		}
	}

	function outcomeOf(updated: PullRequest, auto: boolean): CompletionOutcome {
		if (auto) return "autoCompleteSet";
		const progress = mergeProgress(updated);
		if (progress !== "failed") return progress;
		throw new Error(
			`Azure DevOps could not merge PR #${updated.pullRequestId} (merge status: ${updated.mergeStatus}): ${updated.mergeFailureMessage ?? "Azure gave no reason."}\n${statusHint(updated.pullRequestId)}`,
		);
	}

	async function complete(
		requestedPrId: number | undefined,
		options: CompletePullRequestOptions,
	): Promise<PullRequestCompletion> {
		const pr = await pullRequests.resolve(requestedPrId);
		const prId = pr.pullRequestId;
		const headCommit = options.auto ? null : headCommitOf(pr);
		const body = headCommit
			? { status: "completed", lastMergeSourceCommit: { commitId: headCommit } }
			: await autoCompleteBody();
		// Keep completion options set earlier, for example in the UI, and overlay the flags given.
		const completionOptions = {
			...pr.completionOptions,
			mergeStrategy: AZURE_MERGE_STRATEGIES[options.mergeStrategy],
			...(options.deleteSourceBranch ? { deleteSourceBranch: true } : {}),
		};
		const updated = await patch(
			prId,
			{ ...body, completionOptions },
			headCommit,
		);
		return {
			pullRequestId: prId,
			title: updated.title,
			outcome: outcomeOf(updated, options.auto),
			headCommit,
			mergeStatus: updated.mergeStatus ?? null,
			mergeStrategy: options.mergeStrategy,
			deleteSourceBranch: completionOptions.deleteSourceBranch === true,
		};
	}

	function format(result: PullRequestCompletion): string {
		const id = result.pullRequestId;
		const lines = {
			autoCompleteSet: [
				`Set auto-complete on PR #${id}: ${result.title}`,
				"Azure DevOps completes it once the required policies pass, at whatever head passes them, including later pushes.",
			],
			merged: [
				`Completed PR #${id}: ${result.title}`,
				`Head commit: ${result.headCommit}`,
			],
			merging: [
				`Requested completion of PR #${id}: ${result.title}`,
				`Head commit: ${result.headCommit}`,
				`Azure DevOps is still merging (merge status: ${result.mergeStatus ?? "unknown"}). Run ${statusCommand(id)} to check the result.`,
			],
		}[result.outcome];
		return [...lines, formatOptions(result), pullRequestWebUrl(ctx, id)].join(
			"\n",
		);
	}

	return { complete, format };
}
