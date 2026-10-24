import {
	API_VERSION,
	AzureRequestError,
	isAzureRequestError,
	orgProjectUrl,
} from "../shared/azure.ts";
import type { AzureRequester } from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type {
	PullRequest,
	PullRequestReadOptions,
	PullRequestService,
} from "../pull-requests/pull-requests.ts";
import {
	buildApiUrl,
	policyConfigurationsUrl,
	policyEvaluationsUrl,
	reposBaseUrl,
} from "../shared/azure.ts";

const BUILD_PAGE_SIZE = 100;
const DEFAULT_LOG_LINE_COUNT = 200;
const MAX_BUILD_PAGES = 1_000;
const MAX_BUILD_RESPONSES = 100_000;
const MAX_CONTINUATION_TOKEN_LENGTH = 8_192;
const MAX_TIMELINE_RECORDS = 50_000;
const MAX_LOG_METADATA_RECORDS = 50_000;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DEFAULT_LOG_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
const RETRY_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_INTERVAL_SECONDS = 60;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 3_600;
const MIN_WAIT_INTERVAL_SECONDS = 10;
const MAX_WAIT_INTERVAL_SECONDS = 3_600;
const MIN_WAIT_TIMEOUT_SECONDS = 10;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_HEARTBEAT_MS = 5 * 60_000;
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
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

interface AzureObject {
	[key: string]: unknown;
}

export interface BuildRepository extends AzureObject {
	id?: string;
	name?: string;
	type?: string;
}

export interface BuildDefinition extends AzureObject {
	id?: number;
	name?: string;
}

export interface BuildLink extends AzureObject {
	href?: string;
}

export interface AzureBuild extends AzureObject {
	id?: number;
	buildNumber?: string;
	status?: string;
	result?: string;
	reason?: string;
	sourceBranch?: string;
	sourceVersion?: string;
	queueTime?: string;
	startTime?: string;
	finishTime?: string;
	repository?: BuildRepository;
	definition?: BuildDefinition;
	_links?: Record<string, BuildLink>;
}

export interface TimelineIssue extends AzureObject {
	type?: string;
	category?: string;
	message?: string;
}

export interface TimelineLogReference extends AzureObject {
	id?: number;
}

export interface TimelineRecord extends AzureObject {
	id?: string;
	parentId?: string | null;
	type?: string;
	name?: string;
	state?: string;
	result?: string;
	attempt?: number;
	order?: number;
	issues?: TimelineIssue[];
	log?: TimelineLogReference | null;
}

export interface BuildTimeline extends AzureObject {
	records?: TimelineRecord[];
}

export interface BuildLogMetadata extends AzureObject {
	id?: number;
	type?: string;
	url?: string;
	lineCount?: number;
}

export interface PullRequestBuildSummary {
	id: number;
	title: string;
	status: string | null;
	draft: boolean | null;
	currentMergeCommit: string | null;
}

export interface BuildListEnvelope {
	pullRequest: PullRequestBuildSummary;
	history: boolean;
	builds: AzureBuild[];
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

type BuildAssociation = "pr-merge" | "branch-head";

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
	| "timeout";

export interface BuildWaitEnvelope {
	association: BuildAssociation | null;
	pullRequest: PullRequestBuildSummary;
	buildId: number;
	build: AzureBuild | null;
	pollCount: number;
	transientFailureCount: number;
	elapsedSeconds: number;
	timedOut: boolean;
	outcome: BuildWaitOutcome;
}

interface BuildWaitProgressBase {
	pullRequest: PullRequestBuildSummary;
	buildId: number;
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

export type BuildWaitProgress =
	| BuildWaitStateProgress
	| BuildWaitHeartbeatProgress
	| BuildWaitTransientWarningProgress;

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
	queuePr(prId: number): Promise<QueuedBuild>;
	queueBranch(branch: string): Promise<AzureBuild>;
	wait(
		requestedPrId: number | undefined,
		buildId: number | "latest",
		options?: WaitBuildOptions,
	): Promise<BuildWaitEnvelope>;
	hasLogErrors(result: BuildShowEnvelope): boolean;
	formatList(result: BuildListEnvelope): string;
	formatShow(result: BuildShowEnvelope): string;
	formatRetry(build: AzureBuild): string;
	formatQueue(build: AzureBuild): string;
	formatWaitProgress(event: BuildWaitProgress): string;
	formatWaitResult(result: BuildWaitEnvelope): string;
}

export type QueuedBuild = { build: AzureBuild } | { evaluationId: string };

interface ValidatedPullRequest {
	id: number;
	repositoryId: string;
	projectId: string | undefined;
	status: string | undefined;
	mergeCommit: string | undefined;
	headCommit: string | undefined;
	sourceBranch: string;
	summary: PullRequestBuildSummary;
}

interface OrderedTimelineRecord {
	record: TimelineRecord;
	index: number;
	depth: number;
	orphanParent: string | undefined;
	cycle: boolean;
}

function isObject(value: unknown): value is AzureObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeField(context: string, field: string): string {
	return `${context}.${field}`;
}

function requireObject(value: unknown, context: string): AzureObject {
	if (!isObject(value)) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be an object.`,
		);
	}
	return value;
}

function requireArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be an array.`,
		);
	}
	return value;
}

function requireString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be a non-empty string.`,
		);
	}
	return value;
}

function optionalString(value: unknown, context: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(value, context);
}

function requirePositiveInteger(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be a positive safe integer.`,
		);
	}
	return value;
}

function optionalNonNegativeInteger(
	value: unknown,
	context: string,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be a non-negative safe integer.`,
		);
	}
	return value;
}

function assertRequestedBuildId(buildId: number): void {
	if (!Number.isSafeInteger(buildId) || buildId < 1) {
		throw new Error("Build ID must be a positive safe integer.");
	}
}

function assertRequestedPullRequestId(requestedPrId: number | undefined): void {
	if (
		requestedPrId !== undefined &&
		(!Number.isSafeInteger(requestedPrId) || requestedPrId < 1)
	) {
		throw new Error("Pull request ID must be a positive safe integer.");
	}
}

function equalsIdentifier(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function normalized(value: string): string {
	return value.toLowerCase();
}

function optionalCommit(value: unknown, context: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(
		requireObject(value, context).commitId,
		describeField(context, "commitId"),
	);
}

function validatePullRequest(
	pr: PullRequest,
	context: string,
): ValidatedPullRequest {
	const value = requireObject(pr, context) as unknown as PullRequest;
	const id = requirePositiveInteger(
		value.pullRequestId,
		describeField(context, "pullRequestId"),
	);
	const title = requireString(value.title, describeField(context, "title"));
	const sourceBranch = requireString(
		value.sourceRefName,
		describeField(context, "sourceRefName"),
	);
	const repository = requireObject(
		value.repository,
		describeField(context, "repository"),
	);
	const repositoryId = requireString(
		repository.id,
		describeField(context, "repository.id"),
	);
	requireString(repository.name, describeField(context, "repository.name"));
	const repositoryProject = isObject(repository.project)
		? repository.project
		: undefined;
	const projectId =
		typeof repositoryProject?.id === "string"
			? repositoryProject.id
			: undefined;
	const status = optionalString(value.status, describeField(context, "status"));
	if (value.isDraft !== undefined && typeof value.isDraft !== "boolean") {
		throw new Error(
			`Malformed Azure DevOps response: ${describeField(context, "isDraft")} must be a boolean.`,
		);
	}

	const mergeCommit = optionalCommit(
		value.lastMergeCommit,
		describeField(context, "lastMergeCommit"),
	);
	const headCommit = optionalCommit(
		value.lastMergeSourceCommit,
		describeField(context, "lastMergeSourceCommit"),
	);

	return {
		id,
		repositoryId,
		projectId,
		headCommit,
		sourceBranch,
		status,
		mergeCommit,
		summary: {
			id,
			title,
			status: status ?? null,
			draft: value.isDraft ?? null,
			currentMergeCommit: mergeCommit ?? null,
		},
	};
}

function assertActivePullRequest(
	pr: ValidatedPullRequest,
	operation: string,
): void {
	if (pr.status === undefined) {
		throw new Error(
			`Cannot ${operation}: PR #${pr.id} has no status in the Azure DevOps response.`,
		);
	}
	if (normalized(pr.status) !== "active") {
		throw new Error(
			`Cannot ${operation}: PR #${pr.id} is ${display(pr.status)}; only active pull requests are eligible. Use build history/show for completed or abandoned pull requests.`,
		);
	}
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

function validateBuild(value: unknown, context: string): AzureBuild {
	const build = requireObject(value, context) as AzureBuild;
	requirePositiveInteger(build.id, describeField(context, "id"));
	optionalString(build.buildNumber, describeField(context, "buildNumber"));
	optionalString(build.status, describeField(context, "status"));
	optionalString(build.result, describeField(context, "result"));
	requireString(build.reason, describeField(context, "reason"));
	requireString(build.sourceBranch, describeField(context, "sourceBranch"));
	requireString(build.sourceVersion, describeField(context, "sourceVersion"));
	optionalString(build.queueTime, describeField(context, "queueTime"));
	optionalString(build.startTime, describeField(context, "startTime"));
	optionalString(build.finishTime, describeField(context, "finishTime"));

	const repository = requireObject(
		build.repository,
		describeField(context, "repository"),
	);
	requireString(repository.id, describeField(context, "repository.id"));
	requireString(repository.type, describeField(context, "repository.type"));
	optionalString(repository.name, describeField(context, "repository.name"));

	if (build.definition !== undefined && build.definition !== null) {
		const definition = requireObject(
			build.definition,
			describeField(context, "definition"),
		);
		if (definition.id !== undefined) {
			requirePositiveInteger(
				definition.id,
				describeField(context, "definition.id"),
			);
		}
		optionalString(definition.name, describeField(context, "definition.name"));
	}
	if (build._links !== undefined && build._links !== null) {
		const links = requireObject(build._links, describeField(context, "_links"));
		for (const [name, rawLink] of Object.entries(links)) {
			const link = requireObject(rawLink, `${context}._links.${name}`);
			optionalString(link.href, `${context}._links.${name}.href`);
		}
	}
	return build;
}

function buildAssociationMismatch(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): string | undefined {
	const repository = build.repository as BuildRepository;
	if (!equalsIdentifier(repository.id as string, pr.repositoryId))
		return "repository ID";
	if (!equalsIdentifier(repository.type as string, "TfsGit"))
		return "repository type";
	if (build.sourceBranch === pr.sourceBranch) return undefined;
	if (!equalsIdentifier(build.reason as string, "pullRequest")) return "reason";
	if (build.sourceBranch !== `refs/pull/${pr.id}/merge`) return "source branch";
	return undefined;
}

function assertBuildAssociation(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): void {
	const mismatch = buildAssociationMismatch(build, pr);
	if (mismatch !== undefined) {
		throw new Error(
			`Build ${build.id as number} is not associated with PR #${pr.id}: ${mismatch} does not match.`,
		);
	}
}

function buildAssociation(build: AzureBuild): BuildAssociation {
	return (build.sourceBranch as string).startsWith("refs/heads/")
		? "branch-head"
		: "pr-merge";
}

function isCurrentBuild(build: AzureBuild, pr: ValidatedPullRequest): boolean {
	const commit =
		buildAssociation(build) === "branch-head" ? pr.headCommit : pr.mergeCommit;
	return (
		pr.status !== undefined &&
		normalized(pr.status) === "active" &&
		commit !== undefined &&
		equalsIdentifier(build.sourceVersion as string, commit)
	);
}

function validateTimeline(value: unknown): BuildTimeline {
	const timeline = requireObject(value, "timeline") as BuildTimeline;
	const rawRecords = requireArray(timeline.records, "timeline.records");
	if (rawRecords.length > MAX_TIMELINE_RECORDS) {
		throw new Error(
			`Azure DevOps timeline returned ${rawRecords.length} records; the safety limit is ${MAX_TIMELINE_RECORDS}.`,
		);
	}
	const ids = new Set<string>();
	timeline.records = rawRecords.map((rawRecord, index) => {
		const context = `timeline.records[${index}]`;
		const record = requireObject(rawRecord, context) as TimelineRecord;
		if (record.id !== undefined && record.id !== null) {
			const id = requireString(record.id, describeField(context, "id"));
			const normalizedId = normalized(id);
			if (ids.has(normalizedId)) {
				throw new Error(
					`Malformed Azure DevOps response: duplicate case-insensitive timeline record ID "${stripTerminalControls(id)}".`,
				);
			}
			ids.add(normalizedId);
		}
		optionalString(record.parentId, describeField(context, "parentId"));
		optionalString(record.type, describeField(context, "type"));
		optionalString(record.name, describeField(context, "name"));
		optionalString(record.state, describeField(context, "state"));
		optionalString(record.result, describeField(context, "result"));
		optionalNonNegativeInteger(
			record.attempt,
			describeField(context, "attempt"),
		);
		optionalNonNegativeInteger(record.order, describeField(context, "order"));

		if (record.issues !== undefined && record.issues !== null) {
			record.issues = requireArray(
				record.issues,
				describeField(context, "issues"),
			).map((rawIssue, issueIndex) => {
				const issueContext = `${context}.issues[${issueIndex}]`;
				const issue = requireObject(rawIssue, issueContext) as TimelineIssue;
				optionalString(issue.type, describeField(issueContext, "type"));
				optionalString(issue.category, describeField(issueContext, "category"));
				optionalString(issue.message, describeField(issueContext, "message"));
				return issue;
			});
		}
		if (record.log !== undefined && record.log !== null) {
			const log = requireObject(record.log, describeField(context, "log"));
			requirePositiveInteger(log.id, describeField(context, "log.id"));
		}
		return record;
	});
	return timeline;
}

function validateLogMetadata(value: unknown): BuildLogMetadata[] {
	const envelope = requireObject(value, "build logs response");
	const logs = requireArray(envelope.value, "build logs response.value");
	if (logs.length > MAX_LOG_METADATA_RECORDS) {
		throw new Error(
			`Azure DevOps returned ${logs.length} build-log records; the safety limit is ${MAX_LOG_METADATA_RECORDS}.`,
		);
	}
	const ids = new Set<number>();
	return logs.map((rawLog, index) => {
		const context = `build logs response.value[${index}]`;
		const log = requireObject(rawLog, context) as BuildLogMetadata;
		const id = requirePositiveInteger(log.id, describeField(context, "id"));
		if (ids.has(id)) {
			throw new Error(
				`Malformed Azure DevOps response: duplicate build log ID ${id}.`,
			);
		}
		ids.add(id);
		optionalString(log.type, describeField(context, "type"));
		optionalString(log.url, describeField(context, "url"));
		optionalNonNegativeInteger(
			log.lineCount,
			describeField(context, "lineCount"),
		);
		return log;
	});
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

function appendAssociatedBuilds(
	builds: AzureBuild[],
	page: AzureBuild[],
	pr: ValidatedPullRequest,
	mergeCommit: string | undefined,
	seenBuildIds: Set<number>,
): void {
	for (const build of page) {
		if (buildAssociationMismatch(build, pr) !== undefined) continue;
		if (
			mergeCommit !== undefined &&
			!equalsIdentifier(build.sourceVersion as string, mergeCommit as string)
		) {
			continue;
		}
		const buildId = build.id as number;
		if (seenBuildIds.has(buildId)) {
			throw new Error(
				`Azure DevOps build pagination returned duplicate build ID ${buildId}; refusing an ambiguous result.`,
			);
		}
		seenBuildIds.add(buildId);
		builds.push(build);
	}
}

function nextBuildContinuationToken(
	headers: Headers,
	seenContinuationTokens: Set<string>,
	resource = "build",
): string | undefined {
	const nextToken = headers.get("x-ms-continuationtoken") ?? undefined;
	if (nextToken === undefined || nextToken.length === 0) {
		return undefined;
	} else {
		if (nextToken.length > MAX_CONTINUATION_TOKEN_LENGTH) {
			throw new Error(
				`Azure DevOps ${resource} pagination returned an oversized continuation token.`,
			);
		}
		if (seenContinuationTokens.has(nextToken)) {
			throw new Error(
				`Azure DevOps ${resource} pagination repeated a continuation token; refusing to loop.`,
			);
		}
		seenContinuationTokens.add(nextToken);
		return nextToken;
	}
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

function display(value: unknown): string {
	if (typeof value === "string" && value.length > 0) {
		return stripTerminalControls(value)
			.replace(/[\r\n]+/g, " ")
			.replace(/\t/g, " ");
	}
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return "unknown";
}

/** Removes ANSI/terminal control sequences while preserving ordinary log tabs and newlines. */
export function stripTerminalControls(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-_]/g, "")
		.replace(
			/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g,
			"",
		);
}

function finalLines(value: string, maximum: number): string {
	const trailingNewline = value.endsWith("\n");
	const lines = value.split("\n");
	if (trailingNewline) lines.pop();
	if (lines.length <= maximum) return value;
	return `${lines.slice(-maximum).join("\n")}${trailingNewline ? "\n" : ""}`;
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return stripTerminalControls(message);
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

function waitStateKey(build: AzureBuild): string {
	return `${normalized(build.status as string)}\u0000${
		typeof build.result === "string" ? normalized(build.result) : "<missing>"
	}`;
}

function buildBaseUrl(ctx: AzureDevOpsRepoContext): string {
	return `${orgProjectUrl(ctx)}/_apis/build/builds`;
}

function timelineUrl(ctx: AzureDevOpsRepoContext, buildId: number): string {
	return `${buildBaseUrl(ctx)}/${buildId}/timeline?api-version=${API_VERSION}`;
}

function logsUrl(ctx: AzureDevOpsRepoContext, buildId: number): string {
	return `${buildBaseUrl(ctx)}/${buildId}/logs?api-version=${API_VERSION}`;
}

function logTextUrl(
	ctx: AzureDevOpsRepoContext,
	buildId: number,
	logId: number,
	range: BuildLogRange | null,
): string {
	const bounds =
		range === null
			? ""
			: `startLine=${range.startLine}&endLine=${range.endLine}&`;
	return `${buildBaseUrl(ctx)}/${buildId}/logs/${logId}?${bounds}api-version=${API_VERSION}`;
}

function listUrl(
	ctx: AzureDevOpsRepoContext,
	pr: ValidatedPullRequest,
	continuationToken: string | undefined,
	branchHead: boolean,
): string {
	const parameters = [
		...(branchHead ? [] : [["reasonFilter", "pullRequest"]]),
		["branchName", branchHead ? pr.sourceBranch : `refs/pull/${pr.id}/merge`],
		["repositoryId", pr.repositoryId],
		["repositoryType", "TfsGit"],
		["queryOrder", "queueTimeDescending"],
		["$top", String(BUILD_PAGE_SIZE)],
		...(continuationToken === undefined
			? []
			: [["continuationToken", continuationToken]]),
		["api-version", API_VERSION],
	];
	return `${buildBaseUrl(ctx)}?${parameters
		.map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
		.join("&")}`;
}

function assertListEnvelope(value: unknown): AzureBuild[] {
	const envelope = requireObject(value, "build list response");
	return requireArray(envelope.value, "build list response.value").map(
		(build, index) =>
			validateBuild(build, `build list response.value[${index}]`),
	);
}

function assertFetchedBuild(
	value: unknown,
	requestedBuildId: number,
	context: string,
): AzureBuild {
	const build = validateBuild(value, context);
	if (build.id !== requestedBuildId) {
		throw new Error(
			`Malformed Azure DevOps response: ${context}.id was ${build.id as number}, expected ${requestedBuildId}.`,
		);
	}
	return build;
}

function policyEvaluationLabel(evaluation: AzureObject): string {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const name = configuration?.name ?? evaluation.configurationName;
	return `evaluation ${display(evaluation.evaluationId)}${typeof name === "string" ? ` (${display(name)})` : ""}`;
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

function formatBuildRow(build: AzureBuild, current: boolean): string {
	return [
		`- Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
		`  Association: ${buildAssociation(build)}`,
		`  Status/result: ${display(build.status)}/${display(build.result)} [${current ? "current" : "history"}]`,
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
	async function resolvePullRequest(
		requestedPrId: number | undefined,
		options?: PullRequestReadOptions,
	): Promise<ValidatedPullRequest> {
		assertRequestedPullRequestId(requestedPrId);
		const pr = validatePullRequest(
			await pullRequests.resolve(requestedPrId, options),
			"pull request",
		);
		if (requestedPrId !== undefined && pr.id !== requestedPrId) {
			throw new Error(
				`Malformed Azure DevOps response: hydrated pull request ID ${pr.id} did not match selected PR #${requestedPrId}.`,
			);
		}
		return pr;
	}

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

	async function listAssociatedBuilds(
		pr: ValidatedPullRequest,
		mergeCommit: string | undefined,
		branchHead = false,
		signal?: AbortSignal,
	): Promise<AzureBuild[]> {
		const builds: AzureBuild[] = [];
		const seenBuildIds = new Set<number>();
		const seenContinuationTokens = new Set<string>();
		let continuationToken: string | undefined;
		let pageCount = 0;
		let responseBuildCount = 0;
		do {
			pageCount += 1;
			if (pageCount > MAX_BUILD_PAGES) {
				throw new Error(
					`Azure DevOps build pagination exceeded the safety limit of ${MAX_BUILD_PAGES} pages.`,
				);
			}
			const response = await azure.requestWithMetadata<unknown>(
				listUrl(ctx, pr, continuationToken, branchHead),
				{
					signal,
					timeoutMs: READ_TIMEOUT_MS,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				},
			);
			const page = assertListEnvelope(response.data);
			responseBuildCount += page.length;
			if (responseBuildCount > MAX_BUILD_RESPONSES) {
				throw new Error(
					`Azure DevOps build pagination exceeded the safety limit of ${MAX_BUILD_RESPONSES} builds.`,
				);
			}
			appendAssociatedBuilds(
				builds,
				page.filter((build) =>
					branchHead
						? build.sourceBranch === pr.sourceBranch
						: build.sourceBranch === `refs/pull/${pr.id}/merge`,
				),
				pr,
				mergeCommit,
				seenBuildIds,
			);

			continuationToken = nextBuildContinuationToken(
				response.metadata.headers,
				seenContinuationTokens,
			);
		} while (continuationToken !== undefined);
		return builds;
	}

	async function selectLatestBuild(
		pr: ValidatedPullRequest,
		requireCurrent: boolean,
		signal?: AbortSignal,
	): Promise<AzureBuild> {
		const builds = [
			...(await listAssociatedBuilds(pr, undefined, false, signal)),
			...(await listAssociatedBuilds(pr, undefined, true, signal)),
		].sort(
			(left, right) =>
				Date.parse(right.queueTime ?? "") - Date.parse(left.queueTime ?? ""),
		);
		const current = builds.find((build) => isCurrentBuild(build, pr));
		if (current !== undefined) return current;
		if (requireCurrent || builds.length === 0) {
			throw new Error(
				`No build validates PR #${pr.id} head commit ${pr.headCommit ?? "(unavailable)"}.`,
			);
		}
		return builds[0];
	}

	async function list(
		requestedPrId: number | undefined,
		options: ListBuildOptions = {},
	): Promise<BuildListEnvelope> {
		const history = options.history === true;
		const pr = await resolvePullRequest(requestedPrId);
		let mergeCommit: string | undefined;
		if (!history) {
			assertActivePullRequest(pr, "list current builds");
			mergeCommit = requireCurrentMergeCommit(pr, "list current builds");
		}

		const builds = await listAssociatedBuilds(pr, mergeCommit);

		if (!history) {
			const refreshed = validatePullRequest(
				await pullRequests.get(pr.id),
				"refreshed pull request",
			);
			assertActivePullRequest(refreshed, "finish listing current builds");
			const refreshedMergeCommit = requireCurrentMergeCommit(
				refreshed,
				"finish listing current builds",
			);
			if (
				refreshed.id !== pr.id ||
				!equalsIdentifier(refreshed.repositoryId, pr.repositoryId) ||
				!equalsIdentifier(refreshedMergeCommit, mergeCommit as string)
			) {
				throw new Error(
					`PR #${pr.id} changed while current builds were being listed; rerun the command.`,
				);
			}
		}
		return { pullRequest: pr.summary, history, builds };
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
		const pr = await resolvePullRequest(requestedPrId);
		const build =
			buildId === "latest"
				? await selectLatestBuild(pr, false)
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
		const initialPr = await resolvePullRequest(requestedPrId);
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
			throw new Error(
				`Retry request for build ${buildId} failed after dispatch. The Azure DevOps server outcome may be uncertain; do not retry automatically. Inspect it with \`pr.sh build show --pr ${refreshedPr.id} --build ${buildId}\` or \`pr.sh build list --pr ${refreshedPr.id} --history\` before trying again.\n${sanitizeError(error)}`,
			);
		}
	}

	async function queuePr(prId: number): Promise<QueuedBuild> {
		assertRequestedPullRequestId(prId);
		const pr = await resolvePullRequest(prId);
		const projectId = pr.projectId;
		if (typeof projectId !== "string" || projectId.length === 0) {
			throw new Error(
				`Cannot queue a build for PR #${pr.id}: Azure DevOps did not return its project ID.`,
			);
		}
		const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.id}`;
		const evaluationsUrl = policyEvaluationsUrl(ctx, artifactId);
		const evaluationResponse = requireObject(
			await azure.request<unknown>(evaluationsUrl, {
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
			"policy evaluations response",
		);
		const evaluations = requireArray(
			evaluationResponse.value,
			"policy evaluations response.value",
		);
		const candidates = evaluations
			.map((value, index) =>
				requireObject(value, `policy evaluation ${index + 1}`),
			)
			.filter((evaluation) => isBuildPolicyEvaluation(evaluation))
			.map((evaluation, index) => {
				const id = requireString(
					evaluation.evaluationId,
					`build policy evaluation ${index + 1}.evaluationId`,
				);
				return {
					id,
					label: policyEvaluationLabel(evaluation),
				};
			});
		if (candidates.length === 0) {
			throw new Error(`No build policy evaluation was found for PR #${pr.id}.`);
		}
		if (candidates.length > 1) {
			throw new Error(
				`More than one build policy evaluation was found for PR #${pr.id}. Choose one manually: ${candidates.map((candidate) => candidate.label).join(", ")}.`,
			);
		}

		const candidate = candidates[0];
		try {
			return await requeueEvaluation(candidate.id);
		} catch (error) {
			throw new Error(
				`Requeue request for build policy evaluation ${candidate.id} on PR #${pr.id} failed after dispatch. The Azure DevOps server outcome may be uncertain; do not retry automatically. Inspect it with \`pr.sh build show --latest --pr ${pr.id}\` or \`pr.sh build list --pr ${pr.id} --history\` before trying again.\n${sanitizeError(error)}`,
			);
		}
	}

	async function requeueEvaluation(evaluationId: string): Promise<QueuedBuild> {
		const evaluationUrl = `${orgProjectUrl(ctx)}/_apis/policy/evaluations/${evaluationId}?api-version=7.1-preview.1`;
		const response = requireObject(
			await azure.request<unknown>(evaluationUrl, {
				method: "PATCH",
				body: { status: "queued" },
				timeoutMs: RETRY_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			}),
			"requeued policy evaluation response",
		);
		const context = isObject(response.context) ? response.context : undefined;
		if (context?.buildId === undefined) return { evaluationId };
		const buildId = requirePositiveInteger(
			context.buildId,
			"requeued policy evaluation context.buildId",
		);
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

	async function queueBranch(branch: string): Promise<AzureBuild> {
		const sourceBranch = branch.startsWith("refs/")
			? branch
			: `refs/heads/${branch}`;
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
				`No build policy was found for repository ${ctx.repository}.`,
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
						`definition ${definitionId}: ${policies.map(policyConfigurationLabel).join(", ")}`,
				)
				.join("; ");
			throw new Error(
				`More than one build definition was found for repository ${ctx.repository}. Choose one manually: ${candidates}.`,
			);
		}
		const definitionId = definitions.keys().next().value as number;
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
			throw new Error(
				`Queue request for build definition ${definitionId} on ${sourceBranch} failed after dispatch. The Azure DevOps server outcome may be uncertain; do not retry automatically. Check that definition's runs for ${sourceBranch} in Azure DevOps before trying again.\n${sanitizeError(error)}`,
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
		const pr = await resolvePullRequest(requestedPrId, {
			signal,
			timeoutMs: READ_TIMEOUT_MS,
			maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
		});
		throwIfWaitAborted(signal);

		const buildId =
			requestedBuild === "latest"
				? ((await selectLatestBuild(pr, true, signal)).id as number)
				: requestedBuild;
		throwIfWaitAborted(signal);

		const startedAt = now();
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
		const timeoutEnvelope = (at = now()): BuildWaitEnvelope => ({
			association: latestBuild === null ? null : buildAssociation(latestBuild),
			pullRequest: pr.summary,
			buildId,
			build: latestBuild,
			pollCount,
			transientFailureCount,
			elapsedSeconds: elapsedSeconds(at),
			timedOut: true,
			outcome: "timeout",
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
			if (completedAt >= deadline) return timeoutEnvelope(completedAt);
			if (!transient) throw error;

			const retryAfterMs =
				isAzureRequestError(error) && error.kind === "http"
					? error.retryAfterMs
					: undefined;
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
					`Build ${buildId} wait stopped after ${consecutiveTransientFailures} consecutive transient Azure DevOps failures: ${errorText}`,
				);
			}
			nextPollAt = Math.min(
				deadline,
				completedAt + Math.max(intervalMs, retryAfterMs ?? 0),
			);
			return undefined;
		}

		async function observeBuild(
			rawBuild: unknown,
			completedAt: number,
		): Promise<BuildWaitEnvelope | undefined> {
			const observedBuild = validateWaitBuild(rawBuild, buildId, pr);
			const observedStatus = normalized(observedBuild.status);

			latestBuild = observedBuild;
			consecutiveTransientFailures = 0;
			const stateKey = waitStateKey(observedBuild);
			const terminalEnvelope: BuildWaitEnvelope | undefined =
				observedStatus === "completed"
					? {
							association: buildAssociation(observedBuild),
							pullRequest: pr.summary,
							buildId,
							build: observedBuild,
							pollCount,
							transientFailureCount,
							elapsedSeconds: elapsedSeconds(completedAt),
							timedOut: false,
							outcome: waitResultOutcome(observedBuild),
						}
					: undefined;
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
			return terminalEnvelope;
		}

		async function emitHeartbeat(current: number): Promise<void> {
			await emit({ type: "heartbeat", ...progressBase(current) });
			do nextHeartbeatAt += WAIT_HEARTBEAT_MS;
			while (nextHeartbeatAt <= current);
		}

		async function pollBuild(
			current: number,
		): Promise<BuildWaitEnvelope | undefined> {
			const remainingMs = Math.max(1, Math.ceil(deadline - current));
			pollCount += 1;
			const requestTimeoutMs = Math.min(READ_TIMEOUT_MS, remainingMs);
			const url = `${buildBaseUrl(ctx)}/${buildId}?api-version=${API_VERSION}`;
			let rawBuild: unknown;
			let completedAt: number;
			try {
				rawBuild = await azure.request<unknown>(url, {
					timeoutMs: requestTimeoutMs,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
					signal,
				});
				completedAt = now();
			} catch (error) {
				completedAt = now();
				return handlePollError(error, completedAt);
			}

			throwIfWaitAborted(signal);
			if (completedAt >= deadline) return timeoutEnvelope(completedAt);
			const result = await observeBuild(rawBuild, completedAt);
			if (!result) nextPollAt = Math.min(deadline, completedAt + intervalMs);
			return result;
		}

		while (true) {
			throwIfWaitAborted(signal);
			const current = now();
			if (current >= deadline) return timeoutEnvelope(current);
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
		const scope = result.history ? "history" : "current merge version";
		if (result.builds.length === 0) {
			return `No associated ${scope} builds found for PR #${result.pullRequest.id}.`;
		}
		return [
			`Builds for PR #${result.pullRequest.id}: ${display(result.pullRequest.title)} (${scope})`,
			"",
			...result.builds.flatMap((build, index) => [
				formatBuildRow(
					build,
					result.pullRequest.status !== null &&
						normalized(result.pullRequest.status) === "active" &&
						result.pullRequest.currentMergeCommit !== null &&
						equalsIdentifier(
							build.sourceVersion as string,
							result.pullRequest.currentMergeCommit,
						),
				),
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

	function formatQueue(build: AzureBuild): string {
		return [
			`Azure DevOps queued build ${build.id as number}/${display(build.buildNumber)}.`,
			`URL: ${display(buildWebLink(build))}`,
		].join("\n");
	}

	function formatWaitProgress(event: BuildWaitProgress): string {
		const state = `${display(event.build?.status)}/${display(event.build?.result)}`;
		const counters =
			`${event.elapsedSeconds.toFixed(1)}s elapsed; ${event.pollCount} poll(s); ` +
			`${event.transientFailureCount} transient failure(s)`;
		const prefix = `PR #${event.pullRequest.id}, build ${event.buildId}`;
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

	function formatWaitResult(result: BuildWaitEnvelope): string {
		const buildId = result.buildId;
		const identifier = `build ${buildId}`;
		const statusResult = `${display(result.build?.status)}/${display(result.build?.result)}`;
		const counters =
			`${result.elapsedSeconds.toFixed(1)}s elapsed; ${result.pollCount} poll(s); ` +
			`${result.transientFailureCount} transient failure(s)`;
		if (result.timedOut) {
			return (
				`${identifier} for PR #${result.pullRequest.id} timed out. ` +
				`Latest status/result: ${statusResult}; ${counters}.\nAssociation: ${display(result.association)}`
			);
		}
		const lines = [
			`${identifier} for PR #${result.pullRequest.id} finished with outcome ${display(result.outcome)}.`,
			`Status/result: ${statusResult}; ${counters}.`,
			`Association: ${display(result.association)}`,
		];
		if (result.outcome !== "succeeded" && buildId !== undefined) {
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
		queuePr,
		queueBranch,
		wait,
		hasLogErrors,
		formatList,
		formatShow,
		formatRetry,
		formatQueue,
		formatWaitProgress,
		formatWaitResult,
	};
}
