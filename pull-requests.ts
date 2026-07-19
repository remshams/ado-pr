import { API_VERSION, pullRequestApiUrl, pullRequestWebUrl, reposBaseUrl } from "./azure.ts";
import type { AzureRequester } from "./azure.ts";
import { getCurrentBranch as defaultGetCurrentBranch } from "./lib.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName?: string;
}

export interface CreatePullRequestOptions {
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft: boolean;
}

export interface UpdatePullRequestOptions {
  description?: string;
  draft?: boolean;
}

export interface PullRequestService {
  create(options: CreatePullRequestOptions): Promise<PullRequest>;
  update(prId: number, options: UpdatePullRequestOptions): Promise<PullRequest>;
  get(prId: number): Promise<PullRequest>;
  findForCurrentBranch(): Promise<PullRequest>;
  resolve(requestedPrId: number | undefined): Promise<PullRequest>;
  resolveId(requestedPrId: number | undefined): Promise<number>;
  format(pr: PullRequest): string;
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

  async function findForCurrentBranch(): Promise<PullRequest> {
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

  /** Updates only the explicitly supplied pull request fields. */
  async function update(prId: number, options: UpdatePullRequestOptions): Promise<PullRequest> {
    const body = {
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.draft !== undefined ? { isDraft: options.draft } : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new Error("At least one pull request field is required for an update.");
    }

    const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
    return azure.request<PullRequest>(url, { method: "PATCH", body });
  }

  /** Fetches a pull request by ID, including its description and other PR-level metadata. */
  async function get(prId: number): Promise<PullRequest> {
    const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
    return azure.request<PullRequest>(url);
  }

  /** Resolves and fully fetches either an explicitly selected PR or the active PR for the branch. */
  async function resolve(requestedPrId: number | undefined): Promise<PullRequest> {
    if (requestedPrId) {
      return get(requestedPrId);
    }
    const candidate = await findForCurrentBranch();
    // Azure truncates descriptions in pull-request collection responses, so hydrate the selected PR.
    return get(candidate.pullRequestId);
  }

  async function resolveId(requestedPrId: number | undefined): Promise<number> {
    if (requestedPrId) {
      return requestedPrId;
    }
    const pr = await findForCurrentBranch();
    return pr.pullRequestId;
  }

  function formatRef(ref: string | undefined): string {
    return ref?.replace(/^refs\/heads\//, "") ?? "unknown";
  }

  function format(pr: PullRequest): string {
    return [
      `PR #${pr.pullRequestId}: ${pr.title}`,
      `Status: ${pr.status ?? "unknown"}`,
      `Draft: ${pr.isDraft === undefined ? "unknown" : pr.isDraft ? "yes" : "no"}`,
      `Source: ${formatRef(pr.sourceRefName)}`,
      `Target: ${formatRef(pr.targetRefName)}`,
      `URL: ${pullRequestWebUrl(ctx, pr.pullRequestId)}`,
      "Description:",
      pr.description?.length ? pr.description : "(empty)",
    ].join("\n");
  }

  return { create, update, get, findForCurrentBranch, resolve, resolveId, format };
}
