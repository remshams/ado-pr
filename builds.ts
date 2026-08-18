import { API_VERSION, orgProjectUrl } from "./azure.ts";
import type { AzureRequester } from "./azure.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";
import type { PullRequest, PullRequestService } from "./pull-requests.ts";

const BUILD_PAGE_SIZE = 100;
const DEFAULT_LOG_LINE_COUNT = 200;
const PROBLEM_RESULTS = new Set([
  "failed",
  "succeededwithissues",
  "canceled",
  "abandoned",
]);
const RETRYABLE_RESULTS = new Set(["failed", "partiallysucceeded", "canceled"]);
const DISPLAY_RECORD_TYPES = new Set(["stage", "job", "task"]);

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
  parentId?: string;
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

export interface BuildShowEnvelope {
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

export interface BuildService {
  list(
    requestedPrId: number | undefined,
    options?: ListBuildOptions,
  ): Promise<BuildListEnvelope>;
  show(
    requestedPrId: number | undefined,
    buildId: number,
    options?: ShowBuildOptions,
  ): Promise<BuildShowEnvelope>;
  retry(requestedPrId: number | undefined, buildId: number): Promise<AzureBuild>;
  hasLogErrors(result: BuildShowEnvelope): boolean;
  formatList(result: BuildListEnvelope): string;
  formatShow(result: BuildShowEnvelope): string;
  formatRetry(build: AzureBuild): string;
}

interface ValidatedPullRequest {
  id: number;
  repositoryId: string;
  status: string | undefined;
  mergeCommit: string | undefined;
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
    throw new Error(`Malformed Azure DevOps response: ${context} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Malformed Azure DevOps response: ${context} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Malformed Azure DevOps response: ${context} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, context);
}

function requirePositiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Malformed Azure DevOps response: ${context} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, context: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Malformed Azure DevOps response: ${context} must be a non-negative integer.`);
  }
  return value;
}

function assertRequestedBuildId(buildId: number): void {
  if (!Number.isInteger(buildId) || buildId < 1) {
    throw new Error("Build ID must be a positive integer.");
  }
}

function equalsIdentifier(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalized(value: string): string {
  return value.toLowerCase();
}

function validatePullRequest(pr: PullRequest, context: string): ValidatedPullRequest {
  const value = requireObject(pr, context) as unknown as PullRequest;
  const id = requirePositiveInteger(value.pullRequestId, describeField(context, "pullRequestId"));
  const title = requireString(value.title, describeField(context, "title"));
  requireString(value.sourceRefName, describeField(context, "sourceRefName"));
  const repository = requireObject(value.repository, describeField(context, "repository"));
  const repositoryId = requireString(
    repository.id,
    describeField(context, "repository.id"),
  );
  requireString(repository.name, describeField(context, "repository.name"));
  const status = optionalString(value.status, describeField(context, "status"));
  if (value.isDraft !== undefined && typeof value.isDraft !== "boolean") {
    throw new Error(
      `Malformed Azure DevOps response: ${describeField(context, "isDraft")} must be a boolean.`,
    );
  }

  let mergeCommit: string | undefined;
  if (value.lastMergeCommit !== undefined && value.lastMergeCommit !== null) {
    const commit = requireObject(
      value.lastMergeCommit,
      describeField(context, "lastMergeCommit"),
    );
    mergeCommit = requireString(
      commit.commitId,
      describeField(context, "lastMergeCommit.commitId"),
    );
  }

  return {
    id,
    repositoryId,
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

function assertActivePullRequest(pr: ValidatedPullRequest, operation: string): void {
  if (pr.status === undefined) {
    throw new Error(
      `Cannot ${operation}: PR #${pr.id} has no status in the Azure DevOps response.`,
    );
  }
  if (normalized(pr.status) !== "active") {
    throw new Error(
      `Cannot ${operation}: PR #${pr.id} is ${pr.status}; only active pull requests are eligible. Use build history/show for completed or abandoned pull requests.`,
    );
  }
}

function requireCurrentMergeCommit(pr: ValidatedPullRequest, operation: string): string {
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

  const repository = requireObject(build.repository, describeField(context, "repository"));
  requireString(repository.id, describeField(context, "repository.id"));
  requireString(repository.type, describeField(context, "repository.type"));
  optionalString(repository.name, describeField(context, "repository.name"));

  if (build.definition !== undefined && build.definition !== null) {
    const definition = requireObject(build.definition, describeField(context, "definition"));
    if (definition.id !== undefined) {
      requirePositiveInteger(definition.id, describeField(context, "definition.id"));
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

function buildAssociationMismatch(build: AzureBuild, pr: ValidatedPullRequest): string | undefined {
  const repository = build.repository as BuildRepository;
  if (!equalsIdentifier(repository.id as string, pr.repositoryId)) return "repository ID";
  if (!equalsIdentifier(repository.type as string, "TfsGit")) return "repository type";
  if (!equalsIdentifier(build.reason as string, "pullRequest")) return "reason";
  if (build.sourceBranch !== `refs/pull/${pr.id}/merge`) return "source branch";
  return undefined;
}

function assertBuildAssociation(build: AzureBuild, pr: ValidatedPullRequest): void {
  const mismatch = buildAssociationMismatch(build, pr);
  if (mismatch !== undefined) {
    throw new Error(
      `Build ${build.id as number} is not associated with PR #${pr.id}: ${mismatch} does not match.`,
    );
  }
}

function isCurrentBuild(build: AzureBuild, pr: ValidatedPullRequest): boolean {
  return (
    pr.mergeCommit !== undefined &&
    equalsIdentifier(build.sourceVersion as string, pr.mergeCommit)
  );
}

function validateTimeline(value: unknown): BuildTimeline {
  const timeline = requireObject(value, "timeline") as BuildTimeline;
  const rawRecords = requireArray(timeline.records, "timeline.records");
  const ids = new Set<string>();
  timeline.records = rawRecords.map((rawRecord, index) => {
    const context = `timeline.records[${index}]`;
    const record = requireObject(rawRecord, context) as TimelineRecord;
    if (record.id !== undefined && record.id !== null) {
      const id = requireString(record.id, describeField(context, "id"));
      if (ids.has(id)) {
        throw new Error(`Malformed Azure DevOps response: duplicate timeline record ID "${id}".`);
      }
      ids.add(id);
    }
    optionalString(record.parentId, describeField(context, "parentId"));
    optionalString(record.type, describeField(context, "type"));
    optionalString(record.name, describeField(context, "name"));
    optionalString(record.state, describeField(context, "state"));
    optionalString(record.result, describeField(context, "result"));
    optionalNonNegativeInteger(record.attempt, describeField(context, "attempt"));
    optionalNonNegativeInteger(record.order, describeField(context, "order"));

    if (record.issues !== undefined && record.issues !== null) {
      record.issues = requireArray(record.issues, describeField(context, "issues")).map(
        (rawIssue, issueIndex) => {
          const issueContext = `${context}.issues[${issueIndex}]`;
          const issue = requireObject(rawIssue, issueContext) as TimelineIssue;
          optionalString(issue.type, describeField(issueContext, "type"));
          optionalString(issue.category, describeField(issueContext, "category"));
          optionalString(issue.message, describeField(issueContext, "message"));
          return issue;
        },
      );
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
  const ids = new Set<number>();
  return logs.map((rawLog, index) => {
    const context = `build logs response.value[${index}]`;
    const log = requireObject(rawLog, context) as BuildLogMetadata;
    const id = requirePositiveInteger(log.id, describeField(context, "id"));
    if (ids.has(id)) {
      throw new Error(`Malformed Azure DevOps response: duplicate build log ID ${id}.`);
    }
    ids.add(id);
    optionalString(log.type, describeField(context, "type"));
    optionalString(log.url, describeField(context, "url"));
    optionalNonNegativeInteger(log.lineCount, describeField(context, "lineCount"));
    return log;
  });
}

function recordSortKey(record: TimelineRecord, index: number): [number, number] {
  return [record.order ?? Number.MAX_SAFE_INTEGER, index];
}

function compareRecordIndexes(records: TimelineRecord[], left: number, right: number): number {
  const [leftOrder, leftIndex] = recordSortKey(records[left], left);
  const [rightOrder, rightIndex] = recordSortKey(records[right], right);
  return leftOrder - rightOrder || leftIndex - rightIndex;
}

function orderTimelineRecords(timeline: BuildTimeline): OrderedTimelineRecord[] {
  const records = timeline.records as TimelineRecord[];
  const indexById = new Map<string, number>();
  records.forEach((record, index) => {
    if (record.id !== undefined) indexById.set(record.id, index);
  });
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  const orphanParents = new Map<number, string>();

  records.forEach((record, index) => {
    if (record.parentId === undefined) {
      roots.push(index);
      return;
    }
    const parentIndex = indexById.get(record.parentId);
    if (parentIndex === undefined) {
      roots.push(index);
      orphanParents.set(index, record.parentId);
      return;
    }
    const entries = children.get(parentIndex) ?? [];
    entries.push(index);
    children.set(parentIndex, entries);
  });
  roots.sort((left, right) => compareRecordIndexes(records, left, right));
  for (const entries of children.values()) {
    entries.sort((left, right) => compareRecordIndexes(records, left, right));
  }

  const output: OrderedTimelineRecord[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const cycleMembers = new Set<number>();

  function visit(index: number, depth: number): void {
    if (visiting.has(index)) {
      cycleMembers.add(index);
      return;
    }
    if (visited.has(index)) return;
    visiting.add(index);
    visited.add(index);
    const outputIndex = output.length;
    output.push({
      record: records[index],
      index,
      depth,
      orphanParent: orphanParents.get(index),
      cycle: false,
    });
    for (const child of children.get(index) ?? []) {
      if (visiting.has(child)) {
        cycleMembers.add(index);
        cycleMembers.add(child);
      } else {
        visit(child, depth + 1);
      }
    }
    visiting.delete(index);
    if (cycleMembers.has(index)) output[outputIndex].cycle = true;
  }

  for (const root of roots) visit(root, 0);
  const remaining = records
    .map((_record, index) => index)
    .filter((index) => !visited.has(index))
    .sort((left, right) => compareRecordIndexes(records, left, right));
  for (const index of remaining) {
    cycleMembers.add(index);
    visit(index, 0);
  }
  for (const entry of output) {
    if (cycleMembers.has(entry.index)) entry.cycle = true;
  }
  return output;
}

function timelineProblemRecords(timeline: BuildTimeline): TimelineRecord[] {
  return orderTimelineRecords(timeline)
    .map(({ record }) => record)
    .filter(
      (record) =>
        typeof record.result === "string" && PROBLEM_RESULTS.has(normalized(record.result)),
    );
}

function buildWebLink(build: AzureBuild): string | undefined {
  const web = build._links?.web;
  return typeof web?.href === "string" && web.href.length > 0 ? web.href : undefined;
}

function buildDefinitionName(build: AzureBuild): string {
  return build.definition?.name ?? "unknown";
}

function display(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return stripTerminalControls(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "unknown";
}

/** Removes ANSI/terminal control sequences while preserving printable text, tabs, and newlines. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stripTerminalControls(message);
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
    range === null ? "" : `startLine=${range.startLine}&endLine=${range.endLine}&`;
  return `${buildBaseUrl(ctx)}/${buildId}/logs/${logId}?${bounds}api-version=${API_VERSION}`;
}

function listUrl(
  ctx: AzureDevOpsRepoContext,
  pr: ValidatedPullRequest,
  continuationToken: string | undefined,
): string {
  const parameters = [
    ["reasonFilter", "pullRequest"],
    ["branchName", `refs/pull/${pr.id}/merge`],
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
  return requireArray(envelope.value, "build list response.value").map((build, index) =>
    validateBuild(build, `build list response.value[${index}]`),
  );
}

function assertFetchedBuild(value: unknown, requestedBuildId: number, context: string): AzureBuild {
  const build = validateBuild(value, context);
  if (build.id !== requestedBuildId) {
    throw new Error(
      `Malformed Azure DevOps response: ${context}.id was ${build.id as number}, expected ${requestedBuildId}.`,
    );
  }
  return build;
}

function formatBuildRow(build: AzureBuild, current: boolean): string {
  return [
    `- Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
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
      ...(orphanParent === undefined ? [] : [`orphan parent ${display(orphanParent)}`]),
      ...(cycle ? ["cycle"] : []),
    ];
    return (
      `${"  ".repeat(depth)}- ${display(record.type)}/${display(record.name)}: ` +
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
    return [header, ...issues, `Log (${mode}): ERROR: ${display(problem.logError)}`].join("\n");
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
}: {
  azure: AzureRequester;
  ctx: AzureDevOpsRepoContext;
  pullRequests: PullRequestService;
}): BuildService {
  async function resolvePullRequest(requestedPrId: number | undefined): Promise<ValidatedPullRequest> {
    return validatePullRequest(await pullRequests.resolve(requestedPrId), "pull request");
  }

  async function fetchBuild(buildId: number, context = "build"): Promise<AzureBuild> {
    const url = `${buildBaseUrl(ctx)}/${buildId}?api-version=${API_VERSION}`;
    return assertFetchedBuild(await azure.request<unknown>(url), buildId, context);
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

    const builds: AzureBuild[] = [];
    const seenContinuationTokens = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const response = await azure.requestWithMetadata<unknown>(
        listUrl(ctx, pr, continuationToken),
      );
      builds.push(...assertListEnvelope(response.data));
      const nextToken = response.metadata.headers.get("x-ms-continuationtoken") ?? undefined;
      if (nextToken === undefined || nextToken.length === 0) {
        continuationToken = undefined;
      } else {
        if (seenContinuationTokens.has(nextToken)) {
          throw new Error(
            `Azure DevOps build pagination repeated continuation token "${nextToken}"; refusing to loop.`,
          );
        }
        seenContinuationTokens.add(nextToken);
        continuationToken = nextToken;
      }
    } while (continuationToken !== undefined);

    const associated = builds.filter((build) => buildAssociationMismatch(build, pr) === undefined);
    const filtered = history
      ? associated
      : associated.filter((build) => equalsIdentifier(build.sourceVersion as string, mergeCommit as string));
    return { pullRequest: pr.summary, history, builds: filtered };
  }

  async function show(
    requestedPrId: number | undefined,
    buildId: number,
    options: ShowBuildOptions = {},
  ): Promise<BuildShowEnvelope> {
    assertRequestedBuildId(buildId);
    const pr = await resolvePullRequest(requestedPrId);
    const build = await fetchBuild(buildId);
    assertBuildAssociation(build, pr);
    const timeline = validateTimeline(await azure.request<unknown>(timelineUrl(ctx, buildId)));
    const logMetadata = validateLogMetadata(await azure.request<unknown>(logsUrl(ctx, buildId)));
    const metadataById = new Map(logMetadata.map((metadata) => [metadata.id as number, metadata]));
    const records = timelineProblemRecords(timeline);
    const requestedLogs = new Map<
      number,
      {
        metadata: BuildLogMetadata;
        mode: "tail" | "full";
        range: BuildLogRange | null;
      }
    >();

    for (const record of records) {
      if (record.log === undefined || record.log === null) continue;
      const logId = record.log.id as number;
      const metadata = metadataById.get(logId);
      if (metadata === undefined) {
        throw new Error(
          `Build ${buildId} timeline record ${record.id ?? record.name ?? "unknown"} references log ${logId}, but the build-log metadata response did not contain it.`,
        );
      }
      if (requestedLogs.has(logId)) continue;
      if (options.fullLogs === true) {
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
            startLine:
              metadata.lineCount === 0
                ? 0
                : Math.max(1, metadata.lineCount - DEFAULT_LOG_LINE_COUNT + 1),
            endLine: metadata.lineCount,
          },
        });
      }
    }

    const logResults = new Map<number, { text?: string; error?: string }>();
    for (const [logId, request] of requestedLogs) {
      if (request.range?.endLine === 0) {
        logResults.set(logId, { text: "" });
        continue;
      }
      try {
        const text = await azure.request(
          logTextUrl(ctx, buildId, logId, request.range),
          { responseType: "text", accept: "text/plain" },
        );
        logResults.set(logId, { text });
      } catch (error) {
        logResults.set(logId, { error: sanitizeError(error) });
      }
    }

    const problemRecords: ProblemRecord[] = records.map((record) => {
      const base: ProblemRecordBase = { record, issues: record.issues ?? [] };
      if (record.log === undefined || record.log === null) return { ...base, noLog: true };
      const logId = record.log.id as number;
      const request = requestedLogs.get(logId) as NonNullable<ReturnType<typeof requestedLogs.get>>;
      const result = logResults.get(logId) as NonNullable<ReturnType<typeof logResults.get>>;
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
    const mergeCommit = requireCurrentMergeCommit(pr, operation);
    assertBuildAssociation(build, pr);
    if (!equalsIdentifier(build.sourceVersion as string, mergeCommit)) {
      throw new Error(
        `Cannot ${operation}: build ${build.id as number} is historical and does not match PR #${pr.id}'s current merge commit.`,
      );
    }
    if (typeof build.status !== "string") {
      throw new Error(`Cannot ${operation}: build ${build.id as number} has no status.`);
    }
    if (normalized(build.status) !== "completed") {
      throw new Error(
        `Cannot ${operation}: build ${build.id as number} status is ${build.status}; it must be completed.`,
      );
    }
    if (typeof build.result !== "string") {
      throw new Error(`Cannot ${operation}: build ${build.id as number} has no result.`);
    }
    if (!RETRYABLE_RESULTS.has(normalized(build.result))) {
      throw new Error(
        `Cannot ${operation}: build ${build.id as number} result is ${build.result}; only failed, partiallySucceeded, or canceled builds can be retried.`,
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
    assertRetryEligible(refreshedPr, refreshedBuild, "retry build after refresh");

    const url = `${buildBaseUrl(ctx)}/${buildId}?retry=true&api-version=${API_VERSION}`;
    try {
      const returnedBuild = validateBuild(
        await azure.request<unknown>(url, { method: "PATCH", body: { id: buildId } }),
        "retry response build",
      );
      assertBuildAssociation(returnedBuild, refreshedPr);
      return returnedBuild;
    } catch (error) {
      throw new Error(
        `Retry request for build ${buildId} failed after dispatch. The Azure DevOps server outcome may be uncertain; do not retry automatically. Inspect it with \`pr.sh build show --build ${buildId}\` or \`pr.sh build list\` before trying again.\n${sanitizeError(error)}`,
      );
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
      `Builds for PR #${result.pullRequest.id}: ${stripTerminalControls(result.pullRequest.title)} (${scope})`,
      "",
      ...result.builds.flatMap((build, index) => [
        formatBuildRow(
          build,
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
      `PR: #${result.pullRequest.id} (${result.current ? "current" : "history"})`,
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
      `Returned status/result: ${display(build.status)}/${display(build.result)}`,
      `URL: ${display(buildWebLink(build))}`,
    ].join("\n");
  }

  return {
    list,
    show,
    retry,
    hasLogErrors,
    formatList,
    formatShow,
    formatRetry,
  };
}
