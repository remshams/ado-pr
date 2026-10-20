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

export type AzureJsonRequestOptions = AzureRequestBaseOptions &
	AzureBodyOptions & {
		responseType?: "json";
	};

export type AzureTextRequestOptions = AzureRequestBaseOptions &
	AzureBodyOptions & {
		responseType: "text";
	};

export type AzureNoContentRequestOptions = AzureRequestBaseOptions &
	AzureBodyOptions & {
		responseType: "none";
	};

type AzureRequestOptions =
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

export type AzureRequestErrorKind =
	| "http"
	| "network"
	| "timeout"
	| "abort"
	| "response";

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
		if (details.retryAfterMs !== undefined)
			this.retryAfterMs = details.retryAfterMs;
	}
}

export function isAzureRequestError(
	error: unknown,
): error is AzureRequestError {
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
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SENSITIVE_KEY =
	/(?:authorization|token|secret|password|key|cookie|session|credential|signature|sig)/i;

function assertPositiveSafeInteger(
	value: number | undefined,
	name: string,
	maximum = Number.MAX_SAFE_INTEGER,
): void {
	if (value === undefined) return;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(
			maximum === Number.MAX_SAFE_INTEGER
				? `${name} must be a positive safe integer.`
				: `${name} must be a positive safe integer no greater than ${maximum}.`,
		);
	}
}

function stripTerminalControls(value: string): string {
	return value
		.replace(
			/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?|.)?/g,
			"",
		)
		.replace(
			/[\x00-\x08\x0B-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
			"",
		);
}

function isSensitiveKey(value: string): boolean {
	return SENSITIVE_KEY.test(value.replace(/[_-]/g, ""));
}

function boundSanitizationInput(
	value: string,
	pat: string,
	maxBytes: number,
): string {
	const encodedPatLength = Math.ceil(((pat.length + 1) * 4) / 3);
	const maximumCodeUnits = maxBytes * 4 + pat.length + encodedPatLength + 512;
	return value.length <= maximumCodeUnits
		? value
		: value.slice(0, maximumCodeUnits);
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

	redacted = redacted.replace(
		/("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/g,
		(match, encodedKey: string, separator: string) => {
			try {
				const key = JSON.parse(encodedKey) as unknown;
				return typeof key === "string" && isSensitiveKey(key)
					? `${encodedKey}${separator}"<redacted>"`
					: match;
			} catch {
				return match;
			}
		},
	);

	return redacted.replace(
		/(([\w-]*(?:authorization|token|secret|password|key|cookie|session|credential|signature|sig)[\w-]*)\s*[:=]\s*)(?:basic\s+|bearer\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n,;}]+)/gi,
		"$1<redacted>",
	);
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
	const boundedInput = boundSanitizationInput(value, pat, maxBytes);
	return boundUtf8(redactSensitiveText(boundedInput, pat), maxBytes);
}

function safeRequestUrl(value: string, pat: string): string {
	const boundedValue = boundSanitizationInput(value, pat, MAX_SAFE_URL_BYTES);
	let safeValue: string;
	try {
		const url = new URL(boundedValue);
		if (url.username.length > 0) url.username = "<redacted>";
		if (url.password.length > 0) url.password = "<redacted>";
		url.pathname = url.pathname
			.split("/")
			.map((segment) => {
				try {
					const decoded = decodeURIComponent(segment);
					return redactSensitiveText(decoded, pat) ===
						stripTerminalControls(decoded)
						? segment
						: "<redacted>";
				} catch {
					return "<redacted>";
				}
			})
			.join("/");
		for (const [name, parameterValue] of [...url.searchParams]) {
			if (
				isSensitiveKey(name) ||
				redactSensitiveText(parameterValue, pat) !==
					stripTerminalControls(parameterValue)
			) {
				url.searchParams.set(name, "<redacted>");
			}
		}
		if (url.hash.length > 0) {
			try {
				const decodedHash = decodeURIComponent(url.hash.slice(1));
				if (
					redactSensitiveText(decodedHash, pat) !==
					stripTerminalControls(decodedHash)
				) {
					url.hash = "<redacted>";
				}
			} catch {
				url.hash = "<redacted>";
			}
		}
		safeValue = url.toString().replaceAll("%3Credacted%3E", "<redacted>");
	} catch {
		safeValue = boundedValue;
	}
	return sanitizeBounded(safeValue, pat, MAX_SAFE_URL_BYTES);
}

function safeErrorDetail(error: unknown, pat: string): string {
	let detail = "Unknown error";
	try {
		if (error instanceof Error) detail = error.message;
		else if (typeof error === "string") detail = error;
	} catch {
		// Keep the generic detail when an injected error has hostile accessors.
	}
	return sanitizeBounded(detail, pat, MAX_ERROR_SOURCE_BYTES);
}

function sanitizeErrorBody(text: string, pat: string): string {
	try {
		const parsed = JSON.parse(text) as unknown;
		const redactJson = (value: unknown, key?: string): unknown => {
			if (key !== undefined && isSensitiveKey(key)) return "<redacted>";
			if (Array.isArray(value)) return value.map((entry) => redactJson(entry));
			if (value !== null && typeof value === "object") {
				const result: Record<string, unknown> = Object.create(null) as Record<
					string,
					unknown
				>;
				for (const [entryKey, entryValue] of Object.entries(value)) {
					result[entryKey] = redactJson(entryValue, entryKey);
				}
				return result;
			}
			return typeof value === "string"
				? redactSensitiveText(value, pat)
				: value;
		};
		return sanitizeBounded(
			JSON.stringify(redactJson(parsed)),
			pat,
			MAX_ERROR_RESPONSE_BYTES,
		);
	} catch {
		return sanitizeBounded(text, pat, MAX_ERROR_RESPONSE_BYTES);
	}
}

function parseRetryAfter(
	value: string | null,
	responseReceivedAt: number,
	currentTime: number,
): number | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (/^-\d+$/.test(trimmed)) return undefined;
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		const initialDelay =
			!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000
				? Number.MAX_SAFE_INTEGER
				: seconds * 1_000;
		const elapsed = Math.max(0, currentTime - responseReceivedAt);
		return Math.max(0, initialDelay - elapsed);
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isFinite(dateMs) || dateMs < responseReceivedAt) return undefined;
	return Math.max(0, dateMs - currentTime);
}

class ResponseBodyReadError {
	readonly cause: unknown;

	constructor(cause: unknown) {
		this.cause = cause;
	}
}

class ResponseBodySizeError extends Error {}

type AwaitCancellable = <T>(
	operation: PromiseLike<T>,
	options?: { onCancellation?: () => void; onLateSuccess?: (value: T) => void },
) => Promise<T>;

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null): void {
	if (body === null) return;
	try {
		void body.cancel().catch(() => undefined);
	} catch {
		// Cancellation is cleanup only.
	}
}

function cancelReaderBestEffort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
	try {
		void reader.cancel().catch(() => undefined);
	} catch {
		// Cancellation is cleanup only.
	}
}

async function readTextWithByteLimit(
	response: Response,
	maxBytes: number,
	truncate: boolean,
	awaitCancellable: AwaitCancellable,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		let text: string;
		try {
			text = await awaitCancellable(response.text());
		} catch (error) {
			if (isAzureRequestError(error)) throw error;
			throw new ResponseBodyReadError(error);
		}
		const bytes = Buffer.from(text);
		const exceeded = bytes.byteLength > maxBytes;
		if (exceeded && !truncate)
			throw new ResponseBodySizeError(
				`response body exceeded ${maxBytes} bytes`,
			);
		return {
			text: bytes.subarray(0, maxBytes).toString("utf8"),
			truncated: exceeded,
		};
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		let result: ReadableStreamReadResult<Uint8Array>;
		try {
			result = await awaitCancellable(reader.read(), {
				onCancellation: () => cancelReaderBestEffort(reader),
			});
		} catch (error) {
			if (isAzureRequestError(error)) throw error;
			throw new ResponseBodyReadError(error);
		}
		if (result.done) break;
		const remaining = maxBytes - total;
		if (result.value.byteLength > remaining) {
			if (!truncate) {
				cancelReaderBestEffort(reader);
				throw new ResponseBodySizeError(
					`response body exceeded ${maxBytes} bytes`,
				);
			}
			if (remaining > 0) chunks.push(result.value.subarray(0, remaining));
			truncated = true;
			cancelReaderBestEffort(reader);
			break;
		}
		chunks.push(result.value);
		total += result.value.byteLength;
	}
	return {
		text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
			"utf8",
		),
		truncated,
	};
}

/** Creates an authenticated Azure requester around an explicitly owned fetch implementation. */
export function createAzureRequester({
	pat,
	fetch: fetchImpl = globalThis.fetch,
	now = Date.now,
}: {
	pat: string;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}): AzureRequester {
	async function requestWithMetadata<T>(
		url: string,
		options: AzureRequestOptions = {},
	): Promise<AzureResponse<T | undefined>> {
		assertPositiveSafeInteger(
			options.timeoutMs,
			"Azure request timeoutMs",
			MAX_TIMER_DELAY_MS,
		);
		assertPositiveSafeInteger(
			options.maxResponseBytes,
			"Azure request maxResponseBytes",
		);
		const method = options.method ?? "GET";
		const safeUrl = safeRequestUrl(url, pat);
		const hasRawBody = options.rawBody !== undefined;
		const hasJsonBody = options.body !== undefined;
		const controller =
			options.signal === undefined && options.timeoutMs === undefined
				? undefined
				: new AbortController();
		let abortSource: "caller" | "timeout" | undefined;
		let settleCancellation: (() => void) | undefined;
		const cancellation =
			controller === undefined
				? undefined
				: new Promise<void>((resolve) => {
						settleCancellation = resolve;
					});
		const abortRequest = (source: "caller" | "timeout"): void => {
			if (abortSource !== undefined) return;
			abortSource = source;
			controller?.abort();
			settleCancellation?.();
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
		let phase: "request" | "fetch" | "http" | "response" = "request";
		let response: Response | undefined;
		let responseReceivedAt: number | undefined;

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
		const cancellationFence = (): void => {
			if (abortSource !== undefined) throw cancellationError();
		};
		const awaitCancellable: AwaitCancellable = async (
			operation,
			callbacks = {},
		) => {
			const observed = Promise.resolve(operation).then(
				(value) => ({ type: "success" as const, value }),
				(error: unknown) => ({ type: "failure" as const, error }),
			);
			if (cancellation === undefined) {
				const outcome = await observed;
				if (outcome.type === "failure") throw outcome.error;
				return outcome.value;
			}

			const outcome = await Promise.race([
				observed,
				cancellation.then(() => ({ type: "cancelled" as const })),
			]);
			if (outcome.type === "cancelled") {
				try {
					callbacks.onCancellation?.();
				} catch {
					// Cancellation cleanup cannot replace the classified cancellation error.
				}
				void observed.then((lateOutcome) => {
					if (lateOutcome.type === "success") {
						try {
							callbacks.onLateSuccess?.(lateOutcome.value);
						} catch {
							// Late cleanup is best effort only.
						}
					}
				});
				throw cancellationError();
			}
			if (abortSource !== undefined) {
				try {
					callbacks.onCancellation?.();
					if (outcome.type === "success")
						callbacks.onLateSuccess?.(outcome.value);
				} catch {
					// Cancellation cleanup cannot replace the classified cancellation error.
				}
				throw cancellationError();
			}
			if (outcome.type === "failure") throw outcome.error;
			return outcome.value;
		};

		const httpError = (
			httpResponse: Response,
			excerpt: { text: string; truncated: boolean },
		): AzureRequestError => {
			const statusText = sanitizeBounded(
				httpResponse.statusText,
				pat,
				MAX_STATUS_TEXT_BYTES,
			);
			const detail = sanitizeErrorBody(excerpt.text, pat);
			const retryAfterMs = parseRetryAfter(
				httpResponse.headers.get("retry-after"),
				responseReceivedAt ?? now(),
				now(),
			);
			return new AzureRequestError(
				`Azure DevOps API request (${method} ${safeUrl}) failed: ${httpResponse.status} ${statusText}` +
					`${detail.length === 0 ? "" : `\n${detail}`}${excerpt.truncated ? "\n<response body truncated>" : ""}`,
				"http",
				{ status: httpResponse.status, retryAfterMs },
			);
		};

		try {
			cancellationFence();
			let requestBody: Uint8Array<ArrayBuffer> | string | undefined;
			if (hasRawBody) {
				requestBody = options.rawBody;
			} else if (hasJsonBody) {
				try {
					requestBody = JSON.stringify(options.body);
				} catch (error) {
					const detail = safeErrorDetail(error, pat);
					throw new AzureRequestError(
						`Azure DevOps API request (${method} ${safeUrl}) failed: request body could not be serialized${detail.length === 0 ? "" : ` (${detail})`}.`,
						"response",
					);
				}
			}
			cancellationFence();

			phase = "fetch";
			response = await awaitCancellable(
				fetchImpl(url, {
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
				}),
				{
					onLateSuccess: (lateResponse) =>
						cancelBodyBestEffort(lateResponse.body),
				},
			);
			responseReceivedAt = now();
			cancellationFence();

			if (!response.ok) {
				phase = "http";
				const excerpt = await readTextWithByteLimit(
					response,
					MAX_ERROR_RESPONSE_BYTES,
					true,
					awaitCancellable,
				);
				cancellationFence();
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
				cancellationFence();
				return { data: undefined, metadata };
			}

			const text = (
				await readTextWithByteLimit(
					response,
					options.maxResponseBytes ?? Number.MAX_SAFE_INTEGER,
					false,
					awaitCancellable,
				)
			).text;
			cancellationFence();
			if (options.responseType === "text") {
				cancellationFence();
				return { data: text as T, metadata };
			}

			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				throw new AzureRequestError(
					`Azure DevOps API request (${method} ${safeUrl}) failed: response body was not valid JSON.`,
					"response",
				);
			}
			cancellationFence();
			return { data: data as T, metadata };
		} catch (error) {
			if (abortSource !== undefined) throw cancellationError();
			if (isAzureRequestError(error)) throw error;
			if (error instanceof ResponseBodyReadError) {
				if (phase === "http" && response !== undefined) {
					throw httpError(response, { text: "", truncated: false });
				}
				const detail = safeErrorDetail(error.cause, pat);
				throw new AzureRequestError(
					`Azure DevOps API request (${method} ${safeUrl}) failed: network response body read failed${detail.length === 0 ? "" : ` (${detail})`}.`,
					"network",
				);
			}
			const detail = safeErrorDetail(error, pat);
			if (phase === "response" || phase === "http" || phase === "request") {
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

	async function request<T>(
		url: string,
		options: AzureRequestOptions = {},
	): Promise<T | undefined> {
		return (await requestWithMetadata<T>(url, options)).data;
	}

	return {
		request: request as AzureRequester["request"],
		requestWithMetadata:
			requestWithMetadata as AzureRequester["requestWithMetadata"],
	};
}

/** Base `https://dev.azure.com/{org}/{project}` URL shared by both the REST API and web UI. */
export function orgProjectUrl(ctx: AzureDevOpsRepoContext): string {
	return `https://dev.azure.com/${encodeURIComponent(ctx.organization)}/${encodeURIComponent(ctx.project)}`;
}

export function reposBaseUrl(ctx: AzureDevOpsRepoContext): string {
	return `${orgProjectUrl(ctx)}/_apis/git/repositories/${encodeURIComponent(ctx.repository)}`;
}

export function pullRequestApiUrl(
	ctx: AzureDevOpsRepoContext,
	prId: number,
	suffix = "",
): string {
	return `${reposBaseUrl(ctx)}/pullRequests/${prId}${suffix}`;
}

export function pullRequestWebUrl(
	ctx: AzureDevOpsRepoContext,
	prId: number,
): string {
	return `${orgProjectUrl(ctx)}/_git/${encodeURIComponent(ctx.repository)}/pullrequest/${prId}`;
}
