import type { AzureDevOpsRepoContext } from "./lib.ts";

export const API_VERSION = "7.1";
const CONNECTION_DATA_API_VERSION = "7.1-preview.1";

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

interface AzureRequestBaseOptions {
  method?: string;
  /** Sends an explicit value in the HTTP Accept request header. */
  accept?: string;
}

interface AzureJsonBodyOptions {
  body?: unknown;
  rawBody?: never;
  contentType?: never;
}

interface AzureRawBodyOptions {
  body?: never;
  rawBody: Uint8Array<ArrayBuffer>;
  contentType: string;
}

type AzureBodyOptions = AzureJsonBodyOptions | AzureRawBodyOptions;

export type AzureJsonRequestOptions = AzureRequestBaseOptions & AzureBodyOptions & {
  responseType?: "json";
};

export type AzureTextRequestOptions = AzureRequestBaseOptions & AzureBodyOptions & {
  responseType: "text";
};

export type AzureNoContentRequestOptions = AzureRequestBaseOptions & AzureBodyOptions & {
  responseType: "none";
};

export type AzureRequestOptions =
  | AzureJsonRequestOptions
  | AzureTextRequestOptions
  | AzureNoContentRequestOptions;

export interface AzureResponseMetadata {
  headers: Headers;
  status: number;
  statusText: string;
  url: string;
}

export interface AzureResponse<T> {
  data: T;
  metadata: AzureResponseMetadata;
}

export interface AzureRequester {
  request(url: string, options: AzureNoContentRequestOptions): Promise<void>;
  request(url: string, options: AzureTextRequestOptions): Promise<string>;
  request<T>(url: string, options?: AzureJsonRequestOptions): Promise<T>;
  requestWithMetadata(
    url: string,
    options: AzureNoContentRequestOptions,
  ): Promise<AzureResponse<void>>;
  requestWithMetadata(
    url: string,
    options: AzureTextRequestOptions,
  ): Promise<AzureResponse<string>>;
  requestWithMetadata<T>(
    url: string,
    options?: AzureJsonRequestOptions,
  ): Promise<AzureResponse<T>>;
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
  async function requestWithMetadata<T>(
    url: string,
    options: AzureRequestOptions = {},
  ): Promise<AzureResponse<T | void>> {
    const hasRawBody = options.rawBody !== undefined;
    const hasJsonBody = options.body !== undefined;
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: authHeader(pat),
        ...(options.accept === undefined ? {} : { Accept: options.accept }),
        ...(hasRawBody
          ? { "Content-Type": options.contentType }
          : hasJsonBody
            ? { "Content-Type": "application/json" }
            : {}),
      },
      body: hasRawBody ? options.rawBody : hasJsonBody ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `Azure DevOps API request (${options.method ?? "GET"} ${url}) failed: ${response.status} ${response.statusText}\n${await response.text()}`,
      );
    }

    const metadata: AzureResponseMetadata = {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
    };
    if (options.responseType === "none") {
      return { data: undefined, metadata };
    }
    const data = options.responseType === "text" ? await response.text() : await response.json();
    return { data: data as T, metadata };
  }

  async function request<T>(url: string, options: AzureRequestOptions = {}): Promise<T | void> {
    return (await requestWithMetadata<T>(url, options)).data;
  }

  return {
    request: request as AzureRequester["request"],
    requestWithMetadata: requestWithMetadata as AzureRequester["requestWithMetadata"],
  };
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
