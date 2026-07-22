import type { AzureDevOpsRepoContext } from "./lib.ts";

export const API_VERSION = "7.1";
const CONNECTION_DATA_API_VERSION = "7.1-preview.1";

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

interface AzureRequestBaseOptions {
  method?: string;
  body?: unknown;
}

export interface AzureJsonRequestOptions extends AzureRequestBaseOptions {
  responseType?: "json";
}

export interface AzureNoContentRequestOptions extends AzureRequestBaseOptions {
  responseType: "none";
}

export type AzureRequestOptions = AzureJsonRequestOptions | AzureNoContentRequestOptions;

export interface AzureRequester {
  request(url: string, options: AzureNoContentRequestOptions): Promise<void>;
  request<T>(url: string, options?: AzureJsonRequestOptions): Promise<T>;
}

/** Gets the identity id authenticated by the PAT from the PAT-compatible connection endpoint. */
export async function getAuthenticatedUserId(
  azure: AzureRequester,
  organization: string,
): Promise<string> {
  const url = `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=${CONNECTION_DATA_API_VERSION}`;
  const data = await azure.request<{ authenticatedUser: { id: string } }>(url);
  return data.authenticatedUser.id;
}

/** Creates an authenticated Azure requester around an explicitly owned fetch implementation. */
export function createAzureRequester({
  pat,
  fetch: fetchImpl = globalThis.fetch,
}: {
  pat: string;
  fetch?: typeof globalThis.fetch;
}): AzureRequester {
  async function request<T>(url: string, options: AzureRequestOptions = {}): Promise<T | void> {
    const response = await fetchImpl(url, {
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

    if (options.responseType === "none") {
      return;
    }
    return (await response.json()) as T;
  }

  return { request: request as AzureRequester["request"] };
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
