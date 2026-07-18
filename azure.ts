import type { AzureDevOpsRepoContext } from "./lib.ts";

export const API_VERSION = "7.1";

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
