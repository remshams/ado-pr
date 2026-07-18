import { API_VERSION, azureRequest, pullRequestApiUrl } from "./azure.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";
import type { CommentLocation } from "./operation-types.ts";

export interface CommentThreadContext {
  filePath?: string;
  rightFileStart?: { line: number; offset?: number };
  rightFileEnd?: { line: number; offset?: number };
  leftFileStart?: { line: number; offset?: number };
  leftFileEnd?: { line: number; offset?: number };
}

export interface PullRequestThreadContext {
  iterationContext: { firstComparingIteration: number; secondComparingIteration: number };
  changeTrackingId?: number;
}

interface PullRequestIteration {
  id: number;
}

interface IterationChangeEntry {
  changeTrackingId: number;
  item?: { path?: string };
}

interface IterationChangesPage {
  changeEntries: IterationChangeEntry[];
  nextSkip?: number;
  nextTop?: number;
}

const ITERATION_CHANGES_PAGE_SIZE = 500;

/** Azure DevOps file paths in thread contexts must be root-relative with a leading slash. */
function normalizeRepoFilePath(file: string): string {
  return file.startsWith("/") ? file : `/${file}`;
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

/** Finds a file's change tracking id, paging through all changes in the selected iteration. */
async function fetchChangeTrackingId(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  iterationId: number,
  filePath: string,
  pat: string,
): Promise<number | undefined> {
  let skip = 0;
  let top = ITERATION_CHANGES_PAGE_SIZE;
  for (;;) {
    const url =
      `${pullRequestApiUrl(ctx, prId, `/iterations/${iterationId}/changes`)}` +
      `?api-version=${API_VERSION}&$top=${top}&$skip=${skip}`;
    const data = await azureRequest<IterationChangesPage>(url, pat);

    const match = data.changeEntries.find((entry) => entry.item?.path === filePath);
    if (match) {
      return match.changeTrackingId;
    }

    const { nextSkip, nextTop } = data;
    if (nextSkip !== undefined || nextTop !== undefined) {
      if ((nextSkip !== undefined && nextSkip <= 0) || (nextTop !== undefined && nextTop <= 0)) {
        return undefined;
      }
      skip = nextSkip ?? skip + top;
      top = nextTop ?? top;
    } else {
      if (data.changeEntries.length < top) {
        return undefined;
      }
      skip += top;
    }
  }
}

/**
 * Memoizes promises for latest-iteration and per-file change-tracking lookups. Callers own the
 * cache lifetime so standalone comments stay isolated while one batch can share all lookups.
 */
export function createFileAnchorCache() {
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

export type FileAnchorCache = ReturnType<typeof createFileAnchorCache>;

export async function resolveFileAnchor(
  ctx: AzureDevOpsRepoContext,
  prId: number,
  pat: string,
  location: CommentLocation,
  cache: FileAnchorCache,
): Promise<{
  threadContext: CommentThreadContext;
  pullRequestThreadContext: PullRequestThreadContext;
}> {
  const filePath = normalizeRepoFilePath(location.file);
  const threadContext: CommentThreadContext = {
    filePath,
    rightFileStart: { line: location.line ?? 1, offset: 1 },
    rightFileEnd: { line: location.endLine ?? location.line ?? 1, offset: 1 },
  };

  const iterationId = await cache.getIterationId(ctx, prId, pat);
  const changeTrackingId = await cache.getChangeTrackingId(ctx, prId, iterationId, filePath, pat);
  const pullRequestThreadContext: PullRequestThreadContext = {
    iterationContext: {
      firstComparingIteration: iterationId,
      secondComparingIteration: iterationId,
    },
    ...(changeTrackingId !== undefined ? { changeTrackingId } : {}),
  };

  return { threadContext, pullRequestThreadContext };
}
