import {
	type HeadBuild,
	stripTerminalControls,
	type BuildService,
} from "../builds/builds.ts";
import {
	countUnresolvedThreads,
	type ThreadService,
} from "../comments/threads.ts";
import {
	formatReviewerVotes,
	type PullRequest,
	type PullRequestService,
} from "../pull-requests/pull-requests.ts";
import {
	pullRequestApiUrl,
	pullRequestWebUrl,
	type AzureRequester,
} from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import {
	latestCopilotActivity,
	type CopilotActivity,
} from "./copilot-activity.ts";

/** The conflicts resource is still a preview API in Azure DevOps 7.1. */
const CONFLICTS_API_VERSION = "7.1-preview.1";
const MAX_CONFLICTS = 50;
const MAX_COPILOT_TEXT = 120;

export interface PullRequestConflict {
	path: string;
	type: string;
}

export type ConflictReport =
	| { kind: "none" }
	| { kind: "listed"; conflicts: PullRequestConflict[] }
	| { kind: "unavailable"; error: string };

export interface PullRequestStatus {
	pullRequest: PullRequest;
	headCommit: string | null;
	build: HeadBuild | null;
	copilot: CopilotActivity;
	unresolvedThreads: number;
	mergeStatus: string | null;
	conflicts: ConflictReport;
}

export interface StatusService {
	get(requestedPrId: number | undefined): Promise<PullRequestStatus>;
	format(status: PullRequestStatus): string;
}

interface AzureConflict {
	conflictPath?: string;
	conflictType?: string;
}

function safe(value: string | undefined): string {
	return stripTerminalControls(value ?? "unknown");
}

function formatBuild(build: HeadBuild | null, headCommit: string | null) {
	if (build === null) return "none (no build is associated with this PR)";
	const azureBuild = build.build;
	const outcome = azureBuild.result ?? azureBuild.status;
	const label = `build ${azureBuild.id} (${safe(azureBuild.buildNumber)}, ${build.association})`;
	if (build.current) return `${safe(outcome)} - ${label} validates the head`;
	return (
		`stale - no build validates head ${headCommit ?? "(unavailable)"}; ` +
		`newest is ${label} at ${safe(azureBuild.sourceVersion)} with ${safe(outcome)}`
	);
}

function formatCopilot(copilot: CopilotActivity): string {
	if (copilot.state === "none") return "none";
	const label =
		copilot.state === "other"
			? `"${safe(copilot.text).replace(/\s+/g, " ").slice(0, MAX_COPILOT_TEXT)}"`
			: copilot.state;
	return `${label} (${safe(copilot.date)})`;
}

function formatConflicts(conflicts: ConflictReport): string[] {
	if (conflicts.kind === "unavailable")
		return [`Conflicts: could not be listed (${conflicts.error})`];
	if (conflicts.kind === "none") return [];
	return [
		`Conflicts (${conflicts.conflicts.length}):`,
		...conflicts.conflicts.map(
			(conflict) => `  - ${safe(conflict.path)} (${safe(conflict.type)})`,
		),
	];
}

export function createStatusService({
	azure,
	ctx,
	pullRequests,
	builds,
	threads,
}: {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: PullRequestService;
	builds: BuildService;
	threads: ThreadService;
}): StatusService {
	async function listConflicts(prId: number): Promise<ConflictReport> {
		const url = `${pullRequestApiUrl(ctx, prId, "/conflicts")}?$top=${MAX_CONFLICTS}&api-version=${CONFLICTS_API_VERSION}`;
		try {
			const data = await azure.request<{ value?: AzureConflict[] }>(url);
			const conflicts = (data.value ?? []).map((conflict) => ({
				path: conflict.conflictPath ?? "unknown path",
				type: conflict.conflictType ?? "unknown",
			}));
			return { kind: "listed", conflicts };
		} catch (error) {
			return { kind: "unavailable", error: (error as Error).message };
		}
	}

	// Requests run one after another: the output needs all of them and the call count stays small.
	async function get(
		requestedPrId: number | undefined,
	): Promise<PullRequestStatus> {
		const pullRequest = await pullRequests.resolve(requestedPrId);
		const prId = pullRequest.pullRequestId;
		const build = await builds.headBuild(pullRequest);
		const allThreads = await threads.listAll(prId);
		const mergeStatus = pullRequest.mergeStatus ?? null;
		return {
			pullRequest,
			headCommit: pullRequest.lastMergeSourceCommit?.commitId ?? null,
			build,
			copilot: latestCopilotActivity(allThreads),
			unresolvedThreads: countUnresolvedThreads(allThreads),
			mergeStatus,
			conflicts:
				mergeStatus?.toLowerCase() === "conflicts"
					? await listConflicts(prId)
					: { kind: "none" },
		};
	}

	function format(status: PullRequestStatus): string {
		const { pullRequest } = status;
		const votes = formatReviewerVotes(pullRequest.reviewers);
		return [
			`PR #${pullRequest.pullRequestId}: ${safe(pullRequest.title)} (${safe(pullRequest.status)}${pullRequest.isDraft ? ", draft" : ""})`,
			pullRequestWebUrl(ctx, pullRequest.pullRequestId),
			`Head: ${status.headCommit ?? "unknown"}`,
			`Build: ${formatBuild(status.build, status.headCommit)}`,
			`Copilot review (best effort): ${formatCopilot(status.copilot)}`,
			`Unresolved threads: ${status.unresolvedThreads}`,
			`Merge status: ${status.mergeStatus ?? "unknown"}`,
			...formatConflicts(status.conflicts),
			`Reviewers: ${votes.length > 0 ? safe(votes.join(", ")) : "none"}`,
		].join("\n");
	}

	return { get, format };
}
