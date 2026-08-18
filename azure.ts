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
  /** Aborts the request when the caller cancels this signal. */
  signal?: AbortSignal;
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

export type AzureRequestErrorKind = "http" | "network" | "timeout" | "abort" | "response";

/** A sanitized request failure that callers can classify without inspecting its message. */
export class AzureRequestError extends Error {
  readonly kind: AzureRequestErrorKind;
  declare readonly status?: number;
  declare readonly retryAfterMs?: number;

  constructor(
    message: string,
    kind: AzureRequestErrorKind,
    details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

export function isAzureRequestError(error: unknown): error is AzureRequestError {
  return error instanceof AzureRequestError;
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
const MAX_ERROR_SOURCE_BYTES = 1_024;
const MAX_STATUS_TEXT_BYTES = 256;
const MAX_SAFE_URL_BYTES = 2_048;

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
  let redacted = stripTerminalControls(value);
  if (pat.length > 0) {
    redacted = redacted
      .replaceAll(pat, "<redacted>")
      .replaceAll(encodedPat, "<redacted>")
      .replaceAll(encodeURIComponent(pat), "<redacted>")
      .replaceAll(encodeURIComponent(encodedPat), "<redacted>");
  }
  return redacted
    .replace(/((?:"?(?:authorization|proxy-authorization)"?)\s*[:=]\s*"?)(?:basic|bearer)?\s*[^\s",;}]+/gi, "$1<redacted>")
    .replace(/((?:"?(?:access[_-]?token|client[_-]?secret|password|signature|sig)"?)\s*[:=]\s*"?)[^\s",;&}]+/gi, "$1<redacted>");
}

function boundUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  const budget = Math.max(0, maxBytes - 3);
  let prefix = bytes.subarray(0, budget).toString("utf8");
  while (Buffer.byteLength(prefix) > budget) prefix = prefix.slice(0, -1);
  return `${prefix}...`;
}

function sanitizeBounded(value: string, pat: string, maxBytes: number): string {
  return boundUtf8(redactSensitiveText(value, pat), maxBytes);
}

function safeRequestUrl(value: string, pat: string): string {
  let safeValue: string;
  try {
    const url = new URL(value);
    if (url.username.length > 0) url.username = "<redacted>";
    if (url.password.length > 0) url.password = "<redacted>";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => {
        try {
          const decoded = decodeURIComponent(segment);
          return redactSensitiveText(decoded, pat) === stripTerminalControls(decoded)
            ? segment
            : "<redacted>";
        } catch {
          return "<redacted>";
        }
      })
      .join("/");
    for (const [name, parameterValue] of [...url.searchParams]) {
      if (
        /(?:token|signature|secret|password|key|sig)$/i.test(name) ||
        redactSensitiveText(parameterValue, pat) !== stripTerminalControls(parameterValue)
      ) {
        url.searchParams.set(name, "<redacted>");
      }
    }
    if (url.hash.length > 0) {
      try {
        const decodedHash = decodeURIComponent(url.hash.slice(1));
        if (redactSensitiveText(decodedHash, pat) !== stripTerminalControls(decodedHash)) {
          url.hash = "<redacted>";
        }
      } catch {
        url.hash = "<redacted>";
      }
    }
    safeValue = url.toString().replaceAll("%3Credacted%3E", "<redacted>");
  } catch {
    safeValue = value;
  }
  return sanitizeBounded(safeValue, pat, MAX_SAFE_URL_BYTES);
}

function safeErrorDetail(error: unknown, pat: string): string {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return sanitizeBounded(detail, pat, MAX_ERROR_SOURCE_BYTES);
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const delay = dateMs - nowMs;
  return delay >= 0 && Number.isSafeInteger(delay) ? delay : undefined;
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
        await reader.cancel().catch(() => undefined);
        throw new Error(`response body exceeded ${maxBytes} bytes`);
      }
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => undefined);
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
    const safeUrl = safeRequestUrl(url, pat);
    const hasRawBody = options.rawBody !== undefined;
    const hasJsonBody = options.body !== undefined;
    const requestBody = hasRawBody
      ? options.rawBody
      : hasJsonBody
        ? JSON.stringify(options.body)
        : undefined;
    const controller =
      options.signal === undefined && options.timeoutMs === undefined
        ? undefined
        : new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    const abortRequest = (source: "caller" | "timeout"): void => {
      if (abortSource !== undefined) return;
      abortSource = source;
      controller?.abort();
    };
    const onCallerAbort = (): void => abortRequest("caller");
    if (options.signal?.aborted) {
      abortRequest("caller");
    } else {
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer =
      options.timeoutMs === undefined || abortSource !== undefined
        ? undefined
        : setTimeout(() => abortRequest("timeout"), options.timeoutMs);
    let phase: "fetch" | "http" | "response" = "fetch";
    let response: Response | undefined;

    const cancellationError = (): AzureRequestError => {
      if (abortSource === "timeout") {
        return new AzureRequestError(
          `Azure DevOps API request (${method} ${safeUrl}) timed out after ${options.timeoutMs}ms.`,
          "timeout",
        );
      }
      return new AzureRequestError(
        `Azure DevOps API request (${method} ${safeUrl}) was aborted by the caller.`,
        "abort",
      );
    };

    const httpError = (
      httpResponse: Response,
      excerpt?: { text: string; truncated: boolean },
      bodyReadError?: unknown,
    ): AzureRequestError => {
      const statusText = sanitizeBounded(httpResponse.statusText, pat, MAX_STATUS_TEXT_BYTES);
      const detail = excerpt === undefined
        ? bodyReadError === undefined
          ? ""
          : `<response body unavailable: ${safeErrorDetail(bodyReadError, pat)}>`
        : sanitizeBounded(excerpt.text, pat, MAX_ERROR_RESPONSE_BYTES);
      const retryAfterMs = parseRetryAfter(httpResponse.headers.get("retry-after"), Date.now());
      return new AzureRequestError(
        `Azure DevOps API request (${method} ${safeUrl}) failed: ${httpResponse.status} ${statusText}` +
          `${detail.length === 0 ? "" : `\n${detail}`}${excerpt?.truncated ? "\n<response body truncated>" : ""}`,
        "http",
        { status: httpResponse.status, retryAfterMs },
      );
    };

    try {
      if (abortSource !== undefined) throw cancellationError();
      response = await fetchImpl(url, {
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
        body: requestBody,
        signal: controller?.signal,
      });

      if (!response.ok) {
        phase = "http";
        const excerpt = await readTextWithByteLimit(response, MAX_ERROR_RESPONSE_BYTES, true);
        throw httpError(response, excerpt);
      }

      phase = "response";
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
        const text = (await readTextWithByteLimit(response, options.maxResponseBytes, false)).text;
        data = options.responseType === "text" ? text : JSON.parse(text);
      }
      return { data: data as T, metadata };
    } catch (error) {
      if (abortSource !== undefined) throw cancellationError();
      if (phase === "http" && response !== undefined) {
        if (isAzureRequestError(error) && error.kind === "http") throw error;
        throw httpError(response, undefined, error);
      }
      const detail = safeErrorDetail(error, pat);
      if (phase === "response") {
        throw new AzureRequestError(
          `Azure DevOps API request (${method} ${safeUrl}) failed: ${detail}.`,
          "response",
        );
      }
      throw new AzureRequestError(
        `Azure DevOps API request (${method} ${safeUrl}) failed: network request failed${detail.length === 0 ? "" : ` (${detail})`}.`,
        "network",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
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
