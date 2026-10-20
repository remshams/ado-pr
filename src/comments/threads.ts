import {
  API_VERSION,
  getAuthenticatedUserId,
  pullRequestApiUrl,
  pullRequestWebUrl,
  type AzureRequester,
} from "../shared/azure.ts";
import type {
  CommentThreadContext,
  FileAnchorService,
  PullRequestThreadContext,
} from "./file-anchors.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type { CommentLocation } from "../shared/operation-types.ts";

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

export interface ThreadService {
  list(
    prId: number,
    options: { excludeResolved: boolean; excludeOwn: boolean },
  ): Promise<CommentThread[]>;
  comment(prId: number, message: string, location?: CommentLocation): Promise<CommentThread>;
  reply(prId: number, threadId: number, message: string): Promise<void>;
  edit(prId: number, threadId: number, commentId: number, message: string): Promise<void>;
  delete(prId: number, threadId: number, commentId: number): Promise<void>;
  resolve(prId: number, threadId: number): Promise<void>;
  webUrl(prId: number, threadId: number): string;
  format(thread: CommentThread, prId: number): string;
  formatSummary(threads: CommentThread[], prId: number): string;
}

const UNRESOLVED_STATUSES = new Set<string | undefined>(["active", "pending", undefined]);

function isRealComment(comment: Comment): comment is Comment & { content: string } {
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

export function createThreadService({
  azure,
  ctx,
  fileAnchors,
}: {
  azure: AzureRequester;
  ctx: AzureDevOpsRepoContext;
  fileAnchors: FileAnchorService;
}): ThreadService {
  async function getThreads(prId: number): Promise<CommentThread[]> {
    const url = `${pullRequestApiUrl(ctx, prId, "/threads")}?api-version=${API_VERSION}`;
    const data = await azure.request<{ value: CommentThread[] }>(url);
    return data.value;
  }

  /** Fetches threads for a PR and applies the requested exclude filters. */
  async function list(
    prId: number,
    options: { excludeResolved: boolean; excludeOwn: boolean },
  ): Promise<CommentThread[]> {
    let result = (await getThreads(prId)).filter(isRelevantThread);

    if (options.excludeResolved) {
      result = result.filter(isUnresolvedThread);
    }
    if (options.excludeOwn) {
      const currentUserId = await getAuthenticatedUserId(azure, ctx.organization);
      result = result.filter((thread) => hasCommentFromSomeoneElse(thread, currentUserId));
    }

    return result;
  }

  /** Posts a new top-level thread, optionally anchored to a file and line range. */
  const fileAnchorCache = fileAnchors.createCache();

  async function comment(
    prId: number,
    message: string,
    location?: CommentLocation,
  ): Promise<CommentThread> {
    const url = `${pullRequestApiUrl(ctx, prId, "/threads")}?api-version=${API_VERSION}`;
    const anchor = location
      ? await fileAnchors.resolve(prId, location, fileAnchorCache)
      : undefined;

    return azure.request<CommentThread>(url, {
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

  async function reply(prId: number, threadId: number, message: string): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "POST", body: { content: message } });
  }

  async function edit(
    prId: number,
    threadId: number,
    commentId: number,
    message: string,
  ): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments/${commentId}`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "PATCH", body: { content: message } });
  }

  async function deleteComment(prId: number, threadId: number, commentId: number): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}/comments/${commentId}`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "DELETE", responseType: "none" });
  }

  /** Marks a thread as resolved using Azure DevOps' "fixed" status. */
  async function resolve(prId: number, threadId: number): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/threads/${threadId}`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "PATCH", body: { status: "fixed" } });
  }

  function webUrl(prId: number, threadId: number): string {
    return `${pullRequestWebUrl(ctx, prId)}?discussionId=${threadId}`;
  }

  function format(thread: CommentThread, prId: number): string {
    const lines = [
      `### Thread ${thread.id} — ${formatLocation(thread.threadContext)} [${thread.status ?? "active"}]`,
      webUrl(prId, thread.id),
    ];
    for (const comment of thread.comments.filter(isRealComment)) {
      lines.push(
        `- **${comment.author?.displayName ?? "unknown"}** (comment ${comment.id}): ${comment.content.trim()}`,
      );
    }
    return lines.join("\n");
  }

  /** Compact index of all threads, meant as a quick-scan summary below the full detail above. */
  function formatSummary(threads: CommentThread[], prId: number): string {
    const header = "| Thread | Location | Status | Link |\n| --- | --- | --- | --- |";
    const rows = threads.map(
      (thread) =>
        `| ${thread.id} | ${formatLocation(thread.threadContext)} | ${thread.status ?? "active"} | [Open](${webUrl(prId, thread.id)}) |`,
    );
    return [header, ...rows].join("\n");
  }

  return {
    list,
    comment,
    reply,
    edit,
    delete: deleteComment,
    resolve,
    webUrl,
    format,
    formatSummary,
  };
}
