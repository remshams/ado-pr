import type {
	PullRequest,
	PullRequestReadOptions,
	PullRequestService,
} from "../pull-requests/pull-requests.ts";
import {
	API_VERSION,
	type AzureRequester,
	isAzureRequestError,
	orgProjectUrl,
} from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import { stripTerminalControls } from "../shared/terminal.ts";
import type { BuildLogRange, PullRequestBuildSummary } from "./builds.ts";

const BUILD_PAGE_SIZE = 100;

export const MAX_BUILD_PAGES = 1_000;

const MAX_CONTINUATION_TOKEN_LENGTH = 8_192;
const MAX_TIMELINE_RECORDS = 50_000;
const MAX_LOG_METADATA_RECORDS = 50_000;
export const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

export const READ_TIMEOUT_MS = 30_000;
export const RETRY_TIMEOUT_MS = 60_000;

export interface AzureObject {
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

export interface ValidatedPullRequest {
	id: number;
	repositoryId: string;
	projectId: string | undefined;
	status: string | undefined;
	mergeCommit: string | undefined;
	headCommit: string | undefined;
	sourceBranch: string;
	summary: PullRequestBuildSummary;
}

/** What the build use cases read Azure DevOps through. */
export interface BuildDependencies {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: PullRequestService;
}

export function isObject(value: unknown): value is AzureObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeField(context: string, field: string): string {
	return `${context}.${field}`;
}

export function requireObject(value: unknown, context: string): AzureObject {
	if (!isObject(value)) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be an object.`,
		);
	}
	return value;
}

export function requireArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(
			`Malformed Azure DevOps response: ${context} must be an array.`,
		);
	}
	return value;
}

export function requireString(value: unknown, context: string): string {
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

export function requirePositiveInteger(
	value: unknown,
	context: string,
): number {
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

export function assertRequestedBuildId(buildId: number): void {
	if (!Number.isSafeInteger(buildId) || buildId < 1) {
		throw new Error("Build ID must be a positive safe integer.");
	}
}

export function assertRequestedPullRequestId(
	requestedPrId: number | undefined,
): void {
	if (
		requestedPrId !== undefined &&
		(!Number.isSafeInteger(requestedPrId) || requestedPrId < 1)
	) {
		throw new Error("Pull request ID must be a positive safe integer.");
	}
}

export function equalsIdentifier(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

export function normalized(value: string): string {
	return value.toLowerCase();
}

function optionalCommit(value: unknown, context: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(
		requireObject(value, context).commitId,
		describeField(context, "commitId"),
	);
}

export function validatePullRequest(
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
			currentHeadCommit: headCommit ?? null,
		},
	};
}

export function validateBuild(value: unknown, context: string): AzureBuild {
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

export function validateTimeline(value: unknown): BuildTimeline {
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

export function validateLogMetadata(value: unknown): BuildLogMetadata[] {
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

export function nextBuildContinuationToken(
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

export function display(value: unknown): string {
	if (typeof value === "string" && value.length > 0) {
		return stripTerminalControls(value)
			.replace(/[\r\n]+/g, " ")
			.replace(/\t/g, " ");
	}
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	return "unknown";
}

export function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return stripTerminalControls(message);
}

export function buildBaseUrl(ctx: AzureDevOpsRepoContext): string {
	return `${orgProjectUrl(ctx)}/_apis/build/builds`;
}

export function timelineUrl(
	ctx: AzureDevOpsRepoContext,
	buildId: number,
): string {
	return `${buildBaseUrl(ctx)}/${buildId}/timeline?api-version=${API_VERSION}`;
}

export function logsUrl(ctx: AzureDevOpsRepoContext, buildId: number): string {
	return `${buildBaseUrl(ctx)}/${buildId}/logs?api-version=${API_VERSION}`;
}

export function logTextUrl(
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

export function listUrl(
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

export function assertListEnvelope(value: unknown): AzureBuild[] {
	const envelope = requireObject(value, "build list response");
	return requireArray(envelope.value, "build list response.value").map(
		(build, index) =>
			validateBuild(build, `build list response.value[${index}]`),
	);
}

export function assertFetchedBuild(
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

const BUILD_SCOPE_HINT =
	"The PAT needs the Build (Read & execute) scope, also named vso.build_execute, and the account needs permission to queue builds for that build pipeline.";

const REJECTED_STATUSES = new Set([400, 401, 403, 404]);
const SCOPE_STATUSES = new Set([401, 403]);

/**
 * Builds the error for a failed build mutation. Azure refused 400, 401, 403 and 404 without acting,
 * and 401 and 403 get a scope hint. Any other failure may have queued a build, so it gets the
 * uncertain-outcome guidance.
 */
export function buildMutationError(
	error: unknown,
	subject: string,
	advice: string,
	extraScopeHint = "",
): Error {
	const status = isAzureRequestError(error) ? error.status : undefined;
	if (status !== undefined && REJECTED_STATUSES.has(status)) {
		const hint = SCOPE_STATUSES.has(status)
			? ` ${BUILD_SCOPE_HINT}${extraScopeHint}`
			: "";
		return new Error(
			`${subject} was rejected with HTTP ${status}; Azure DevOps took no action.${hint}\n${sanitizeError(error)}`,
		);
	}
	return new Error(
		`${subject} failed after dispatch. The Azure DevOps server outcome may be uncertain; do not retry automatically. ${advice}\n${sanitizeError(error)}`,
	);
}

export async function resolvePullRequest(
	pullRequests: PullRequestService,
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
