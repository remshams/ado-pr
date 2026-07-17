import type { AzureDevOpsRepoContext } from "./lib.ts";

export const API_VERSION = "7.1";

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

export async function azureRequest<T>(
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
export function orgProjectUrl(ctx: AzureDevOpsRepoContext): string {
  return `https://dev.azure.com/${encodeURIComponent(ctx.organization)}/${encodeURIComponent(ctx.project)}`;
}

export function reposBaseUrl(ctx: AzureDevOpsRepoContext): string {
  return `${orgProjectUrl(ctx)}/_apis/git/repositories/${encodeURIComponent(ctx.repository)}`;
}

export function pullRequestApiUrl(ctx: AzureDevOpsRepoContext, prId: number, suffix = ""): string {
  return `${reposBaseUrl(ctx)}/pullRequests/${prId}${suffix}`;
}

export function pullRequestWebUrl(ctx: AzureDevOpsRepoContext, prId: number): string {
  return `${orgProjectUrl(ctx)}/_git/${encodeURIComponent(ctx.repository)}/pullrequest/${prId}`;
}
