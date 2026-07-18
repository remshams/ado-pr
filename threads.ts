import { API_VERSION, azureRequest, pullRequestApiUrl, pullRequestWebUrl } from "./azure.ts";
import type {
  CommentThreadContext,
  FileAnchorCache,
  PullRequestThreadContext,
} from "./file-anchors.ts";
import { resolveFileAnchor } from "./file-anchors.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";
import type { CommentLocation } from "./operation-types.ts";

interface Comment {
  id: number;
  content?: string;
  author?: { id?: string; displayName: string };
  commentType?: string;
  isDeleted?: boolean;
}

export interface CommentThread {
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

/** Looks up the Azure identity id associated with the PAT, only when --exclude-own needs it. */
async function getCurrentUserId(ctx: AzureDevOpsRepoContext, pat: string): Promise<string> {
  const url = `https://vssps.dev.azure.com/${encodeURIComponent(ctx.organization)}/_apis/profile/profiles/me?api-version=${API_VERSION}`;
  const data = await azureRequest<{ id: string }>(url, pat);
  return data.id;
}

const UNRESOLVED_STATUSES = new Set<string | undefined>(["active", "pending", undefined]);

function isRealComment(comment: Comment): boolean {
  return (
    !comment.isDeleted && (comment.commentType ?? "text") === "text" && !!comment.content?.trim()
  );
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

/** Fetches threads for a PR and applies the --exclude-* filters requested via options. */
export async function getFilteredThreads(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  pat: string,
  options: { excludeResolved: boolean; excludeOwn: boolean },
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

/** Formats the file location a thread is anchored to, preferring the current side of the diff. */
function formatLocation(threadContext: CommentThreadContext | undefined): string {
  if (!threadContext?.filePath) {
    return "General (not tied to a file/line)";
  }

  const start = threadContext.rightFileStart?.line ?? threadContext.leftFileStart?.line;
  const end = threadContext.rightFileEnd?.line ?? threadContext.leftFileEnd?.line;
  if (!start && !end) {
    return threadContext.filePath;
  }
  if (!start || !end || start === end) {
    return `${threadContext.filePath}:${start ?? end}`;
  }
  return `${threadContext.filePath}:${start}-${end}`;
}

export function threadWebUrl(ctx: AzureDevOpsRepoContext, prId: number, threadId: number): string {
  return `${pullRequestWebUrl(ctx, prId)}?discussionId=${threadId}`;
}

export function formatThread(
  thread: CommentThread,
  ctx: AzureDevOpsRepoContext,
  prId: number,
): string {
  const lines = [
    `### Thread ${thread.id} — ${formatLocation(thread.threadContext)} [${thread.status ?? "active"}]`,
    threadWebUrl(ctx, prId, thread.id),
  ];
  for (const comment of thread.comments.filter(isRealComment)) {
    lines.push(
      `- **${comment.author?.displayName ?? "unknown"}** (comment ${comment.id}): ${comment.content!.trim()}`,
    );
  }
  return lines.join("\n");
}

/** Compact index of all threads, meant as a quick-scan summary below the full detail above. */
export function formatSummaryTable(
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

export async function postReply(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  message: string,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "POST", body: { content: message } });
}

export async function editComment(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  commentId: number,
  message: string,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments/${commentId}`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "PATCH", body: { content: message } });
}

export async function deleteComment(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  commentId: number,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments/${commentId}`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "DELETE", responseType: "none" });
}

/** Posts a new top-level thread, optionally anchored to a file and line range. */
export async function postComment(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  message: string,
  pat: string,
  location: CommentLocation | undefined,
  fileAnchorCache: FileAnchorCache,
): Promise<CommentThread> {
  const url = `${pullRequestApiUrl(ctx, prId, "/threads")}?api-version=${API_VERSION}`;
  const anchor = location
    ? await resolveFileAnchor(ctx, prId, pat, location, fileAnchorCache)
    : undefined;

  return azureRequest<CommentThread>(url, pat, {
    method: "POST",
    body: {
      comments: [{ content: message }],
      status: "active",
      ...(anchor?.threadContext ? { threadContext: anchor.threadContext } : {}),
      ...(anchor?.pullRequestThreadContext
        ? { pullRequestThreadContext: anchor.pullRequestThreadContext }
        : {}),
    },
  });
}

/** Marks a thread as resolved using Azure DevOps' "fixed" status. */
export async function resolveThread(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  threadId: number,
  pat: string,
): Promise<void> {
  const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}`)}?api-version=${API_VERSION}`;
  await azureRequest(url, pat, { method: "PATCH", body: { status: "fixed" } });
}
