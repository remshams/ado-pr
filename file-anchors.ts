import { API_VERSION, pullRequestApiUrl, type AzureRequester } from "./azure.ts";
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

export interface FileAnchorCache {
  getIterationId(prId: number): Promise<number>;
  getChangeTrackingId(
    prId: number,
    iterationId: number,
    filePath: string,
  ): Promise<number | undefined>;
}

export interface ResolvedFileAnchor {
  threadContext: CommentThreadContext;
  pullRequestThreadContext: PullRequestThreadContext;
}

export interface FileAnchorService {
  createCache(): FileAnchorCache;
  resolve(
    prId: number,
    location: CommentLocation,
    cache?: FileAnchorCache,
  ): Promise<ResolvedFileAnchor>;
}

export function createFileAnchorService({
  azure,
  ctx,
}: {
  azure: AzureRequester;
  ctx: AzureDevOpsRepoContext;
}): FileAnchorService {
  /** Fetches the id of the most recent iteration (i.e. latest push) for a PR. */
  async function fetchLatestIterationId(prId: number): Promise<number> {
    const url = `${pullRequestApiUrl(ctx, prId, "/iterations")}?api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequestIteration[] }>(url);
    if (data.value.length === 0) {
      throw new Error(`PR #${prId} has no iterations.`);
    }
    return Math.max(...data.value.map((iteration) => iteration.id));
  }

  /** Finds a file's change tracking id, paging through all changes in the selected iteration. */
  async function fetchChangeTrackingId(
    prId: number,
    iterationId: number,
    filePath: string,
  ): Promise<number | undefined> {
    let skip = 0;
    let top = ITERATION_CHANGES_PAGE_SIZE;
    for (;;) {
      const url =
        `${pullRequestApiUrl(ctx, prId, `/iterations/${iterationId}/changes`)}` +
        `?api-version=${API_VERSION}&$top=${top}&$skip=${skip}`;
      const data = await azure.request<IterationChangesPage>(url);

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

  /** Memoizes promises for latest-iteration and per-file change-tracking lookups. */
  function createCache(): FileAnchorCache {
    const iterationIds = new Map<number, Promise<number>>();
    const changeTrackingIds = new Map<string, Promise<number | undefined>>();

    return {
      getIterationId(prId: number): Promise<number> {
        let promise = iterationIds.get(prId);
        if (!promise) {
          promise = fetchLatestIterationId(prId);
          iterationIds.set(prId, promise);
        }
        return promise;
      },
      getChangeTrackingId(
        prId: number,
        iterationId: number,
        filePath: string,
      ): Promise<number | undefined> {
        const key = `${prId}:${iterationId}:${filePath}`;
        let promise = changeTrackingIds.get(key);
        if (!promise) {
          promise = fetchChangeTrackingId(prId, iterationId, filePath);
          changeTrackingIds.set(key, promise);
        }
        return promise;
      },
    };
  }

  async function resolve(
    prId: number,
    location: CommentLocation,
    cache = createCache(),
  ): Promise<ResolvedFileAnchor> {
    const filePath = normalizeRepoFilePath(location.file);
    const threadContext: CommentThreadContext = {
      filePath,
      rightFileStart: { line: location.line ?? 1, offset: 1 },
      rightFileEnd: { line: location.endLine ?? location.line ?? 1, offset: 1 },
    };

    const iterationId = await cache.getIterationId(prId);
    const changeTrackingId = await cache.getChangeTrackingId(prId, iterationId, filePath);
    const pullRequestThreadContext: PullRequestThreadContext = {
      iterationContext: {
        firstComparingIteration: iterationId,
        secondComparingIteration: iterationId,
      },
      ...(changeTrackingId !== undefined ? { changeTrackingId } : {}),
    };

    return { threadContext, pullRequestThreadContext };
  }

  return { createCache, resolve };
}
