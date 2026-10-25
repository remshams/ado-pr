import {
	type BuildService,
	type HeadBuild,
	type PolicyEvaluation,
	stripTerminalControls,
} from "../builds/builds.ts";
import {
	countUnresolvedThreads,
	type ThreadService,
} from "../comments/threads.ts";
import {
	type PullRequest,
	type PullRequestService,
	type ReviewerSummary,
	summarizeReviewers,
} from "../pull-requests/pull-requests.ts";
import {
	API_VERSION,
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

/** Blocking policies that are neither approved nor not applicable. */
export interface BlockingPolicy {
	name: string;
	status: string;
}

export type PolicyReport =
	| { kind: "listed"; policies: BlockingPolicy[] }
	| { kind: "unavailable"; error: string };

export interface StatusBuild {
	id: number | null;
	number: string | null;
	status: string | null;
	result: string | null;
	sourceVersion: string | null;
	association: HeadBuild["association"];
	validatesHead: boolean;
}

/** The `pr status --json` document: a domain value that holds no raw Azure DevOps objects. */
export interface StatusCopilot {
	state: CopilotActivity["state"];
	/** The comment text, set only when the state is `other`. */
	text: string | null;
	date: string | null;
}

export interface PullRequestStatus {
	id: number;
	title: string;
	state: string | null;
	draft: boolean | null;
	url: string;
	headCommit: string | null;
	mergeCommit: string | null;
	iteration: number | null;
	build: StatusBuild | null;
	copilot: StatusCopilot;
	unresolvedThreads: number;
	mergeStatus: string | null;
	conflicts: ConflictReport;
	blockingPolicies: PolicyReport;
	reviewers: ReviewerSummary[];
}

export interface StatusService {
	get(requestedPrId: number | undefined): Promise<PullRequestStatus>;
	format(status: PullRequestStatus): string;
}

interface AzureIteration {
	id?: number;
}

interface AzureConflict {
	conflictPath?: string;
	conflictType?: string;
}

function safe(value: string | null | undefined): string {
	return stripTerminalControls(value ?? "unknown");
}

function toStatusBuild(build: HeadBuild | null): StatusBuild | null {
	if (build === null) return null;
	const azureBuild = build.build;
	return {
		id: azureBuild.id ?? null,
		number: azureBuild.buildNumber ?? null,
		status: azureBuild.status ?? null,
		result: azureBuild.result ?? null,
		sourceVersion: azureBuild.sourceVersion ?? null,
		association: build.association,
		validatesHead: build.current,
	};
}

function toStatusCopilot(copilot: CopilotActivity): StatusCopilot {
	return {
		state: copilot.state,
		text: copilot.text ?? null,
		date: copilot.date ?? null,
	};
}

function formatBuild(build: StatusBuild | null, headCommit: string | null) {
	if (build === null) return "none (no build is associated with this PR)";
	const outcome = build.result ?? build.status;
	const label = `build ${build.id} (${safe(build.number)}, ${build.association})`;
	if (build.validatesHead)
		return `${safe(outcome)} - ${label} validates the head`;
	return (
		`stale - no build validates head ${headCommit ?? "(unavailable)"}; ` +
		`newest is ${label} at ${safe(build.sourceVersion)} with ${safe(outcome)}`
	);
}

function blockingPolicies(evaluations: PolicyEvaluation[]): BlockingPolicy[] {
	return evaluations
		.filter((evaluation) => evaluation.blocking && !evaluation.satisfied)
		.map(({ name, status }) => ({ name, status }));
}

function formatBlockingPolicies(report: PolicyReport): string {
	if (report.kind === "unavailable")
		return `could not be listed (${safe(report.error)})`;
	if (report.policies.length === 0) return "none";
	return report.policies
		.map((policy) => `${safe(policy.name)} (${safe(policy.status)})`)
		.join(", ");
}

function formatReviewers(reviewers: ReviewerSummary[]): string {
	if (reviewers.length === 0) return "none";
	return reviewers
		.map(
			(reviewer) =>
				`${safe(reviewer.name)}: ${reviewer.voteLabel}${reviewer.required ? " (required)" : ""}`,
		)
		.join(", ");
}

function formatCopilot(copilot: StatusCopilot): string {
	if (copilot.state === "none") return "none";
	const label =
		copilot.state === "other"
			? `"${safe(copilot.text).replace(/\s+/g, " ").slice(0, MAX_COPILOT_TEXT)}"`
			: copilot.state;
	return `${label} (${safe(copilot.date)})`;
}

function formatConflicts(conflicts: ConflictReport): string[] {
	if (conflicts.kind === "unavailable")
		return [`Conflicts: could not be listed (${safe(conflicts.error)})`];
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

	/** The highest iteration number, or null when Azure sent none or the request failed. */
	async function latestIteration(prId: number): Promise<number | null> {
		const url = `${pullRequestApiUrl(ctx, prId, "/iterations")}?api-version=${API_VERSION}`;
		try {
			const data = await azure.request<{ value?: AzureIteration[] }>(url);
			const ids = (data.value ?? []).flatMap((iteration) =>
				typeof iteration.id === "number" ? [iteration.id] : [],
			);
			return ids.length > 0 ? Math.max(...ids) : null;
		} catch {
			return null;
		}
	}

	async function listBlockingPolicies(
		pullRequest: PullRequest,
	): Promise<PolicyReport> {
		try {
			const evaluations = await builds.policyEvaluations(pullRequest);
			return { kind: "listed", policies: blockingPolicies(evaluations) };
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
		const iteration = await latestIteration(prId);
		const mergeStatus = pullRequest.mergeStatus ?? null;
		return {
			id: prId,
			title: pullRequest.title,
			state: pullRequest.status ?? null,
			draft: pullRequest.isDraft ?? null,
			url: pullRequestWebUrl(ctx, prId),
			headCommit: pullRequest.lastMergeSourceCommit?.commitId ?? null,
			mergeCommit: pullRequest.lastMergeCommit?.commitId ?? null,
			iteration,
			build: toStatusBuild(build),
			copilot: toStatusCopilot(latestCopilotActivity(allThreads)),
			unresolvedThreads: countUnresolvedThreads(allThreads),
			mergeStatus,
			conflicts:
				mergeStatus?.toLowerCase() === "conflicts"
					? await listConflicts(prId)
					: { kind: "none" },
			blockingPolicies: await listBlockingPolicies(pullRequest),
			reviewers: summarizeReviewers(pullRequest.reviewers),
		};
	}

	function format(status: PullRequestStatus): string {
		const draft =
			status.draft === null ? "unknown" : status.draft ? "yes" : "no";
		return [
			`PR #${status.id}: ${safe(status.title)} (${safe(status.state)})`,
			status.url,
			`Draft: ${draft}`,
			`Head: ${status.headCommit ?? "unknown"}`,
			`Merge commit: ${status.mergeCommit ?? "unknown"}`,
			`Iteration: ${status.iteration ?? "unknown"}`,
			`Build: ${formatBuild(status.build, status.headCommit)}`,
			`Copilot review (best effort): ${formatCopilot(status.copilot)}`,
			`Unresolved threads: ${status.unresolvedThreads}`,
			`Merge status: ${status.mergeStatus ?? "unknown"}`,
			...formatConflicts(status.conflicts),
			`Blocked by: ${formatBlockingPolicies(status.blockingPolicies)}`,
			`Reviewers: ${formatReviewers(status.reviewers)}`,
		].join("\n");
	}

	return { get, format };
}
