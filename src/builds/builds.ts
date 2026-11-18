import type {
	PullRequest,
	PullRequestService,
} from "../pull-requests/pull-requests.ts";
import { API_VERSION, type AzureRequester } from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import {
	type AzureBuild,
	assertFetchedBuild,
	assertRequestedBuildId,
	type BuildDependencies,
	type BuildLogMetadata,
	type BuildTimeline,
	buildBaseUrl,
	buildMutationError,
	display,
	equalsIdentifier,
	logsUrl,
	logTextUrl,
	MAX_JSON_RESPONSE_BYTES,
	normalized,
	READ_TIMEOUT_MS,
	RETRY_TIMEOUT_MS,
	resolvePullRequest,
	sanitizeError,
	type TimelineIssue,
	type TimelineRecord,
	timelineUrl,
	type ValidatedPullRequest,
	validateBuild,
	validateLogMetadata,
	validatePullRequest,
	validateTimeline,
} from "./azure-builds.ts";
import {
	DEFAULT_LOG_LINE_COUNT,
	type RequestedBuildLog,
	selectProblemLogs,
	timelineProblemRecords,
} from "./diagnosis.ts";
import {
	formatList,
	formatQueue,
	formatRequeue,
	formatRetry,
	formatShow,
	formatWaitProgress,
	formatWaitResult,
} from "./format.ts";
import {
	assertActivePullRequest,
	assertBuildAssociation,
	buildAssociation,
	headBuild,
	isCurrentBuild,
	listNewestBuilds,
	selectLatestBuild,
} from "./head-builds.ts";
import {
	branchPullRequestId,
	policyEvaluations,
	queueBranch,
	queuePr,
} from "./queue.ts";
import { productionSleep, wait } from "./wait.ts";

const MAX_DEFAULT_LOG_BYTES = 2 * 1024 * 1024;

const RETRYABLE_RESULTS = new Set(["failed", "partiallysucceeded", "canceled"]);

export interface PullRequestBuildSummary {
	id: number;
	title: string;
	status: string | null;
	draft: boolean | null;
	currentMergeCommit: string | null;
	currentHeadCommit: string | null;
}

export interface ListedBuild extends AzureBuild {
	association: BuildAssociation;
	current: boolean;
}

export interface BuildListEnvelope {
	pullRequest: PullRequestBuildSummary;
	history: boolean;
	builds: ListedBuild[];
	/** Associated builds the current-only view left out; always 0 for history. */
	hiddenBuilds: number;
}

export interface BuildLogRange {
	startLine: number;
	endLine: number;
}

export interface ProblemRecordBase {
	record: TimelineRecord;
	issues: TimelineIssue[];
}

export interface ProblemRecordWithLog extends ProblemRecordBase {
	logMetadata: BuildLogMetadata;
	logText: string;
	logMode: "tail" | "full";
	logRange: BuildLogRange | null;
}

export interface ProblemRecordWithoutLog extends ProblemRecordBase {
	noLog: true;
}

export interface ProblemRecordWithLogError extends ProblemRecordBase {
	logMetadata: BuildLogMetadata;
	logMode: "tail" | "full";
	logRange: BuildLogRange | null;
	logError: string;
}

export type ProblemRecord =
	| ProblemRecordWithLog
	| ProblemRecordWithoutLog
	| ProblemRecordWithLogError;

export type BuildAssociation = "pr-merge" | "branch-head";

export interface HeadBuild {
	association: BuildAssociation;
	current: boolean;
	build: AzureBuild;
}

export interface BuildShowEnvelope {
	association: BuildAssociation;
	pullRequest: PullRequestBuildSummary;
	current: boolean;
	build: AzureBuild;
	timeline: BuildTimeline;
	problemRecords: ProblemRecord[];
}

export interface ListBuildOptions {
	history?: boolean;
}

export interface ShowBuildOptions {
	fullLogs?: boolean;
}

export type BuildWaitOutcome =
	| "succeeded"
	| "partiallySucceeded"
	| "failed"
	| "canceled"
	| "unknown"
	| "timeout"
	| "no-build";

export interface BuildWaitEnvelope {
	association: BuildAssociation | null;
	pullRequest: PullRequestBuildSummary;
	/** The build that reached the final state; null if no build validated the head. */
	buildId: number | null;
	build: AzureBuild | null;
	pollCount: number;
	transientFailureCount: number;
	elapsedSeconds: number;
	timedOut: boolean;
	outcome: BuildWaitOutcome;
	/** Whether the build validates the PR head read when it finished; null if unknown, including on timeout. */
	validatesHead: boolean | null;
	/** When the build no longer validates the PR head: the newest build that does; null if none does yet or that lookup failed, and in every other case. */
	headBuildId: number | null;
	/** Whether the build had already finished when the wait first read it. */
	alreadyCompleted: boolean;
}

export interface BuildWaitProgressBase {
	pullRequest: PullRequestBuildSummary;
	buildId: number | null;
	build: AzureBuild | null;
	pollCount: number;
	transientFailureCount: number;
	elapsedSeconds: number;
}

export interface BuildWaitStateProgress extends BuildWaitProgressBase {
	type: "state";
	change: "initial" | "changed";
	status: string;
	result: string | null;
}

export interface BuildWaitHeartbeatProgress extends BuildWaitProgressBase {
	type: "heartbeat";
}

export interface BuildWaitTransientWarningProgress
	extends BuildWaitProgressBase {
	type: "transient-warning";
	attempt: number;
	consecutiveFailureCount: number;
	error: string;
	retryAfterMs?: number;
}

/** `--latest` selected the build that validates the head, replacing `previousBuildId` if the head moved. */
export interface BuildWaitBuildSelectedProgress extends BuildWaitProgressBase {
	type: "build-selected";
	previousBuildId: number | null;
}

/** `--latest` found no build that validates the head yet. */
export interface BuildWaitForBuildProgress extends BuildWaitProgressBase {
	type: "waiting-for-build";
}

export type BuildWaitProgress =
	| BuildWaitStateProgress
	| BuildWaitHeartbeatProgress
	| BuildWaitTransientWarningProgress
	| BuildWaitBuildSelectedProgress
	| BuildWaitForBuildProgress;

export interface WaitBuildOptions {
	intervalSeconds?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	onProgress?: (event: BuildWaitProgress) => void | Promise<void>;
}

export interface BuildService {
	list(
		requestedPrId: number | undefined,
		options?: ListBuildOptions,
	): Promise<BuildListEnvelope>;
	show(
		requestedPrId: number | undefined,
		buildId: number | "latest",
		options?: ShowBuildOptions,
	): Promise<BuildShowEnvelope>;
	retry(
		requestedPrId: number | undefined,
		buildId: number,
	): Promise<AzureBuild>;
	headBuild(pr: PullRequest): Promise<HeadBuild | null>;
	policyEvaluations(pr: PullRequest): Promise<PolicyEvaluation[]>;
	queuePr(prId: number, definitionId?: number): Promise<QueuedBuild>;
	queueBranch(branch: string, definitionId?: number): Promise<AzureBuild>;
	wait(
		requestedPrId: number | undefined,
		buildId: number | "latest",
		options?: WaitBuildOptions,
	): Promise<BuildWaitEnvelope>;
	hasLogErrors(result: BuildShowEnvelope): boolean;
	formatList(result: BuildListEnvelope): string;
	formatShow(result: BuildShowEnvelope): string;
	formatRetry(build: AzureBuild): string;
	branchPullRequestId(branch: string): Promise<number | undefined>;
	formatQueue(build: AzureBuild, prId?: number, followHead?: boolean): string;
	formatRequeue(evaluationId: string, prId: number): string;
	formatWaitProgress(event: BuildWaitProgress): string;
	formatWaitResult(result: BuildWaitEnvelope): string;
}

/** One policy evaluation of a PR, as Azure DevOps reports it for the branch policies. */
export interface PolicyEvaluation {
	name: string;
	blocking: boolean;
	/** True when the policy is approved or does not apply, so it no longer blocks the PR. */
	satisfied: boolean;
	/** Azure's status word, kept for display. */
	status: string;
}

export type QueuedBuild = { build: AzureBuild } | { evaluationId: string };

function requireCurrentMergeCommit(
	pr: ValidatedPullRequest,
	operation: string,
): string {
	if (pr.mergeCommit === undefined) {
		throw new Error(
			`Cannot ${operation}: PR #${pr.id} has no lastMergeCommit.commitId. Inspect build history instead; the current merge version will not be guessed.`,
		);
	}
	return pr.mergeCommit;
}

function finalLines(value: string, maximum: number): string {
	const trailingNewline = value.endsWith("\n");
	const lines = value.split("\n");
	if (trailingNewline) lines.pop();
	if (lines.length <= maximum) return value;
	return `${lines.slice(-maximum).join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function createBuildService({
	azure,
	ctx,
	pullRequests,
	now = () => performance.now(),
	sleep = productionSleep,
}: {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: PullRequestService;
	now?: () => number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): BuildService {
	const deps: BuildDependencies = { azure, ctx, pullRequests };

	async function fetchBuild(
		buildId: number,
		context = "build",
	): Promise<AzureBuild> {
		const url = `${buildBaseUrl(ctx)}/${buildId}?api-version=${API_VERSION}`;
		return assertFetchedBuild(
			await azure.request<unknown>(url, {
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
			buildId,
			context,
		);
	}

	async function list(
		requestedPrId: number | undefined,
		options: ListBuildOptions = {},
	): Promise<BuildListEnvelope> {
		const history = options.history === true;
		const pr = await resolvePullRequest(pullRequests, requestedPrId);
		if (!history) assertActivePullRequest(pr, "list current builds");

		const associated = (await listNewestBuilds(deps, pr)).map((build) => ({
			...build,
			association: buildAssociation(build),
			current: isCurrentBuild(build, pr),
		}));
		const builds = associated.filter((build) => history || build.current);

		if (!history) {
			const refreshed = validatePullRequest(
				await pullRequests.get(pr.id),
				"refreshed pull request",
			);
			assertActivePullRequest(refreshed, "finish listing current builds");
			if (
				refreshed.id !== pr.id ||
				!equalsIdentifier(refreshed.repositoryId, pr.repositoryId) ||
				!equalsIdentifier(refreshed.mergeCommit ?? "", pr.mergeCommit ?? "") ||
				!equalsIdentifier(refreshed.headCommit ?? "", pr.headCommit ?? "")
			) {
				throw new Error(
					`PR #${pr.id} changed while current builds were being listed; rerun the command.`,
				);
			}
		}
		return {
			pullRequest: pr.summary,
			history,
			builds,
			hiddenBuilds: associated.length - builds.length,
		};
	}

	async function fetchProblemLogs(
		buildId: number,
		requestedLogs: Map<number, RequestedBuildLog>,
	): Promise<Map<number, { text?: string; error?: string }>> {
		const logResults = new Map<number, { text?: string; error?: string }>();
		for (const [logId, request] of requestedLogs) {
			if (request.range?.endLine === 0) {
				logResults.set(logId, { text: "" });
				continue;
			}
			try {
				const text = await azure.request(
					logTextUrl(ctx, buildId, logId, request.range),
					{
						responseType: "text",
						accept: "text/plain",
						timeoutMs: READ_TIMEOUT_MS,
						...(request.mode === "tail"
							? { maxResponseBytes: MAX_DEFAULT_LOG_BYTES }
							: {}),
					},
				);
				logResults.set(logId, {
					text:
						request.mode === "tail"
							? finalLines(text, DEFAULT_LOG_LINE_COUNT)
							: text,
				});
			} catch (error) {
				logResults.set(logId, { error: sanitizeError(error) });
			}
		}
		return logResults;
	}

	async function show(
		requestedPrId: number | undefined,
		buildId: number | "latest",
		options: ShowBuildOptions = {},
	): Promise<BuildShowEnvelope> {
		if (buildId !== "latest") assertRequestedBuildId(buildId);
		const pr = await resolvePullRequest(pullRequests, requestedPrId);
		const build =
			buildId === "latest"
				? await selectLatestBuild(deps, pr)
				: await fetchBuild(buildId);
		buildId = build.id as number;
		assertBuildAssociation(build, pr);
		const timeline = validateTimeline(
			await azure.request<unknown>(timelineUrl(ctx, buildId), {
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
		);
		const logMetadata = validateLogMetadata(
			await azure.request<unknown>(logsUrl(ctx, buildId), {
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
		);
		const records = timelineProblemRecords(timeline);
		const requestedLogs = selectProblemLogs(
			buildId,
			records,
			logMetadata,
			options.fullLogs === true,
		);

		const logResults = await fetchProblemLogs(buildId, requestedLogs);

		const problemRecords: ProblemRecord[] = records.map((record) => {
			const base: ProblemRecordBase = { record, issues: record.issues ?? [] };
			if (record.log === undefined || record.log === null)
				return { ...base, noLog: true };
			const logId = record.log.id as number;
			const request = requestedLogs.get(logId) as NonNullable<
				ReturnType<typeof requestedLogs.get>
			>;
			const result = logResults.get(logId) as NonNullable<
				ReturnType<typeof logResults.get>
			>;
			if (result.error !== undefined) {
				return {
					...base,
					logMetadata: request.metadata,
					logMode: request.mode,
					logRange: request.range,
					logError: result.error,
				};
			}
			return {
				...base,
				logMetadata: request.metadata,
				logText: result.text as string,
				logMode: request.mode,
				logRange: request.range,
			};
		});

		return {
			pullRequest: pr.summary,
			current: isCurrentBuild(build, pr),
			association: buildAssociation(build),
			build,
			timeline,
			problemRecords,
		};
	}

	function assertRetryEligible(
		pr: ValidatedPullRequest,
		build: AzureBuild,
		operation: string,
	): void {
		assertActivePullRequest(pr, operation);
		assertBuildAssociation(build, pr);
		if (buildAssociation(build) === "pr-merge")
			requireCurrentMergeCommit(pr, operation);
		if (!isCurrentBuild(build, pr)) {
			throw new Error(
				`Cannot ${operation}: build ${build.id as number} is historical and does not match PR #${pr.id}'s current head or merge commit.`,
			);
		}
		if (typeof build.status !== "string") {
			throw new Error(
				`Cannot ${operation}: build ${build.id as number} has no status.`,
			);
		}
		if (normalized(build.status) !== "completed") {
			throw new Error(
				`Cannot ${operation}: build ${build.id as number} status is ${display(build.status)}; it must be completed.`,
			);
		}
		if (typeof build.result !== "string") {
			throw new Error(
				`Cannot ${operation}: build ${build.id as number} has no result.`,
			);
		}
		if (!RETRYABLE_RESULTS.has(normalized(build.result))) {
			throw new Error(
				`Cannot ${operation}: build ${build.id as number} result is ${display(build.result)}; only failed, partiallySucceeded, or canceled builds can be retried.`,
			);
		}
	}

	async function retry(
		requestedPrId: number | undefined,
		buildId: number,
	): Promise<AzureBuild> {
		assertRequestedBuildId(buildId);
		const initialPr = await resolvePullRequest(pullRequests, requestedPrId);
		const initialBuild = await fetchBuild(buildId);
		assertRetryEligible(initialPr, initialBuild, "retry build");

		const refreshedPr = validatePullRequest(
			await pullRequests.get(initialPr.id),
			"refreshed pull request",
		);
		if (refreshedPr.id !== initialPr.id) {
			throw new Error(
				`Malformed Azure DevOps response: refreshed pull request ID ${refreshedPr.id} did not match selected PR #${initialPr.id}.`,
			);
		}
		const refreshedBuild = await fetchBuild(buildId, "refreshed build");
		assertRetryEligible(
			refreshedPr,
			refreshedBuild,
			"retry build after refresh",
		);

		const url = `${buildBaseUrl(ctx)}/${buildId}?retry=true&api-version=${API_VERSION}`;
		try {
			const returnedBuild = validateBuild(
				await azure.request<unknown>(url, {
					method: "PATCH",
					body: { id: buildId },
					timeoutMs: RETRY_TIMEOUT_MS,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				}),
				"retry response build",
			);
			assertBuildAssociation(returnedBuild, refreshedPr);
			if (!isCurrentBuild(returnedBuild, refreshedPr)) {
				throw new Error(
					`Retry response build ${returnedBuild.id as number} does not match PR #${refreshedPr.id}'s current head or merge commit.`,
				);
			}
			return returnedBuild;
		} catch (error) {
			throw buildMutationError(
				error,
				`Retry request for build ${buildId}`,
				`Inspect it with \`pr.sh build show --pr ${refreshedPr.id} --build ${buildId}\` or \`pr.sh build list --pr ${refreshedPr.id} --history\` before trying again.`,
			);
		}
	}

	function hasLogErrors(result: BuildShowEnvelope): boolean {
		return result.problemRecords.some((record) => "logError" in record);
	}

	return {
		list,
		show,
		retry,
		headBuild: (pr) => headBuild(deps, pr),
		policyEvaluations: (pr) => policyEvaluations(deps, pr),
		queuePr: (prId, definitionId) => queuePr(deps, prId, definitionId),
		queueBranch: (branch, definitionId) =>
			queueBranch(deps, branch, definitionId),
		wait: (requestedPrId, buildId, options) =>
			wait({ ...deps, now, sleep }, requestedPrId, buildId, options),
		hasLogErrors,
		formatList,
		formatShow,
		formatRetry,
		branchPullRequestId: (branch) => branchPullRequestId(deps, branch),
		formatQueue,
		formatRequeue,
		formatWaitProgress,
		formatWaitResult,
	};
}
