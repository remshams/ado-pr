import type {
	PullRequest,
	PullRequestService,
} from "../pull-requests/pull-requests.ts";
import {
	API_VERSION,
	AzureRequestError,
	type AzureRequester,
	buildApiUrl,
	isAzureRequestError,
	orgProjectUrl,
	policyConfigurationsUrl,
	policyEvaluationsUrl,
	reposBaseUrl,
} from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import { stripTerminalControls } from "../shared/terminal.ts";
import {
	type AzureBuild,
	type AzureObject,
	assertFetchedBuild,
	assertRequestedBuildId,
	assertRequestedPullRequestId,
	type BuildDependencies,
	type BuildLogMetadata,
	type BuildTimeline,
	buildBaseUrl,
	buildMutationError,
	display,
	equalsIdentifier,
	isObject,
	logsUrl,
	logTextUrl,
	MAX_BUILD_PAGES,
	MAX_JSON_RESPONSE_BYTES,
	nextBuildContinuationToken,
	normalized,
	READ_TIMEOUT_MS,
	RETRY_TIMEOUT_MS,
	requireArray,
	requireObject,
	requirePositiveInteger,
	requireString,
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
	assertActivePullRequest,
	assertBuildAssociation,
	buildAssociation,
	headBuild,
	headCommitFor,
	isCurrentBuild,
	listNewestBuilds,
	selectLatestBuild,
	validatesHead,
} from "./head-builds.ts";

const DEFAULT_LOG_LINE_COUNT = 200;

const MAX_DEFAULT_LOG_BYTES = 2 * 1024 * 1024;

const DEFAULT_WAIT_INTERVAL_SECONDS = 60;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 3_600;
const MIN_WAIT_INTERVAL_SECONDS = 10;
const MAX_WAIT_INTERVAL_SECONDS = 3_600;
const MIN_WAIT_TIMEOUT_SECONDS = 10;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_HEARTBEAT_MS = 5 * 60_000;
const WAIT_FOR_BUILD_MINUTES = 10;
const WAIT_FOR_BUILD_MS = WAIT_FOR_BUILD_MINUTES * 60_000;
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 3;
const MAX_WAIT_ERROR_LENGTH = 4_096;

const MAX_DISPLAY_DEPTH = 20;

const PROBLEM_RESULTS = new Set([
	"failed",
	"succeededwithissues",
	"canceled",
	"abandoned",
]);

const RETRYABLE_RESULTS = new Set(["failed", "partiallysucceeded", "canceled"]);

const WAITING_BUILD_STATUSES = new Set([
	"notstarted",
	"inprogress",
	"cancelling",
	"postponed",
]);
const WAIT_OUTCOMES = new Map<
	string,
	Exclude<BuildWaitOutcome, "timeout" | "unknown">
>([
	["succeeded", "succeeded"],
	["partiallysucceeded", "partiallySucceeded"],
	["failed", "failed"],
	["canceled", "canceled"],
]);

const DISPLAY_RECORD_TYPES = new Set(["stage", "job", "task"]);

const SATISFIED_POLICY_STATUSES = new Set(["approved", "notapplicable"]);
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

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
}

interface BuildWaitProgressBase {
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
	formatQueue(build: AzureBuild, prId?: number): string;
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

interface OrderedTimelineRecord {
	record: TimelineRecord;
	index: number;
	depth: number;
	orphanParent: string | undefined;
	cycle: boolean;
}

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

function recordSortKey(
	record: TimelineRecord,
	index: number,
): [number, number] {
	return [record.order ?? Number.MAX_SAFE_INTEGER, index];
}

function compareRecordIndexes(
	records: TimelineRecord[],
	left: number,
	right: number,
): number {
	const [leftOrder, leftIndex] = recordSortKey(records[left], left);
	const [rightOrder, rightIndex] = recordSortKey(records[right], right);
	return leftOrder - rightOrder || leftIndex - rightIndex;
}

function findTimelineCycles(
	parentByChild: ReadonlyMap<number, number>,
	recordCount: number,
): Set<number> {
	// Each record has at most one parent, so cycle membership can be found iteratively by following
	// parent links. This avoids recursion overflow on malformed/deep timelines.
	const fullyScanned = new Set<number>();
	const cycleMembers = new Set<number>();
	for (let start = 0; start < recordCount; start += 1) {
		if (fullyScanned.has(start)) continue;
		const path: number[] = [];
		const position = new Map<number, number>();
		let current: number | undefined = start;
		while (
			current !== undefined &&
			!fullyScanned.has(current) &&
			!position.has(current)
		) {
			position.set(current, path.length);
			path.push(current);
			current = parentByChild.get(current);
		}
		if (current !== undefined && position.has(current)) {
			for (const member of path.slice(position.get(current)))
				cycleMembers.add(member);
		}
		for (const member of path) fullyScanned.add(member);
	}

	return cycleMembers;
}

interface RequestedBuildLog {
	metadata: BuildLogMetadata;
	mode: "tail" | "full";
	range: BuildLogRange | null;
}

function selectProblemLogs(
	buildId: number,
	records: TimelineRecord[],
	logMetadata: BuildLogMetadata[],
	fullLogs: boolean,
): Map<number, RequestedBuildLog> {
	const metadataById = new Map(
		logMetadata.map((metadata) => [metadata.id as number, metadata]),
	);
	const requestedLogs = new Map<number, RequestedBuildLog>();

	for (const record of records) {
		if (record.log === undefined || record.log === null) continue;
		const logId = record.log.id as number;
		const metadata = metadataById.get(logId);
		if (metadata === undefined) {
			throw new Error(
				`Build ${buildId} timeline record ${display(record.id ?? record.name)} references log ${logId}, but the build-log metadata response did not contain it.`,
			);
		}
		if (requestedLogs.has(logId)) continue;
		if (fullLogs) {
			requestedLogs.set(logId, { metadata, mode: "full", range: null });
		} else {
			if (metadata.lineCount === undefined) {
				throw new Error(
					`Build log ${logId} has no lineCount metadata; refusing to download an unbounded log. Use --full-logs only when complete, potentially sensitive output is intended.`,
				);
			}
			requestedLogs.set(logId, {
				metadata,
				mode: "tail",
				range: {
					// Azure's log ranges are zero-based with an exclusive end line.
					startLine: Math.max(0, metadata.lineCount - DEFAULT_LOG_LINE_COUNT),
					endLine: metadata.lineCount,
				},
			});
		}
	}
	return requestedLogs;
}

interface WaitDependencies extends BuildDependencies {
	now: () => number;
	sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function validateWaitBuild(
	rawBuild: unknown,
	buildId: number,
	pr: ValidatedPullRequest,
): AzureBuild & { status: string } {
	const observedBuild = assertFetchedBuild(rawBuild, buildId, "wait build");
	assertBuildAssociation(observedBuild, pr);
	if (typeof observedBuild.status !== "string") {
		throw new Error(
			`Cannot wait for build ${buildId}: Azure returned no build status.`,
		);
	}
	const observedStatus = normalized(observedBuild.status);
	if (
		observedStatus === "none" ||
		(observedStatus !== "completed" &&
			!WAITING_BUILD_STATUSES.has(observedStatus))
	) {
		throw new Error(
			`Cannot wait for build ${buildId}: Azure returned unknown build status ${display(observedBuild.status)}.`,
		);
	}
	return observedBuild as AzureBuild & { status: string };
}

function createWaitProgressEmitter(
	onProgress: WaitBuildOptions["onProgress"],
	signal: AbortSignal | undefined,
): (event: BuildWaitProgress) => Promise<void> {
	return async (event: BuildWaitProgress): Promise<void> => {
		if (onProgress !== undefined) {
			try {
				const callbackResult = onProgress(structuredClone(event));
				const callbackOutcome = Promise.resolve(callbackResult).then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				let outcome: Awaited<typeof callbackOutcome> | undefined;
				await cancellableSleep(
					async () => {
						outcome = await callbackOutcome;
					},
					0,
					signal,
				);
				if (outcome?.ok === false) throw outcome.error;
			} catch (error) {
				throwIfWaitAborted(signal);
				throw error;
			}
		}
		throwIfWaitAborted(signal);
	};
}

function orderTimelineRecords(
	timeline: BuildTimeline,
): OrderedTimelineRecord[] {
	const records = timeline.records as TimelineRecord[];
	const indexById = new Map<string, number>();
	records.forEach((record, index) => {
		if (record.id !== undefined) indexById.set(normalized(record.id), index);
	});

	const children = new Map<number, number[]>();
	const parentByChild = new Map<number, number>();
	const roots: number[] = [];
	const orphanParents = new Map<number, string>();
	records.forEach((record, index) => {
		if (record.parentId === undefined || record.parentId === null) {
			roots.push(index);
			return;
		}
		const parentIndex = indexById.get(normalized(record.parentId));
		if (parentIndex === undefined) {
			roots.push(index);
			orphanParents.set(index, record.parentId);
			return;
		}
		parentByChild.set(index, parentIndex);
		const entries = children.get(parentIndex) ?? [];
		entries.push(index);
		children.set(parentIndex, entries);
	});
	roots.sort((left, right) => compareRecordIndexes(records, left, right));
	for (const entries of children.values()) {
		entries.sort((left, right) => compareRecordIndexes(records, left, right));
	}

	const cycleMembers = findTimelineCycles(parentByChild, records.length);

	const output: OrderedTimelineRecord[] = [];
	const visited = new Set<number>();
	function appendFrom(start: number): void {
		const stack: Array<{ index: number; depth: number }> = [
			{ index: start, depth: 0 },
		];
		while (stack.length > 0) {
			const next = stack.pop() as { index: number; depth: number };
			if (visited.has(next.index)) continue;
			visited.add(next.index);
			output.push({
				record: records[next.index],
				index: next.index,
				depth: next.depth,
				orphanParent: orphanParents.get(next.index),
				cycle: cycleMembers.has(next.index),
			});
			const entries = children.get(next.index) ?? [];
			for (
				let childIndex = entries.length - 1;
				childIndex >= 0;
				childIndex -= 1
			) {
				stack.push({ index: entries[childIndex], depth: next.depth + 1 });
			}
		}
	}

	for (const root of roots) appendFrom(root);
	const remaining = records
		.map((_record, index) => index)
		.filter((index) => !visited.has(index))
		.sort((left, right) => compareRecordIndexes(records, left, right));
	for (const index of remaining) appendFrom(index);
	return output;
}

function timelineProblemRecords(timeline: BuildTimeline): TimelineRecord[] {
	return orderTimelineRecords(timeline)
		.map(({ record }) => record)
		.filter(
			(record) =>
				typeof record.result === "string" &&
				PROBLEM_RESULTS.has(normalized(record.result)),
		);
}

function buildWebLink(build: AzureBuild): string | undefined {
	const web = build._links?.web;
	return typeof web?.href === "string" && web.href.length > 0
		? web.href
		: undefined;
}

function buildDefinitionName(build: AzureBuild): string {
	return build.definition?.name ?? "unknown";
}

function finalLines(value: string, maximum: number): string {
	const trailingNewline = value.endsWith("\n");
	const lines = value.split("\n");
	if (trailingNewline) lines.pop();
	if (lines.length <= maximum) return value;
	return `${lines.slice(-maximum).join("\n")}${trailingNewline ? "\n" : ""}`;
}

function sanitizeWaitError(error: unknown): string {
	const sanitized = sanitizeError(error);
	if (sanitized.length <= MAX_WAIT_ERROR_LENGTH) return sanitized;
	const suffix = "… [truncated]";
	return `${sanitized.slice(0, MAX_WAIT_ERROR_LENGTH - suffix.length)}${suffix}`;
}

function validateWaitSeconds(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const seconds = value ?? fallback;
	if (
		!Number.isSafeInteger(seconds) ||
		seconds < minimum ||
		seconds > maximum
	) {
		throw new Error(
			`${name} must be a whole number from ${minimum} to ${maximum} seconds.`,
		);
	}
	return seconds;
}

function buildWaitAbortError(): AzureRequestError {
	return new AzureRequestError(
		"Build wait was aborted by the caller.",
		"abort",
	);
}

function throwIfWaitAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw buildWaitAbortError();
}

function productionSleep(
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(buildWaitAbortError());
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(buildWaitAbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function cancellableSleep(
	sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
	milliseconds: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfWaitAborted(signal);
	if (signal === undefined) {
		await sleep(milliseconds);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = (): void => finish(() => reject(buildWaitAbortError()));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted || settled) {
			onAbort();
			return;
		}

		let sleeping: Promise<void>;
		try {
			// Invoke immediately after installing the listener. Deferring this call would let an abort
			// settle the wrapper while still allowing an injected sleep's side effects to run later.
			sleeping = sleep(milliseconds, signal);
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		void Promise.resolve(sleeping).then(
			() => finish(resolve),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function isTransientWaitError(error: unknown): boolean {
	if (!isAzureRequestError(error)) return false;
	if (error.kind === "network" || error.kind === "timeout") return true;
	return (
		error.kind === "http" &&
		error.status !== undefined &&
		(error.status === 408 ||
			error.status === 429 ||
			(error.status >= 500 && error.status <= 599))
	);
}

function waitResultOutcome(
	build: AzureBuild,
): Exclude<BuildWaitOutcome, "timeout"> {
	if (typeof build.result !== "string") return "unknown";
	return WAIT_OUTCOMES.get(normalized(build.result)) ?? "unknown";
}

/** The Retry-After delay of an HTTP error, if Azure sent one. */
function retryAfterOf(error: unknown): number | undefined {
	return isAzureRequestError(error) && error.kind === "http"
		? error.retryAfterMs
		: undefined;
}

function yesNoUnknown(value: boolean | null): string {
	if (value === null) return "unknown";
	return value ? "yes" : "no";
}

function waitStateKey(build: AzureBuild): string {
	return `${normalized(build.status as string)}\u0000${
		typeof build.result === "string" ? normalized(build.result) : "<missing>"
	}`;
}

function policyEvaluationLabel(evaluation: AzureObject): string {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const name = configuration?.name ?? evaluation.configurationName;
	const definitionId = evaluationDefinitionId(evaluation);
	return `evaluation ${display(evaluation.evaluationId)}${typeof name === "string" ? ` (${display(name)})` : ""}${definitionId === undefined ? "" : `, build pipeline ${definitionId}`}`;
}

function evaluationDefinitionId(evaluation: AzureObject): number | undefined {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const settings = isObject(configuration?.settings)
		? configuration.settings
		: undefined;
	return typeof settings?.buildDefinitionId === "number"
		? settings.buildDefinitionId
		: undefined;
}

function isBuildPolicyEvaluation(evaluation: AzureObject): boolean {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const type =
		configuration && isObject(configuration.type)
			? configuration.type
			: undefined;
	return (
		typeof type?.id === "string" &&
		equalsIdentifier(type.id, BUILD_POLICY_TYPE_ID)
	);
}

function toPolicyEvaluation(evaluation: AzureObject): PolicyEvaluation {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const type =
		configuration && isObject(configuration.type)
			? configuration.type
			: undefined;
	const status =
		typeof evaluation.status === "string" && evaluation.status.length > 0
			? evaluation.status
			: "unknown";
	return {
		name:
			typeof type?.displayName === "string" && type.displayName.length > 0
				? type.displayName
				: "unknown policy",
		blocking: configuration?.isBlocking === true,
		satisfied: SATISFIED_POLICY_STATUSES.has(status.toLowerCase()),
		status,
	};
}

function policyConfigurationLabel(policy: AzureObject): string {
	const id = typeof policy.id === "number" ? policy.id : "unknown";
	const settings = isObject(policy.settings) ? policy.settings : undefined;
	const name = settings?.displayName ?? policy.displayName;
	return `policy ${id}${typeof name === "string" ? ` (${display(name)})` : ""}`;
}

function isBuildPolicyForRepository(
	policy: AzureObject,
	repositoryId: string,
): boolean {
	if (policy.isEnabled === false) return false;
	if (
		!isObject(policy.type) ||
		typeof policy.type.id !== "string" ||
		!equalsIdentifier(policy.type.id, BUILD_POLICY_TYPE_ID)
	)
		return false;
	if (!isObject(policy.settings) || !Array.isArray(policy.settings.scope))
		return false;
	return policy.settings.scope.some(
		(scope) =>
			isObject(scope) &&
			(scope.repositoryId == null ||
				(typeof scope.repositoryId === "string" &&
					equalsIdentifier(scope.repositoryId, repositoryId))),
	);
}

const REQUEUE_SCOPE_HINT =
	" Requeueing a policy evaluation may need more than that; this is unverified.";

function formatBuildRow(build: ListedBuild): string {
	return [
		`- Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
		`  Association: ${build.association}`,
		`  Status/result: ${display(build.status)}/${display(build.result)} [${build.current ? "current" : "history"}]`,
		`  Queue/start/finish: ${display(build.queueTime)} / ${display(build.startTime)} / ${display(build.finishTime)}`,
		`  ${display(buildWebLink(build))}`,
	].join("\n");
}

function formatTimeline(result: BuildShowEnvelope): string[] {
	const rows = orderTimelineRecords(result.timeline).filter(({ record }) =>
		DISPLAY_RECORD_TYPES.has(normalized(record.type ?? "")),
	);
	if (rows.length === 0) return ["(no stage/job/task records)"];
	return rows.map(({ record, depth, orphanParent, cycle }) => {
		const anomaly = [
			...(orphanParent === undefined
				? []
				: [`orphan parent ${display(orphanParent)}`]),
			...(cycle ? ["cycle"] : []),
			...(depth > MAX_DISPLAY_DEPTH ? [`depth ${depth}`] : []),
		];
		return (
			`${"  ".repeat(Math.min(depth, MAX_DISPLAY_DEPTH))}- ${display(record.type)}/${display(record.name)}: ` +
			`state=${display(record.state)}, result=${display(record.result)}, attempt=${display(record.attempt)}` +
			(anomaly.length === 0 ? "" : ` [${anomaly.join(", ")}]`)
		);
	});
}

function formatProblemRecord(problem: ProblemRecord, index: number): string {
	const record = problem.record;
	const header =
		`Problem ${index + 1}: ${display(record.type)}/${display(record.name)} ` +
		`[${display(record.result)}]`;
	const issues =
		problem.issues.length === 0
			? ["Issues: (none)"]
			: [
					"Issues:",
					...problem.issues.map(
						(issue) =>
							`- ${display(issue.type)}/${display(issue.category)}: ${display(issue.message)}`,
					),
				];
	if ("noLog" in problem) {
		return [header, ...issues, "Log: (no log reference)"].join("\n");
	}
	const mode =
		problem.logMode === "full"
			? "full log (potentially sensitive)"
			: `tail log (lines ${problem.logRange?.startLine}-${problem.logRange?.endLine})`;
	if ("logError" in problem) {
		return [
			header,
			...issues,
			`Log (${mode}): ERROR: ${display(problem.logError)}`,
		].join("\n");
	}
	return [
		header,
		...issues,
		`Log (${mode}):`,
		stripTerminalControls(problem.logText),
	].join("\n");
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

	async function fetchPolicyEvaluations(
		pr: ValidatedPullRequest,
		purpose: string,
	): Promise<AzureObject[]> {
		const projectId = pr.projectId;
		if (typeof projectId !== "string" || projectId.length === 0) {
			throw new Error(
				`Cannot ${purpose} for PR #${pr.id}: Azure DevOps did not return its project ID.`,
			);
		}
		const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.id}`;
		const evaluationResponse = requireObject(
			await azure.request<unknown>(policyEvaluationsUrl(ctx, artifactId), {
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
			"policy evaluations response",
		);
		return requireArray(
			evaluationResponse.value,
			"policy evaluations response.value",
		).map((value, index) =>
			requireObject(value, `policy evaluation ${index + 1}`),
		);
	}

	async function policyEvaluations(
		pr: PullRequest,
	): Promise<PolicyEvaluation[]> {
		const validated = validatePullRequest(pr, "pull request");
		return (
			await fetchPolicyEvaluations(validated, "read policy evaluations")
		).map(toPolicyEvaluation);
	}

	async function queuePr(
		prId: number,
		definitionId?: number,
	): Promise<QueuedBuild> {
		assertRequestedPullRequestId(prId);
		const pr = await resolvePullRequest(pullRequests, prId);
		const evaluations = await fetchPolicyEvaluations(pr, "queue a build");
		const candidates = evaluations
			.filter((evaluation) => isBuildPolicyEvaluation(evaluation))
			.map((evaluation, index) => {
				const id = requireString(
					evaluation.evaluationId,
					`build policy evaluation ${index + 1}.evaluationId`,
				);
				return {
					id,
					definitionId: evaluationDefinitionId(evaluation),
					label: policyEvaluationLabel(evaluation),
				};
			});
		if (candidates.length === 0) {
			throw new Error(`No build policy evaluation was found for PR #${pr.id}.`);
		}
		const matches =
			definitionId === undefined
				? candidates
				: candidates.filter(
						(candidate) => candidate.definitionId === definitionId,
					);
		if (matches.length === 0) {
			throw new Error(
				`No build policy evaluation for build pipeline (definition) ${definitionId} was found for PR #${pr.id}. Candidates: ${candidates.map((candidate) => candidate.label).join("; ")}.`,
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`More than one build policy evaluation was found for PR #${pr.id}${definitionId === undefined ? ". Choose one with --definition <id>" : ` for build pipeline ${definitionId}`}: ${matches.map((candidate) => candidate.label).join("; ")}.`,
			);
		}

		const candidate = matches[0];
		let response: unknown;
		try {
			response = await requeueEvaluation(candidate.id);
		} catch (error) {
			throw buildMutationError(
				error,
				`Requeue request for build policy evaluation ${candidate.id} on PR #${pr.id}`,
				`Inspect it with \`pr.sh build show --latest --pr ${pr.id}\` or \`pr.sh build list --pr ${pr.id} --history\` before trying again.`,
				REQUEUE_SCOPE_HINT,
			);
		}
		let buildId: number | undefined;
		try {
			buildId = requeuedBuildId(response);
		} catch (error) {
			throw new Error(
				`Requeue request for build policy evaluation ${candidate.id} on PR #${pr.id} was accepted, but Azure DevOps sent an invalid build ID or response. Find the new build with \`pr.sh build list --pr ${pr.id} --history\`.\n${sanitizeError(error)}`,
			);
		}
		if (buildId === undefined) return { evaluationId: candidate.id };
		try {
			return {
				build: assertFetchedBuild(
					await azure.request<unknown>(
						`${buildApiUrl(ctx)}/${buildId}?api-version=${API_VERSION}`,
						{
							timeoutMs: READ_TIMEOUT_MS,
							maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
						},
					),
					buildId,
					"requeued build response",
				),
			};
		} catch (error) {
			throw new Error(
				`Requeued build policy evaluation ${candidate.id} on PR #${pr.id}; reading build ${buildId} failed. Check it with \`pr.sh build show --build ${buildId} --pr ${pr.id}\`.\n${sanitizeError(error)}`,
			);
		}
	}

	/** Sends the requeue request and returns the response body. */
	async function requeueEvaluation(evaluationId: string): Promise<unknown> {
		const evaluationUrl = `${orgProjectUrl(ctx)}/_apis/policy/evaluations/${evaluationId}?api-version=7.1-preview.1`;
		return azure.request<unknown>(evaluationUrl, {
			method: "PATCH",
			body: { status: "queued" },
			timeoutMs: RETRY_TIMEOUT_MS,
			maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
		});
	}

	/** Azure sends no build ID, or null, until the requeued build exists. */
	function requeuedBuildId(response: unknown): number | undefined {
		const body = requireObject(response, "requeued policy evaluation response");
		const context =
			body.context === undefined || body.context === null
				? undefined
				: requireObject(body.context, "requeued policy evaluation context");
		const buildId = context?.buildId;
		if (buildId === undefined || buildId === null) return undefined;
		return requirePositiveInteger(
			buildId,
			"requeued policy evaluation context.buildId",
		);
	}

	async function listBuildPolicies(): Promise<AzureObject[]> {
		const policies: AzureObject[] = [];
		const seenContinuationTokens = new Set<string>();
		let continuationToken: string | undefined;
		let pageCount = 0;
		do {
			pageCount += 1;
			if (pageCount > MAX_BUILD_PAGES) {
				throw new Error(
					`Azure DevOps policy pagination exceeded the safety limit of ${MAX_BUILD_PAGES} pages.`,
				);
			}
			const query =
				`&policyType=${BUILD_POLICY_TYPE_ID}` +
				(continuationToken === undefined
					? ""
					: `&continuationToken=${encodeURIComponent(continuationToken)}`);
			const response = await azure.requestWithMetadata<unknown>(
				`${policyConfigurationsUrl(ctx)}${query}`,
				{
					timeoutMs: READ_TIMEOUT_MS,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				},
			);
			const page = requireArray(
				requireObject(response.data, "policy configurations response").value,
				"policy configurations response.value",
			);
			for (const value of page)
				policies.push(
					requireObject(value, `policy configuration ${policies.length + 1}`),
				);
			continuationToken = nextBuildContinuationToken(
				response.metadata.headers,
				seenContinuationTokens,
				"policy",
			);
		} while (continuationToken !== undefined);
		return policies;
	}

	async function resolveBranchDefinition(): Promise<number> {
		const repository = requireObject(
			await azure.request<unknown>(
				`${reposBaseUrl(ctx)}?api-version=${API_VERSION}`,
				{
					timeoutMs: READ_TIMEOUT_MS,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				},
			),
			"repository response",
		);
		const repositoryId = requireString(repository.id, "repository response.id");
		const repositoryPolicies = (await listBuildPolicies()).filter((policy) =>
			isBuildPolicyForRepository(policy, repositoryId),
		);
		if (repositoryPolicies.length === 0) {
			throw new Error(
				`No build policy was found for repository ${ctx.repository}. Pass --definition <id> to queue a build pipeline directly.`,
			);
		}
		const definitions = new Map<number, AzureObject[]>();
		for (const policy of repositoryPolicies) {
			const settings = requireObject(policy.settings, "build policy settings");
			const definitionId = requirePositiveInteger(
				settings.buildDefinitionId,
				"build policy settings.buildDefinitionId",
			);
			const matchingPolicies = definitions.get(definitionId) ?? [];
			matchingPolicies.push(policy);
			definitions.set(definitionId, matchingPolicies);
		}
		if (definitions.size > 1) {
			const candidates = [...definitions.entries()]
				.map(
					([definitionId, policies]) =>
						`build pipeline ${definitionId}: ${policies.map(policyConfigurationLabel).join(", ")}`,
				)
				.join("; ");
			throw new Error(
				`More than one build pipeline was found for repository ${ctx.repository}. Choose one with --definition <id>: ${candidates}.`,
			);
		}
		return definitions.keys().next().value as number;
	}

	async function queueBranch(
		branch: string,
		requestedDefinitionId?: number,
	): Promise<AzureBuild> {
		const sourceBranch = branch.startsWith("refs/")
			? branch
			: `refs/heads/${branch}`;
		const definitionId =
			requestedDefinitionId ?? (await resolveBranchDefinition());
		try {
			return validateBuild(
				await azure.request<unknown>(
					`${buildApiUrl(ctx)}?api-version=${API_VERSION}`,
					{
						method: "POST",
						body: { definition: { id: definitionId }, sourceBranch },
						timeoutMs: RETRY_TIMEOUT_MS,
						maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
					},
				),
				"queued branch build",
			);
		} catch (error) {
			throw buildMutationError(
				error,
				`Queue request for build pipeline ${definitionId} on ${sourceBranch}`,
				`Check that build pipeline's runs for ${sourceBranch} in Azure DevOps before trying again.`,
			);
		}
	}

	async function wait(
		requestedPrId: number | undefined,
		requestedBuild: number | "latest",
		options: WaitBuildOptions = {},
	): Promise<BuildWaitEnvelope> {
		const signal = options.signal;
		const onProgress = options.onProgress;
		if (requestedBuild !== "latest") assertRequestedBuildId(requestedBuild);
		const intervalSeconds = validateWaitSeconds(
			options.intervalSeconds,
			DEFAULT_WAIT_INTERVAL_SECONDS,
			MIN_WAIT_INTERVAL_SECONDS,
			MAX_WAIT_INTERVAL_SECONDS,
			"Build wait interval",
		);
		const timeoutSeconds = validateWaitSeconds(
			options.timeoutSeconds,
			DEFAULT_WAIT_TIMEOUT_SECONDS,
			MIN_WAIT_TIMEOUT_SECONDS,
			MAX_WAIT_TIMEOUT_SECONDS,
			"Build wait timeout",
		);
		throwIfWaitAborted(signal);
		const prReadOptions = {
			signal,
			timeoutMs: READ_TIMEOUT_MS,
			maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
		};
		let pr = await resolvePullRequest(
			pullRequests,
			requestedPrId,
			prReadOptions,
		);
		throwIfWaitAborted(signal);

		const followsHead = requestedBuild === "latest";
		let buildId: number | null = followsHead ? null : requestedBuild;
		let previousBuildId: number | null = null;

		const startedAt = now();
		let waitingForBuildSince = startedAt;
		let announcedWaitForHead: string | undefined;
		const deadline = startedAt + timeoutSeconds * 1_000;
		const intervalMs = intervalSeconds * 1_000;
		let nextPollAt = startedAt;
		let nextHeartbeatAt = startedAt + WAIT_HEARTBEAT_MS;
		let latestBuild: AzureBuild | null = null;
		let pollCount = 0;
		let transientFailureCount = 0;
		let consecutiveTransientFailures = 0;
		let previousStateKey: string | undefined;

		const elapsedSeconds = (at = now()): number =>
			Math.max(0, at - startedAt) / 1_000;
		/** The result when no build reached a final state. */
		const unfinishedEnvelope = (
			outcome: "timeout" | "no-build",
			at = now(),
		): BuildWaitEnvelope => ({
			association: latestBuild === null ? null : buildAssociation(latestBuild),
			pullRequest: pr.summary,
			buildId,
			build: latestBuild,
			pollCount,
			transientFailureCount,
			elapsedSeconds: elapsedSeconds(at),
			timedOut: outcome === "timeout",
			outcome,
			validatesHead: null,
		});
		const progressBase = (at = now()): BuildWaitProgressBase => ({
			pullRequest: pr.summary,
			buildId,
			build: latestBuild,
			pollCount,
			transientFailureCount,
			elapsedSeconds: elapsedSeconds(at),
		});
		const emit = createWaitProgressEmitter(onProgress, signal);

		/** Polls at `at`, but no later than the deadline or, while no build is selected, the end of the wait for one. */
		const scheduleNextPoll = (at: number): void => {
			nextPollAt = Math.min(
				deadline,
				buildId === null ? waitingForBuildSince + WAIT_FOR_BUILD_MS : at,
				at,
			);
		};

		const waitForBuildEnded = (at: number): boolean =>
			buildId === null && at - waitingForBuildSince >= WAIT_FOR_BUILD_MS;

		const waitLabel = (): string =>
			buildId === null
				? `Build wait for PR #${pr.id}`
				: `Build ${buildId} wait`;

		async function handlePollError(
			error: unknown,
			completedAt: number,
		): Promise<BuildWaitEnvelope | undefined> {
			throwIfWaitAborted(signal);
			if (isAzureRequestError(error) && error.kind === "abort") throw error;

			const transient = isTransientWaitError(error);
			if (transient) {
				transientFailureCount += 1;
				consecutiveTransientFailures += 1;
			}
			if (completedAt >= deadline)
				return unfinishedEnvelope("timeout", completedAt);
			if (!transient) throw error;
			if (waitForBuildEnded(completedAt))
				return unfinishedEnvelope("no-build", completedAt);

			const retryAfterMs = retryAfterOf(error);
			const errorText = sanitizeWaitError(error);
			await emit({
				type: "transient-warning",
				...progressBase(completedAt),
				attempt: pollCount,
				consecutiveFailureCount: consecutiveTransientFailures,
				error: errorText,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			});
			if (consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
				throw new Error(
					`${waitLabel()} stopped after ${consecutiveTransientFailures} consecutive transient Azure DevOps failures: ${errorText}`,
				);
			}
			scheduleNextPoll(completedAt + Math.max(intervalMs, retryAfterMs ?? 0));
			return undefined;
		}

		async function rereadPullRequest(
			timeoutMs: number,
		): Promise<ValidatedPullRequest> {
			return validatePullRequest(
				await pullRequests.get(pr.id, { ...prReadOptions, timeoutMs }),
				"refreshed pull request",
			);
		}

		function headValidity(
			observedBuild: AzureBuild,
			current: ValidatedPullRequest,
		): Pick<BuildWaitEnvelope, "pullRequest" | "validatesHead"> {
			const headKnown = headCommitFor(observedBuild, current) !== undefined;
			return {
				pullRequest: current.summary,
				validatesHead: headKnown ? validatesHead(observedBuild, current) : null,
			};
		}

		/** Rereads the PR once the build finished; validatesHead is null if that isn't possible. */
		async function refreshedHead(
			observedBuild: AzureBuild,
		): Promise<Pick<BuildWaitEnvelope, "pullRequest" | "validatesHead">> {
			const remainingMs = Math.ceil(deadline - now());
			if (remainingMs <= 0)
				return { pullRequest: pr.summary, validatesHead: null };
			try {
				return headValidity(
					observedBuild,
					await rereadPullRequest(Math.min(READ_TIMEOUT_MS, remainingMs)),
				);
			} catch (error) {
				throwIfWaitAborted(signal);
				if (isAzureRequestError(error) && error.kind === "abort") throw error;
				return { pullRequest: pr.summary, validatesHead: null };
			}
		}

		async function observeBuild(
			rawBuild: unknown,
			selectedBuildId: number,
			completedAt: number,
		): Promise<BuildWaitEnvelope | undefined> {
			const observedBuild = validateWaitBuild(rawBuild, selectedBuildId, pr);
			const observedStatus = normalized(observedBuild.status);

			latestBuild = observedBuild;
			consecutiveTransientFailures = 0;
			const stateKey = waitStateKey(observedBuild);
			if (stateKey !== previousStateKey) {
				await emit({
					type: "state",
					...progressBase(completedAt),
					change: previousStateKey === undefined ? "initial" : "changed",
					status: observedBuild.status,
					result:
						typeof observedBuild.result === "string"
							? observedBuild.result
							: null,
				});
				previousStateKey = stateKey;
			}
			if (observedStatus !== "completed") return undefined;
			const { pullRequest, validatesHead } = followsHead
				? headValidity(observedBuild, pr)
				: await refreshedHead(observedBuild);
			return {
				association: buildAssociation(observedBuild),
				pullRequest,
				buildId,
				build: observedBuild,
				pollCount,
				transientFailureCount,
				elapsedSeconds: elapsedSeconds(completedAt),
				timedOut: false,
				outcome: waitResultOutcome(observedBuild),
				validatesHead,
			};
		}

		async function emitHeartbeat(current: number): Promise<void> {
			await emit({ type: "heartbeat", ...progressBase(current) });
			do nextHeartbeatAt += WAIT_HEARTBEAT_MS;
			while (nextHeartbeatAt <= current);
		}

		/** Rereads the PR and drops the selected build when the source head moved. */
		async function followHead(requestTimeoutMs: number): Promise<void> {
			const refreshed = await rereadPullRequest(requestTimeoutMs);
			if (!equalsIdentifier(refreshed.headCommit ?? "", pr.headCommit ?? "")) {
				if (buildId !== null) previousBuildId = buildId;
				buildId = null;
				latestBuild = null;
				previousStateKey = undefined;
				waitingForBuildSince = now();
			}
			pr = refreshed;
		}

		/** Follows the head if asked, selects its build if none is selected, and reads that build. */
		async function requestPoll(requestTimeoutMs: number): Promise<unknown> {
			if (followsHead && pollCount > 1) await followHead(requestTimeoutMs);
			if (buildId === null) {
				assertActivePullRequest(pr, "wait for a build of the PR head");
				const selected = (await listNewestBuilds(deps, pr, signal)).find(
					(candidate) => isCurrentBuild(candidate, pr),
				);
				if (selected === undefined) return undefined;
				buildId = selected.id as number;
				await emit({
					type: "build-selected",
					...progressBase(),
					previousBuildId,
				});
			}
			return azure.request<unknown>(
				`${buildBaseUrl(ctx)}/${buildId}?api-version=${API_VERSION}`,
				{
					timeoutMs: requestTimeoutMs,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
					signal,
				},
			);
		}

		async function awaitHeadBuild(
			completedAt: number,
		): Promise<BuildWaitEnvelope | undefined> {
			consecutiveTransientFailures = 0;
			if (waitForBuildEnded(completedAt))
				return unfinishedEnvelope("no-build", completedAt);
			const head = pr.headCommit ?? "";
			if (announcedWaitForHead !== head) {
				announcedWaitForHead = head;
				await emit({ type: "waiting-for-build", ...progressBase(completedAt) });
			}
			scheduleNextPoll(completedAt + intervalMs);
			return undefined;
		}

		async function pollBuild(
			current: number,
		): Promise<BuildWaitEnvelope | undefined> {
			const remainingMs = Math.max(1, Math.ceil(deadline - current));
			pollCount += 1;
			const requestTimeoutMs = Math.min(READ_TIMEOUT_MS, remainingMs);
			let rawBuild: unknown;
			let completedAt: number;
			try {
				rawBuild = await requestPoll(requestTimeoutMs);
				completedAt = now();
			} catch (error) {
				completedAt = now();
				return handlePollError(error, completedAt);
			}

			throwIfWaitAborted(signal);
			if (completedAt >= deadline)
				return unfinishedEnvelope("timeout", completedAt);
			if (buildId === null) return awaitHeadBuild(completedAt);
			const result = await observeBuild(rawBuild, buildId, completedAt);
			if (!result) nextPollAt = Math.min(deadline, completedAt + intervalMs);
			return result;
		}

		while (true) {
			throwIfWaitAborted(signal);
			const current = now();
			if (current >= deadline) return unfinishedEnvelope("timeout", current);
			if (current >= nextHeartbeatAt) {
				await emitHeartbeat(current);
				continue;
			}

			if (current < nextPollAt) {
				const wakeAt = Math.min(nextPollAt, nextHeartbeatAt, deadline);
				await cancellableSleep(sleep, Math.max(0, wakeAt - current), signal);
				throwIfWaitAborted(signal);
				continue;
			}

			const result = await pollBuild(current);
			if (result) return result;
		}
	}

	function hasLogErrors(result: BuildShowEnvelope): boolean {
		return result.problemRecords.some((record) => "logError" in record);
	}

	function formatList(result: BuildListEnvelope): string {
		const scope = result.history ? "history" : "current head";
		if (result.builds.length === 0) {
			const hint =
				result.hiddenBuilds === 0
					? ""
					: ` ${result.hiddenBuilds} stale ${result.hiddenBuilds === 1 ? "build exists" : "builds exist"}; use build list --history or build show --latest.`;
			return `No associated ${scope} builds found for PR #${result.pullRequest.id}.${hint}`;
		}
		return [
			`Builds for PR #${result.pullRequest.id}: ${display(result.pullRequest.title)} (${scope})`,
			"",
			...result.builds.flatMap((build, index) => [
				formatBuildRow(build),
				...(index === result.builds.length - 1 ? [] : [""]),
			]),
		].join("\n");
	}

	function formatShow(result: BuildShowEnvelope): string {
		const build = result.build;
		const problemSections =
			result.problemRecords.length === 0
				? ["(no problem records)"]
				: result.problemRecords.map(formatProblemRecord);
		return [
			`Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
			`PR: #${result.pullRequest.id} (${result.current ? "current" : "history; stale"})`,
			`Association: ${result.association}; commit: ${display(build.sourceVersion)}`,
			`Status/result: ${display(build.status)}/${display(build.result)}`,
			`Queue/start/finish: ${display(build.queueTime)} / ${display(build.startTime)} / ${display(build.finishTime)}`,
			`URL: ${display(buildWebLink(build))}`,
			"",
			"Timeline:",
			...formatTimeline(result),
			"",
			result.problemRecords.some(
				(problem) => "logMode" in problem && problem.logMode === "full",
			)
				? "Problem diagnostics (FULL LOGS; potentially sensitive):"
				: "Problem diagnostics (final 200 lines per log):",
			...problemSections.flatMap((section, index) => [
				...(index === 0 ? [] : [""]),
				section,
			]),
		].join("\n");
	}

	function formatRetry(build: AzureBuild): string {
		validateBuild(build, "retry result build");
		return [
			`Azure DevOps accepted the retry request for build ${build.id as number}/${display(build.buildNumber)}.`,
			`Association: ${buildAssociation(build)}`,
			`Returned status/result: ${display(build.status)}/${display(build.result)}`,
			`URL: ${display(buildWebLink(build))}`,
		].join("\n");
	}

	function formatQueue(build: AzureBuild, prId?: number): string {
		const definition = build.definition;
		return [
			`Azure DevOps queued build ${build.id as number}/${display(build.buildNumber)}.`,
			...(typeof definition?.name === "string"
				? [
						`Build pipeline: ${display(definition.name)}${typeof definition.id === "number" ? ` (${definition.id})` : ""}`,
					]
				: []),
			`URL: ${display(buildWebLink(build))}`,
			...(prId === undefined
				? []
				: [
						`Wait with: pr.sh build wait --build ${build.id as number} --pr ${prId}`,
					]),
		].join("\n");
	}

	function formatRequeue(evaluationId: string, prId: number): string {
		return [
			`Requeued build policy evaluation ${display(evaluationId)} for PR #${prId}.`,
			`Azure DevOps did not return the build ID yet. When \`pr.sh build show --latest --pr ${prId}\` shows a new build ID, run \`pr.sh build wait --build <id> --pr ${prId}\`.`,
		].join("\n");
	}

	/** The one active pull request that has the branch as its source, if any. */
	async function branchPullRequestId(
		branch: string,
	): Promise<number | undefined> {
		const found = await pullRequests.findActiveForBranch(branch);
		if (found.length > 1) {
			throw new Error(
				`Multiple active pull requests have ${branch} as their source: ${found.map((pr) => `#${pr.pullRequestId}`).join(", ")}. Run \`pr.sh build wait --build <id> --pr <id>\` with the one you want.`,
			);
		}
		return found[0]?.pullRequestId;
	}

	function formatWaitProgress(event: BuildWaitProgress): string {
		const state = `${display(event.build?.status)}/${display(event.build?.result)}`;
		const counters =
			`${event.elapsedSeconds.toFixed(1)}s elapsed; ${event.pollCount} poll(s); ` +
			`${event.transientFailureCount} transient failure(s)`;
		const prefix =
			event.buildId === null
				? `PR #${event.pullRequest.id}`
				: `PR #${event.pullRequest.id}, build ${event.buildId}`;
		const head = display(event.pullRequest.currentHeadCommit);
		if (event.type === "build-selected") {
			const replaced =
				event.previousBuildId === null
					? ""
					: ` The head moved, so build ${event.previousBuildId} no longer counts.`;
			return `${prefix}: selected for head ${head}.${replaced}`;
		}
		if (event.type === "waiting-for-build") {
			return `${prefix}: no build validates head ${head} yet; waiting for one.`;
		}
		if (event.type === "state") {
			return `${prefix}: ${event.change} state ${state}; ${counters}.`;
		}
		if (event.type === "heartbeat") {
			return `${prefix}: still waiting at ${state}; ${counters}.`;
		}
		return (
			`${prefix}: transient warning on attempt ${event.attempt} ` +
			`(consecutive ${event.consecutiveFailureCount}): ${display(event.error)}; ` +
			`${state}; ${counters}.`
		);
	}

	function formatNoBuild(result: BuildWaitEnvelope, counters: string): string {
		const pr = result.pullRequest;
		return (
			`No build validated the head of PR #${pr.id} (commit ${display(pr.currentHeadCommit)}) within ${WAIT_FOR_BUILD_MINUTES} minutes; ${counters}.\n` +
			`Draft: ${yesNoUnknown(pr.draft)}. Check that the build policy runs for this pull request, or queue a build with \`pr.sh build queue --pr ${pr.id}\`.`
		);
	}

	function formatTimeout(
		result: BuildWaitEnvelope,
		statusResult: string,
		counters: string,
	): string {
		const pr = result.pullRequest;
		if (result.buildId === null) {
			return `build wait for PR #${pr.id} timed out before a build validated head ${display(pr.currentHeadCommit)}; ${counters}.`;
		}
		return (
			`build ${result.buildId} for PR #${pr.id} timed out. ` +
			`Latest status/result: ${statusResult}; ${counters}.\nAssociation: ${display(result.association)}`
		);
	}

	function formatWaitResult(result: BuildWaitEnvelope): string {
		const buildId = result.buildId;
		const identifier = buildId === null ? "build wait" : `build ${buildId}`;
		const statusResult = `${display(result.build?.status)}/${display(result.build?.result)}`;
		const counters =
			`${result.elapsedSeconds.toFixed(1)}s elapsed; ${result.pollCount} poll(s); ` +
			`${result.transientFailureCount} transient failure(s)`;
		if (result.outcome === "no-build") return formatNoBuild(result, counters);
		if (result.timedOut) return formatTimeout(result, statusResult, counters);
		const lines = [
			`${identifier} for PR #${result.pullRequest.id} finished with outcome ${display(result.outcome)}.`,
			`Status/result: ${statusResult}; ${counters}.`,
			`Association: ${display(result.association)}`,
			`Validates head: ${yesNoUnknown(result.validatesHead)}`,
		];
		if (
			result.validatesHead === false &&
			result.pullRequest.status?.toLowerCase() === "active"
		) {
			lines.push(
				`This build doesn't validate the current head of the pull request; wait for the build that does with \`pr.sh build wait --latest --pr ${result.pullRequest.id}\`.`,
			);
		}
		if (result.outcome !== "succeeded" && buildId !== null) {
			lines.push(
				`Inspect failure details with \`pr.sh build show --pr ${result.pullRequest.id} --build ${buildId}\`.`,
			);
		}
		return lines.join("\n");
	}

	return {
		list,
		show,
		retry,
		headBuild: (pr) => headBuild(deps, pr),
		policyEvaluations,
		queuePr,
		queueBranch,
		wait,
		hasLogErrors,
		formatList,
		formatShow,
		formatRetry,
		branchPullRequestId,
		formatQueue,
		formatRequeue,
		formatWaitProgress,
		formatWaitResult,
	};
}
