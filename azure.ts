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
  /** Aborts the request, including response-body reads, after this many milliseconds. */
  timeoutMs?: number;
  /** Rejects a successful response whose decoded body exceeds this UTF-8 byte count. */
  maxResponseBytes?: number;
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

const MAX_ERROR_RESPONSE_BYTES = 4_096;

function assertPositiveSafeInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

function redactSensitiveText(value: string, pat: string): string {
  const encodedPat = Buffer.from(`:${pat}`).toString("base64");
  return stripTerminalControls(value)
    .replaceAll(pat, "<redacted>")
    .replaceAll(encodedPat, "<redacted>")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;]+/gi, "$1<redacted>")
    .replace(/((?:access[_-]?token|client[_-]?secret|password|signature|sig)\s*[:=]\s*)[^\s,;&]+/gi, "$1<redacted>");
}

function safeRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const name of url.searchParams.keys()) {
      if (/(?:token|signature|secret|password|key|sig)$/i.test(name)) {
        url.searchParams.set(name, "<redacted>");
      }
    }
    return url.toString().replaceAll("%3Credacted%3E", "<redacted>");
  } catch {
    return stripTerminalControls(value);
  }
}

async function readTextWithByteLimit(
  response: Response,
  maxBytes: number,
  truncate: boolean,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.text());
    const exceeded = bytes.byteLength > maxBytes;
    if (exceeded && !truncate) throw new Error(`response body exceeded ${maxBytes} bytes`);
    return {
      text: bytes.subarray(0, maxBytes).toString("utf8"),
      truncated: exceeded,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (!truncate) {
        await reader.cancel();
        throw new Error(`response body exceeded ${maxBytes} bytes`);
      }
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    truncated,
  };
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
    assertPositiveSafeInteger(options.timeoutMs, "Azure request timeoutMs");
    assertPositiveSafeInteger(options.maxResponseBytes, "Azure request maxResponseBytes");
    const method = options.method ?? "GET";
    const safeUrl = safeRequestUrl(url);
    const hasRawBody = options.rawBody !== undefined;
    const hasJsonBody = options.body !== undefined;
    const controller = options.timeoutMs === undefined ? undefined : new AbortController();
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
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
        signal: controller?.signal,
      });

      if (!response.ok) {
        const excerpt = await readTextWithByteLimit(response, MAX_ERROR_RESPONSE_BYTES, true);
        const detail = redactSensitiveText(excerpt.text, pat);
        throw new Error(
          `Azure DevOps API request (${method} ${safeUrl}) failed: ${response.status} ${stripTerminalControls(response.statusText)}` +
            `${detail.length === 0 ? "" : `\n${detail}`}${excerpt.truncated ? "\n<response body truncated>" : ""}`,
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

      let data: unknown;
      if (options.maxResponseBytes === undefined) {
        data = options.responseType === "text" ? await response.text() : await response.json();
      } else {
        let text: string;
        try {
          text = (await readTextWithByteLimit(response, options.maxResponseBytes, false)).text;
        } catch (error) {
          throw new Error(
            `Azure DevOps API request (${method} ${safeUrl}) failed: ${(error as Error).message}.`,
          );
        }
        data = options.responseType === "text" ? text : JSON.parse(text);
      }
      return { data: data as T, metadata };
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new Error(
          `Azure DevOps API request (${method} ${safeUrl}) timed out after ${options.timeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
