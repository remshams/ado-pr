/**
 * Creates Azure DevOps pull requests, and lists/creates/replies-to/resolves PR comment threads,
 * for the pull request associated with the current branch of a git checkout whose origin remote
 * points at Azure Repos.
 *
 * Auth: requires an AZURE_DEVOPS_PAT env var (a Personal Access Token with "Code" scope - "Read"
 * is enough for `list`, "Read & Write" is needed for `create`/`comment`/`reply`/`resolve`/`batch`).
 * Run this via pr.sh, which loads it from .env via `op run --env-file=.env` (see .env.tpl) so a
 * literal secret is never written to disk (an op:// 1Password reference works too, in which case
 * only the resolved value briefly lives in the child process's environment).
 */
import minimist from "minimist";

import type { AzureDevOpsRepoContext } from "./lib.ts";
import { parseAzureDevOpsRemote, runCommand } from "./lib.ts";

const API_VERSION = "7.1";

type Action = "list" | "reply" | "resolve" | "create" | "comment" | "batch";

interface Options {
  action: Action;
  pr?: number;
  thread?: number;
  message?: string;
  json: boolean;
  excludeOwn: boolean;
  excludeResolved: boolean;
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft: boolean;
  file?: string;
  line?: number;
  endLine?: number;
}

function printUsageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.error(`Usage: pr.sh [list] [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]
       pr.sh create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft]
       pr.sh comment --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]
       pr.sh reply --thread <id> --message "..." [--pr <id>]
       pr.sh resolve --thread <id> [--pr <id>]
       pr.sh batch [--pr <id>] < operations.json

Actions:
  list                     Lists comment threads for the pull request matching the current
                           branch (both resolved and unresolved, unless narrowed below). This is
                           the default action.
  create                   Creates a new pull request from the current branch (or --source, if
                           given). Prints the new PR's ID and web URL.
  comment                  Posts a new, top-level comment thread on the pull request - either
                           general, or anchored to a file (optionally a specific line/range).
                           Use \`reply\` instead to respond within an existing thread.
  reply                    Posts a reply comment to an existing thread.
  resolve                  Marks an existing thread as resolved. This always sets the thread's
                           status to Azure DevOps' "fixed" state (not "closed"/"won't fix" -
                           there's currently no flag to choose those instead).
  batch                    Runs several comment/reply/resolve operations from a single invocation
                           (a JSON array of operations, read from stdin). Useful for posting
                           multiple review comments (or replying to/resolving several threads) at
                           once - only needs approving/authenticating one command instead of one
                           per operation, and shares file-anchoring lookups across comments on the
                           same PR instead of repeating them per comment. Each array element is an
                           object shaped like one of:
                             {"action": "comment", "message": "...", "file"?: "...", "line"?: n, "endLine"?: n}
                             {"action": "reply", "thread": n, "message": "..."}
                             {"action": "resolve", "thread": n}
                           Every operation may set its own "pr" to override --pr/the auto-detected
                           PR for just that operation. Operations run in order; a failure is
                           reported inline and does not stop the remaining operations, but the
                           process exits non-zero if any operation failed.

Options:
  --pr <id>                Pull request ID to use, instead of auto-detecting it from the active
                           pull request(s) for the current branch. Required if more than one
                           active pull request matches the current branch. Not used by \`create\`.
                           For \`batch\`, this is the default for operations that don't set their
                           own "pr".
  --thread <id>            Required for reply/resolve. The thread ID, as shown by \`list\`.
  --message <text>         Required for reply/comment. The comment text to post.
  --title <text>           Required for \`create\`. The pull request's title.
  --description <text>     For \`create\`. The pull request's description. Defaults to empty.
  --source <branch>        For \`create\`. The branch to create the pull request from. Defaults to
                           the current branch. Must already exist on the remote.
  --target <branch>        For \`create\`. The branch to merge into. Defaults to the repository's
                           default branch.
  --draft                  For \`create\`. Creates the pull request as a draft.
  --file <path>            For \`comment\`. Anchors the new thread to a file (repo-relative path),
                           instead of leaving it as a general PR-level comment.
  --line <n>               For \`comment\`. Anchors the new thread to a specific line in --file
                           (on the current/right-hand side of the diff). Requires --file.
  --end-line <n>           For \`comment\`. Extends the anchored line into a range, ending at this
                           line (inclusive). Requires --line.
  --exclude-own            For \`list\`: drops threads where you (the identity behind
                           AZURE_DEVOPS_PAT) are the only commenter, i.e. keeps only threads that
                           have at least one comment from someone else. Threads with replies from
                           others are shown in full, including your own comments in them, for
                           context.
  --exclude-resolved       For \`list\`: only show threads that are still active/pending, hiding
                           ones already marked fixed/closed/won't-fix.
  --json                   For \`list\`, print the raw thread data as JSON instead of a
                           human-readable summary. Any --exclude-* filters are applied first.
  -h, --help               Show this help.

Requires:
  - Being run from within a git checkout whose origin remote points at Azure Repos (so the
    current branch/remote can be read).
  - AZURE_DEVOPS_PAT set in the environment (pr.sh loads this from .env - see .env.tpl).
`);
  process.exit(message ? 1 : 0);
}

function stringArg(value: unknown): string | undefined {
  // minimist yields an array if a flag is repeated; treat that (or anything else non-string) as
  // absent rather than silently stringifying it into something nonsensical.
  return typeof value === "string" ? value : undefined;
}

/** Shared by CLI flag and batch-JSON-field validation (parsePositiveIntFlag/positiveIntField). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Shared by CLI arg validation (parseArgs) and batch-JSON validation (parseBatchOperation). */
function actionRequiresThread(action: string): boolean {
  return action === "reply" || action === "resolve";
}

function actionRequiresMessage(action: string): boolean {
  return action === "reply" || action === "comment";
}

/** Builds the optional file-anchor location shared by the `comment` action and batch `comment`
 * operations, from whichever options/operation object provided --file/--line/--end-line. */
function toCommentLocation(source: {
  file?: string;
  line?: number;
  endLine?: number;
}): { file: string; line?: number; endLine?: number } | undefined {
  return source.file
    ? { file: source.file, line: source.line, endLine: source.endLine }
    : undefined;
}

function parsePositiveIntFlag(
  argv: minimist.ParsedArgs,
  flag: "pr" | "thread" | "line" | "end-line",
): number | undefined {
  if (argv[flag] === undefined) {
    return undefined;
  }
  const raw = stringArg(argv[flag]);
  const value = raw ? Number(raw) : NaN;
  if (!isPositiveInteger(value)) {
    printUsageAndExit(
      `invalid --${flag} "${argv[flag]}" (pass it once, as a single positive integer)`,
    );
  }
  return value;
}

/**
 * Reads a string flag (e.g. --message) and exits with a usage error if it was passed but isn't a
 * single string value (e.g. repeated, or passed with no value at all).
 */
function parseStringFlag(argv: minimist.ParsedArgs, flag: string): string | undefined {
  const value = stringArg(argv[flag]);
  if (argv[flag] !== undefined && value === undefined) {
    printUsageAndExit(`invalid --${flag} "${argv[flag]}" (pass it once, as a single string)`);
  }
  return value;
}

const ACTIONS: Action[] = ["list", "reply", "resolve", "create", "comment", "batch"];

function parseArgs(): Options {
  const argv = minimist(process.argv.slice(2), {
    string: [
      "pr",
      "thread",
      "message",
      "title",
      "description",
      "source",
      "target",
      "file",
      "line",
      "end-line",
    ],
    boolean: ["help", "json", "exclude-own", "exclude-resolved", "draft"],
    alias: { h: "help" },
  });

  if (argv.help) {
    printUsageAndExit();
  }

  const positional = argv._[0] as string | undefined;
  const action: Action = (positional as Action | undefined) ?? "list";
  if (positional && !ACTIONS.includes(action)) {
    printUsageAndExit(`unknown action "${positional}"`);
  }

  const pr = parsePositiveIntFlag(argv, "pr");
  const thread = parsePositiveIntFlag(argv, "thread");
  const line = parsePositiveIntFlag(argv, "line");
  const endLine = parsePositiveIntFlag(argv, "end-line");

  const message = parseStringFlag(argv, "message");
  const title = parseStringFlag(argv, "title");
  const description = parseStringFlag(argv, "description");
  const sourceBranch = parseStringFlag(argv, "source");
  const targetBranch = parseStringFlag(argv, "target");
  const file = parseStringFlag(argv, "file");

  if (actionRequiresThread(action) && !thread) {
    printUsageAndExit(`--thread is required for "${action}"`);
  }
  if (actionRequiresMessage(action) && !message) {
    printUsageAndExit(`--message is required for "${action}"`);
  }
  if (action === "create" && !title) {
    printUsageAndExit(`--title is required for "create"`);
  }
  if (action !== "comment" && (line || endLine)) {
    printUsageAndExit(`--line/--end-line are only valid for "comment"`);
  }
  if (line && !file) {
    printUsageAndExit(`--line requires --file`);
  }
  if (endLine && !line) {
    printUsageAndExit(`--end-line requires --line`);
  }
  if (endLine && line && endLine < line) {
    printUsageAndExit(`--end-line must be >= --line`);
  }

  return {
    action,
    pr,
    thread,
    message,
    json: !!argv.json,
    excludeOwn: !!argv["exclude-own"],
    excludeResolved: !!argv["exclude-resolved"],
    title,
    description,
    sourceBranch,
    targetBranch,
    draft: !!argv.draft,
    file,
    line,
    endLine,
  };
}

function getPat(): string {
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (!pat) {
    console.error(
      "Error: AZURE_DEVOPS_PAT is not set. Run this via pr.sh, which injects it from 1Password.",
    );
    process.exit(1);
  }
  return pat;
}

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

async function azureRequest<T>(
  url: string,
  pat: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: authHeader(pat),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `Azure DevOps API request (${options.method ?? "GET"} ${url}) failed: ${response.status} ${response.statusText}\n${await response.text()}`,
    );
  }

  return (await response.json()) as T;
}

/** Base `https://dev.azure.com/{org}/{project}` URL shared by both the REST API and web UI. */
function orgProjectUrl(ctx: AzureDevOpsRepoContext): string {
  return `https://dev.azure.com/${encodeURIComponent(ctx.organization)}/${encodeURIComponent(ctx.project)}`;
}

function reposBaseUrl(ctx: AzureDevOpsRepoContext): string {
  return `${orgProjectUrl(ctx)}/_apis/git/repositories/${encodeURIComponent(ctx.repository)}`;
}

function pullRequestApiUrl(ctx: AzureDevOpsRepoContext, prId: number, suffix = ""): string {
  return `${reposBaseUrl(ctx)}/pullRequests/${prId}${suffix}`;
}

async function getRepoContext(): Promise<AzureDevOpsRepoContext> {
  const { stdout } = await runCommand("git", ["remote", "get-url", "origin"]);
  return parseAzureDevOpsRemote(stdout.trim());
}

async function getCurrentBranch(): Promise<string> {
  const { stdout } = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

/** Turns a plain branch name (e.g. "main") into a full ref (e.g. "refs/heads/main"), leaving an
 * already-qualified ref untouched. */
function toFullRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

async function getDefaultBranch(ctx: AzureDevOpsRepoContext, pat: string): Promise<string> {
  const url = `${reposBaseUrl(ctx)}?api-version=${API_VERSION}`;
  const data = await azureRequest<{ defaultBranch?: string }>(url, pat);
  if (!data.defaultBranch) {
    throw new Error(
      `Could not determine the default branch for ${ctx.organization}/${ctx.project}/${ctx.repository}; pass --target explicitly.`,
    );
  }
  return data.defaultBranch;
}

interface PullRequest {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
}

async function findPullRequestForCurrentBranch(
  ctx: AzureDevOpsRepoContext,
  pat: string,
): Promise<PullRequest> {
  const branch = await getCurrentBranch();
  const url = `${reposBaseUrl(ctx)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(toFullRef(branch))}&searchCriteria.status=active&api-version=${API_VERSION}`;
  const data = await azureRequest<{ value: PullRequest[] }>(url, pat);

  if (data.value.length === 0) {
    throw new Error(
      `No active pull request found for branch "${branch}" in ${ctx.organization}/${ctx.project}/${ctx.repository}.`,
    );
  }
  if (data.value.length > 1) {
    throw new Error(
      `Multiple active pull requests found for branch "${branch}"; pass --pr <id> to disambiguate:\n${data.value
        .map((pr) => `  #${pr.pullRequestId}: ${pr.title}`)
        .join("\n")}`,
    );
  }
  return data.value[0];
}

/**
 * Creates a new pull request. Defaults the source branch to the current branch (which must
 * already exist on the remote) and the target branch to the repository's default branch.
 */
async function createPullRequest(
  ctx: AzureDevOpsRepoContext,
  pat: string,
  options: Pick<Options, "title" | "description" | "sourceBranch" | "targetBranch" | "draft">,
): Promise<PullRequest> {
  const sourceBranch = options.sourceBranch ?? (await getCurrentBranch());
  const targetBranch = options.targetBranch ?? (await getDefaultBranch(ctx, pat));

  const url = `${reposBaseUrl(ctx)}/pullrequests?api-version=${API_VERSION}`;
  return azureRequest<PullRequest>(url, pat, {
    method: "POST",
    body: {
      sourceRefName: toFullRef(sourceBranch),
      targetRefName: toFullRef(targetBranch),
      title: options.title,
      description: options.description ?? "",
      isDraft: options.draft,
    },
  });
}

function pullRequestWebUrl(ctx: AzureDevOpsRepoContext, prId: number): string {
  return `${orgProjectUrl(ctx)}/_git/${encodeURIComponent(ctx.repository)}/pullrequest/${prId}`;
}

interface CommentThreadContext {
  filePath?: string;
  rightFileStart?: { line: number; offset?: number };
  rightFileEnd?: { line: number; offset?: number };
  leftFileStart?: { line: number; offset?: number };
  leftFileEnd?: { line: number; offset?: number };
}

interface PullRequestThreadContext {
  iterationContext: { firstComparingIteration: number; secondComparingIteration: number };
  changeTrackingId?: number;
}

interface Comment {
  id: number;
  content?: string;
  author?: { id?: string; displayName: string };
  commentType?: string;
}

interface CommentThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: CommentThreadContext;
  pullRequestThreadContext?: PullRequestThreadContext;
  comments: Comment[];
}

async function getThreads(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  pat: string,
): Promise<CommentThread[]> {
  const url = `${pullRequestApiUrl(ctx, prId, "/threads")}?api-version=${API_VERSION}`;
  const data = await azureRequest<{ value: CommentThread[] }>(url, pat);
  return data.value;
}

/**
 * Azure DevOps requires file paths in thread contexts to be repo-root-relative and to start with
 * a leading "/" (e.g. "/src/app/foo.ts"). Without it, the web UI can't match the thread to a
 * known file in the PR's changes and shows "This file no longer exists in the latest pull
 * request changes" even for files that are present and unchanged.
 */
function normalizeRepoFilePath(file: string): string {
  return file.startsWith("/") ? file : `/${file}`;
}

interface PullRequestIteration {
  id: number;
}

/** Fetches the id of the most recent iteration (i.e. latest push) for a PR. */
async function fetchLatestIterationId(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  pat: string,
): Promise<number> {
  const url = `${pullRequestApiUrl(ctx, prId, "/iterations")}?api-version=${API_VERSION}`;
  const data = await azureRequest<{ value: PullRequestIteration[] }>(url, pat);
  if (data.value.length === 0) {
    throw new Error(`PR #${prId} has no iterations.`);
  }
  return Math.max(...data.value.map((iteration) => iteration.id));
}

interface IterationChangeEntry {
  changeTrackingId: number;
  item?: { path?: string };
}

interface IterationChangesPage {
  changeEntries: IterationChangeEntry[];
  // Present (and non-zero) when there are more pages of changes to fetch; see the pagination loop
  // in fetchChangeTrackingId below.
  nextSkip?: number;
  nextTop?: number;
}

// Azure DevOps paginates the iteration changes endpoint (default page size ~100). Without paging
// through all of it, a file's changeTrackingId could silently fail to resolve for PRs with more
// changed files than fit in a single page, even though the file genuinely is part of the diff.
const ITERATION_CHANGES_PAGE_SIZE = 500;

/**
 * Looks up the `changeTrackingId` Azure DevOps assigns to `filePath`'s change within the given
 * iteration. Together with the iteration context, this is what the web UI uses to bind a
 * file-anchored comment to a specific version of a file; without it, Azure DevOps can fail to
 * resolve the thread's file context (same "file no longer exists" symptom as an un-normalized
 * path). Returns `undefined` if the file isn't part of that iteration's changes (e.g. an unrelated
 * or unchanged file), in which case the thread is still anchored via `threadContext` alone.
 */
async function fetchChangeTrackingId(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  iterationId: number,
  filePath: string,
  pat: string,
): Promise<number | undefined> {
  let skip = 0;
  for (;;) {
    const url =
      `${pullRequestApiUrl(ctx, prId, `/iterations/${iterationId}/changes`)}` +
      `?api-version=${API_VERSION}&$top=${ITERATION_CHANGES_PAGE_SIZE}&$skip=${skip}`;
    const data = await azureRequest<IterationChangesPage>(url, pat);

    const match = data.changeEntries.find((entry) => entry.item?.path === filePath);
    if (match) {
      return match.changeTrackingId;
    }

    if (data.changeEntries.length < ITERATION_CHANGES_PAGE_SIZE) {
      // Last page: fewer entries came back than we asked for.
      return undefined;
    }
    skip += ITERATION_CHANGES_PAGE_SIZE;
  }
}

/**
 * Memoizes the per-PR "latest iteration id" and per-(iteration, file) "changeTrackingId" lookups
 * postComment needs for file-anchored comments. A single comment/batch invocation only ever
 * targets one PR, and batch in particular commonly posts several file comments in a row, so
 * sharing one cache across them avoids redundant round-trips (including re-paginating through
 * potentially large changes responses) for the same PR/iteration/file combination.
 */
function createFileAnchorCache() {
  const iterationIds = new Map<number, Promise<number>>();
  const changeTrackingIds = new Map<string, Promise<number | undefined>>();

  return {
    getIterationId(ctx: AzureDevOpsRepoContext, prId: number, pat: string): Promise<number> {
      let promise = iterationIds.get(prId);
      if (!promise) {
        promise = fetchLatestIterationId(ctx, prId, pat);
        iterationIds.set(prId, promise);
      }
      return promise;
    },
    getChangeTrackingId(
      ctx: AzureDevOpsRepoContext,
      prId: number,
      iterationId: number,
      filePath: string,
      pat: string,
    ): Promise<number | undefined> {
      const key = `${prId}:${iterationId}:${filePath}`;
      let promise = changeTrackingIds.get(key);
      if (!promise) {
        promise = fetchChangeTrackingId(ctx, prId, iterationId, filePath, pat);
        changeTrackingIds.set(key, promise);
      }
      return promise;
    },
  };
}

type FileAnchorCache = ReturnType<typeof createFileAnchorCache>;

/**
 * Looks up the Azure DevOps identity id for whoever AZURE_DEVOPS_PAT belongs to, so --exclude-own
 * can tell apart "my own comments" from everyone else's. Only called when that flag is used, to
 * avoid an extra API round-trip otherwise.
 */
async function getCurrentUserId(ctx: AzureDevOpsRepoContext, pat: string): Promise<string> {
  const url = `https://vssps.dev.azure.com/${encodeURIComponent(ctx.organization)}/_apis/profile/profiles/me?api-version=${API_VERSION}`;
  const data = await azureRequest<{ id: string }>(url, pat);
  return data.id;
}

const UNRESOLVED_STATUSES = new Set<string | undefined>(["active", "pending", undefined]);

function isRealComment(comment: Comment): boolean {
  return (comment.commentType ?? "text") === "text" && !!comment.content?.trim();
}

function isUnresolvedThread(thread: CommentThread): boolean {
  return UNRESOLVED_STATUSES.has(thread.status);
}

/** Basic sanity filter applied regardless of any --exclude-* flags: drop deleted/empty threads. */
function isRelevantThread(thread: CommentThread): boolean {
  return !thread.isDeleted && thread.comments.some(isRealComment);
}

/** For --exclude-own: keeps threads that have at least one real comment from someone else. */
function hasCommentFromSomeoneElse(thread: CommentThread, currentUserId: string): boolean {
  return thread.comments.some(
    (comment) => isRealComment(comment) && comment.author?.id !== currentUserId,
  );
}

/**
 * Formats the file location a thread is anchored to, pointing at the exact line(s) the comment
 * highlights: prefers the "right" (current/added) side of the diff, since that's what the file
 * looks like now, falling back to the "left" (removed) side for comments left on deleted code.
 * Renders a line range (e.g. "12-14") when the thread spans more than one line.
 */
function formatLocation(threadContext: CommentThreadContext | undefined): string {
  if (!threadContext?.filePath) {
    return "General (not tied to a file/line)";
  }

  const start = threadContext.rightFileStart?.line ?? threadContext.leftFileStart?.line;
  const end = threadContext.rightFileEnd?.line ?? threadContext.leftFileEnd?.line;
  // Normally start/end come as a matching pair; if the API ever hands back an end without a
  // start (or vice versa), still show whichever line we do have rather than dropping it.
  if (!start && !end) {
    return threadContext.filePath;
  }
  if (!start || !end || start === end) {
    return `${threadContext.filePath}:${start ?? end}`;
  }
  return `${threadContext.filePath}:${start}-${end}`;
}

function threadWebUrl(ctx: AzureDevOpsRepoContext, prId: number, threadId: number): string {
  return `${pullRequestWebUrl(ctx, prId)}?discussionId=${threadId}`;
}

function formatThread(thread: CommentThread, ctx: AzureDevOpsRepoContext, prId: number): string {
  const lines = [
    `### Thread ${thread.id} — ${formatLocation(thread.threadContext)} [${thread.status ?? "active"}]`,
    threadWebUrl(ctx, prId, thread.id),
  ];
  for (const comment of thread.comments.filter(isRealComment)) {
    lines.push(`- **${comment.author?.displayName ?? "unknown"}**: ${comment.content!.trim()}`);
  }
  return lines.join("\n");
}

/** Compact index of all threads, meant as a quick-scan summary below the full detail above. */
function formatSummaryTable(
  threads: CommentThread[],
  ctx: AzureDevOpsRepoContext,
  prId: number,
): string {
  const header = "| Thread | Location | Status | Link |\n| --- | --- | --- | --- |";
  const rows = threads.map(
    (thread) =>
      `| ${thread.id} | ${formatLocation(thread.threadContext)} | ${thread.status ?? "active"} | [Open](${threadWebUrl(ctx, prId, thread.id)}) |`,
  );
  return [header, ...rows].join("\n");
}

async function postReply(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  message: string,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "POST", body: { content: message } });
}

/**
 * Posts a new, top-level comment thread (as opposed to `postReply`, which adds a comment to an
 * existing thread). Anchors the thread to a specific file/line range when `location` is given,
 * otherwise leaves it as a general, PR-level comment.
 */
async function postComment(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  message: string,
  pat: string,
  location: { file: string; line?: number; endLine?: number } | undefined,
  fileAnchorCache: FileAnchorCache,
): Promise<CommentThread> {
  const url = `${pullRequestApiUrl(ctx, prId, "/threads")}?api-version=${API_VERSION}`;

  let threadContext: CommentThreadContext | undefined;
  let pullRequestThreadContext: PullRequestThreadContext | undefined;

  if (location) {
    const filePath = normalizeRepoFilePath(location.file);
    threadContext = {
      filePath,
      rightFileStart: { line: location.line ?? 1, offset: 1 },
      rightFileEnd: { line: location.endLine ?? location.line ?? 1, offset: 1 },
    };

    // Anchor the thread to the latest iteration and (if resolvable) that file's changeTrackingId
    // within it - both are what the web UI relies on to bind a comment to a concrete file/version,
    // and omitting either can make Azure DevOps show "This file no longer exists" for a file that
    // is, in fact, present.
    const iterationId = await fileAnchorCache.getIterationId(ctx, prId, pat);
    const changeTrackingId = await fileAnchorCache.getChangeTrackingId(
      ctx,
      prId,
      iterationId,
      filePath,
      pat,
    );
    pullRequestThreadContext = {
      iterationContext: {
        firstComparingIteration: iterationId,
        secondComparingIteration: iterationId,
      },
      ...(changeTrackingId !== undefined ? { changeTrackingId } : {}),
    };
  }

  return azureRequest<CommentThread>(url, pat, {
    method: "POST",
    body: {
      comments: [{ content: message }],
      status: "active",
      ...(threadContext ? { threadContext } : {}),
      ...(pullRequestThreadContext ? { pullRequestThreadContext } : {}),
    },
  });
}

/**
 * Marks a thread as resolved. Always uses Azure DevOps' "fixed" status specifically (as opposed
 * to "closed" or "wontFix", which aren't exposed here) since that's the common case for "I made
 * the requested change".
 */
async function resolveThread(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "PATCH", body: { status: "fixed" } });
}

async function resolvePullRequestId(
  ctx: AzureDevOpsRepoContext,
  options: Options,
  pat: string,
): Promise<number> {
  if (options.pr) {
    return options.pr;
  }
  const pr = await findPullRequestForCurrentBranch(ctx, pat);
  return pr.pullRequestId;
}

/** Fetches threads for a PR and applies the --exclude-* filters requested via options. */
async function getFilteredThreads(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  pat: string,
  options: Pick<Options, "excludeResolved" | "excludeOwn">,
): Promise<CommentThread[]> {
  let threads = (await getThreads(ctx, prId, pat)).filter(isRelevantThread);

  if (options.excludeResolved) {
    threads = threads.filter(isUnresolvedThread);
  }
  if (options.excludeOwn) {
    const currentUserId = await getCurrentUserId(ctx, pat);
    threads = threads.filter((thread) => hasCommentFromSomeoneElse(thread, currentUserId));
  }

  return threads;
}

interface BatchOperation {
  action: "comment" | "reply" | "resolve";
  pr?: number;
  thread?: number;
  message?: string;
  file?: string;
  line?: number;
  endLine?: number;
}

const BATCH_ACTIONS: BatchOperation["action"][] = ["comment", "reply", "resolve"];

/** Validates and normalizes a single element of a `batch` action's JSON operations array. */
function parseBatchOperation(raw: unknown, index: number): BatchOperation {
  const label = `Batch operation ${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const op = raw as Record<string, unknown>;

  const action = op.action;
  if (typeof action !== "string" || !BATCH_ACTIONS.includes(action as BatchOperation["action"])) {
    throw new Error(
      `${label} has an invalid "action" (must be one of: ${BATCH_ACTIONS.join(", ")}).`,
    );
  }

  /** Validates a field expected to be a positive integer, mirroring parsePositiveIntFlag's rules
   * for CLI flags. Returns undefined if the field is absent; throws if it's present but invalid
   * (e.g. a non-integer, zero/negative, or wrong type), rather than silently ignoring it. */
  function positiveIntField(field: string): number | undefined {
    const value = op[field];
    if (value === undefined) {
      return undefined;
    }
    if (!isPositiveInteger(value)) {
      throw new Error(`${label} has an invalid "${field}" (must be a positive integer).`);
    }
    return value;
  }

  const pr = positiveIntField("pr");
  const thread = positiveIntField("thread");
  const line = positiveIntField("line");
  const endLine = positiveIntField("endLine");
  const message = typeof op.message === "string" ? op.message : undefined;
  const file = typeof op.file === "string" ? op.file : undefined;

  if (actionRequiresThread(action) && !thread) {
    throw new Error(`${label} ("${action}") requires a "thread".`);
  }
  if (actionRequiresMessage(action) && !message) {
    throw new Error(`${label} ("${action}") requires a "message".`);
  }
  if (line !== undefined && !file) {
    throw new Error(`${label} ("${action}") has "line" but no "file".`);
  }
  if (endLine !== undefined && line === undefined) {
    throw new Error(`${label} ("${action}") has "endLine" but no "line".`);
  }
  if (endLine !== undefined && line !== undefined && endLine < line) {
    throw new Error(`${label} ("${action}") has "endLine" < "line".`);
  }

  return {
    action: action as BatchOperation["action"],
    pr,
    thread,
    message,
    file,
    line,
    endLine,
  };
}

/** Reads and JSON-parses the full contents of stdin. Used by the `batch` action. */
async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new Error(
      "batch reads its operations from stdin, but none was piped/redirected in " +
        "(stdin is a terminal). Use e.g. `pr.sh batch < operations.json`.",
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error(
      "No batch operations provided on stdin. Pipe/redirect a JSON array of operations in, e.g. `pr.sh batch < operations.json`.",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse batch operations as JSON: ${(error as Error).message}`);
  }
}

/** Executes a single batch operation and returns a short human-readable description of it. */
async function executeBatchOperation(
  ctx: AzureDevOpsRepoContext,
  pat: string,
  defaultPrId: number,
  op: BatchOperation,
  fileAnchorCache: FileAnchorCache,
): Promise<string> {
  const prId = op.pr ?? defaultPrId;
  switch (op.action) {
    case "comment": {
      const location = toCommentLocation(op);
      const thread = await postComment(ctx, prId, op.message!, pat, location, fileAnchorCache);
      const url = threadWebUrl(ctx, prId, thread.id);
      return `posted new comment thread ${thread.id} on PR #${prId} (${url})`;
    }
    case "reply": {
      await postReply(ctx, prId, op.thread!, op.message!, pat);
      return `posted reply to thread ${op.thread} on PR #${prId}`;
    }
    case "resolve": {
      await resolveThread(ctx, prId, op.thread!, pat);
      return `marked thread ${op.thread} on PR #${prId} as resolved`;
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  const pat = getPat();
  const ctx = await getRepoContext();

  // "create" makes a brand-new PR, so there's no existing PR ID to resolve yet - handle it before
  // every other action, which all operate on one.
  if (options.action === "create") {
    const pr = await createPullRequest(ctx, pat, options);
    console.log(`Created PR #${pr.pullRequestId}: ${pr.title}`);
    console.log(pullRequestWebUrl(ctx, pr.pullRequestId));
    return;
  }

  const prId = await resolvePullRequestId(ctx, options, pat);

  switch (options.action) {
    case "list": {
      const threads = await getFilteredThreads(ctx, prId, pat, options);

      if (options.json) {
        console.log(JSON.stringify(threads, null, 2));
        return;
      }
      if (threads.length === 0) {
        console.log(`No matching comment threads on PR #${prId}.`);
        return;
      }
      console.log(`Comment threads on PR #${prId}:\n`);
      console.log(threads.map((thread) => formatThread(thread, ctx, prId)).join("\n\n"));
      console.log("\n---\n\nSummary:\n");
      console.log(formatSummaryTable(threads, ctx, prId));
      return;
    }
    case "comment": {
      const location = toCommentLocation(options);
      const thread = await postComment(
        ctx,
        prId,
        options.message!,
        pat,
        location,
        createFileAnchorCache(),
      );
      console.log(`Posted new comment thread ${thread.id} on PR #${prId}.`);
      console.log(threadWebUrl(ctx, prId, thread.id));
      return;
    }
    case "reply": {
      await postReply(ctx, prId, options.thread!, options.message!, pat);
      console.log(`Posted reply to thread ${options.thread} on PR #${prId}.`);
      return;
    }
    case "resolve": {
      await resolveThread(ctx, prId, options.thread!, pat);
      console.log(`Marked thread ${options.thread} on PR #${prId} as resolved.`);
      return;
    }
    case "batch": {
      const raw = await readStdinJson();
      if (!Array.isArray(raw)) {
        throw new Error("Batch operations must be a JSON array.");
      }
      const operations = raw.map((entry, index) => parseBatchOperation(entry, index));
      if (operations.length === 0) {
        console.log("No batch operations to run.");
        return;
      }

      const fileAnchorCache = createFileAnchorCache();
      let hadFailure = false;
      for (const [index, op] of operations.entries()) {
        const label = `[${index + 1}/${operations.length}] ${op.action}`;
        try {
          const result = await executeBatchOperation(ctx, pat, prId, op, fileAnchorCache);
          console.log(`${label}: ${result}`);
        } catch (error) {
          hadFailure = true;
          console.error(`${label}: FAILED - ${(error as Error).message}`);
        }
      }
      if (hadFailure) {
        process.exitCode = 1;
      }
      return;
    }
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
