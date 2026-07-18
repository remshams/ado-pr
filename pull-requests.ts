import { API_VERSION, reposBaseUrl } from "./azure.ts";
import type { AzureRequester } from "./azure.ts";
import { getCurrentBranch as defaultGetCurrentBranch } from "./lib.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";

export interface PullRequest {
  pullRequestId: number;
  title: string;
  sourceRefName: string;
}

export interface CreatePullRequestOptions {
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft: boolean;
}

export interface PullRequestService {
  create(options: CreatePullRequestOptions): Promise<PullRequest>;
  resolveId(requestedPrId: number | undefined): Promise<number>;
}

/** Turns a plain branch name into a full ref, leaving an already-qualified ref untouched. */
function toFullRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function createPullRequestService({
  azure,
  ctx,
  getCurrentBranch = defaultGetCurrentBranch,
}: {
  azure: AzureRequester;
  ctx: AzureDevOpsRepoContext;
  getCurrentBranch?: () => Promise<string>;
}): PullRequestService {
  async function getDefaultBranch(): Promise<string> {
    const url = `${reposBaseUrl(ctx)}?api-version=${API_VERSION}`;
    const data = await azure.request<{ defaultBranch?: string }>(url);
    if (!data.defaultBranch) {
      throw new Error(
        `Could not determine the default branch for ${ctx.organization}/${ctx.project}/${ctx.repository}; pass --target explicitly.`,
      );
    }
    return data.defaultBranch;
  }

  async function findPullRequestForCurrentBranch(): Promise<PullRequest> {
    const branch = await getCurrentBranch();
    const url = `${reposBaseUrl(ctx)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(toFullRef(branch))}&searchCriteria.status=active&api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequest[] }>(url);

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
  async function create(options: CreatePullRequestOptions): Promise<PullRequest> {
    const sourceBranch = options.sourceBranch ?? (await getCurrentBranch());
    const targetBranch = options.targetBranch ?? (await getDefaultBranch());

    const url = `${reposBaseUrl(ctx)}/pullrequests?api-version=${API_VERSION}`;
    return azure.request<PullRequest>(url, {
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

  async function resolveId(requestedPrId: number | undefined): Promise<number> {
    if (requestedPrId) {
      return requestedPrId;
    }
    const pr = await findPullRequestForCurrentBranch();
    return pr.pullRequestId;
  }

  return { create, resolveId };
}
