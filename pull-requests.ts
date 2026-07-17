import { API_VERSION, azureRequest, reposBaseUrl } from "./azure.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";
import { getCurrentBranch } from "./lib.ts";

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

/** Turns a plain branch name into a full ref, leaving an already-qualified ref untouched. */
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
export async function createPullRequest(
  ctx: AzureDevOpsRepoContext,
  pat: string,
  options: CreatePullRequestOptions,
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

export async function resolvePullRequestId(
  ctx: AzureDevOpsRepoContext,
  requestedPrId: number | undefined,
  pat: string,
): Promise<number> {
  if (requestedPrId) {
    return requestedPrId;
  }
  const pr = await findPullRequestForCurrentBranch(ctx, pat);
  return pr.pullRequestId;
}
