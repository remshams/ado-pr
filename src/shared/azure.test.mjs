import assert from "node:assert/strict";
import test from "node:test";

import {
	AzureRequestError,
	createAzureRequester,
	getAuthenticatedUserId,
	isAzureRequestError,
	orgProjectUrl,
	pullRequestApiUrl,
	pullRequestWebUrl,
	reposBaseUrl,
} from "./azure.ts";
import { createMockFetch } from "../../tests/test-helpers.mjs";

const fakePat = "test-only-fake-pat";
const expectedAuthorization = "<redacted>";

test("Azure requester defaults to an authenticated GET without a body", async (t) => {
	const { fetch, calls } = createMockFetch(t, [
		{ json: { value: ["fake-result"] } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	const result = await azure.request("https://example.invalid/default");

	assert.deepEqual(result, { value: ["fake-result"] });
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/default",
			method: "GET",
			headers: { authorization: expectedAuthorization },
			body: null,
		},
	]);
});

test("Azure requester supports plain text responses and an explicit Accept header", async (t) => {
	const { fetch, calls } = createMockFetch(t, [{ body: "fake log line\\n" }]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	const result = await azure.request("https://example.invalid/log", {
		responseType: "text",
		accept: "text/plain; charset=utf-8",
	});

	assert.equal(result, "fake log line\\n");
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/log",
			method: "GET",
			headers: {
				authorization: expectedAuthorization,
				accept: "text/plain; charset=utf-8",
			},
			body: null,
		},
	]);
});

test("Azure requester returns parsed data with response metadata", async (t) => {
	const { fetch, calls } = createMockFetch(t, [
		{
			json: { value: ["first-page"] },
			headers: {
				"x-ms-continuationtoken": "fake-next-page",
				"x-request-id": "fake-request-id",
			},
		},
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	const result = await azure.requestWithMetadata(
		"https://example.invalid/items",
		{
			accept: "application/json",
		},
	);

	assert.deepEqual(result.data, { value: ["first-page"] });
	assert.equal(
		result.metadata.headers.get("x-ms-continuationtoken"),
		"fake-next-page",
	);
	assert.equal(result.metadata.headers.get("x-request-id"), "fake-request-id");
	assert.equal(result.metadata.status, 200);
	assert.equal(result.metadata.statusText, "");
	assert.equal(result.metadata.url, "");
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/items",
			method: "GET",
			headers: {
				authorization: expectedAuthorization,
				accept: "application/json",
			},
			body: null,
		},
	]);
});

test("Azure requester keeps text bodies, Accept, and metadata compatible with mutations", async (t) => {
	const { fetch, calls } = createMockFetch(t, [{ body: "accepted" }]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	const result = await azure.requestWithMetadata(
		"https://example.invalid/log",
		{
			method: "POST",
			body: { query: "fake query" },
			responseType: "text",
			accept: "text/plain",
		},
	);

	assert.equal(result.data, "accepted");
	assert.equal(
		result.metadata.headers.get("content-type"),
		"text/plain;charset=UTF-8",
	);
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/log",
			method: "POST",
			headers: {
				authorization: expectedAuthorization,
				accept: "text/plain",
				"content-type": "application/json",
			},
			body: JSON.stringify({ query: "fake query" }),
		},
	]);
});

test("Azure requester sends mutations with a JSON body and Content-Type", async (t) => {
	const { fetch, calls } = createMockFetch(t, [
		{ json: { id: 17, status: "fake-created" } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });
	const body = {
		title: "Fake pull request",
		reviewers: [{ id: "fake-reviewer" }],
		draft: false,
	};

	const result = await azure.request("https://example.invalid/mutation", {
		method: "PATCH",
		body,
	});

	assert.deepEqual(result, { id: 17, status: "fake-created" });
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/mutation",
			method: "PATCH",
			headers: {
				authorization: expectedAuthorization,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	]);
});

test("Azure requester sends raw binary bytes with an explicit Content-Type", async (t) => {
	const { fetch, calls } = createMockFetch(t, [
		{ json: { displayName: "flow.png", url: "fake-url" } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	const result = await azure.request(
		"https://example.invalid/attachment/flow.png",
		{
			method: "POST",
			rawBody: new Uint8Array([0, 255, 16, 32]),
			contentType: "application/octet-stream",
		},
	);

	assert.deepEqual(result, { displayName: "flow.png", url: "fake-url" });
	assert.deepEqual(calls, [
		{
			url: "https://example.invalid/attachment/flow.png",
			method: "POST",
			headers: {
				authorization: expectedAuthorization,
				"content-type": "application/octet-stream",
			},
			body: { encoding: "base64", data: "AP8QIA==" },
		},
	]);
});

test("Azure requester supports successful requests that expect no response body", async (t) => {
	const { fetch } = createMockFetch(t, [
		{ body: "" },
		{ status: 204 },
		{ status: 204 },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	assert.equal(
		await azure.request("https://example.invalid/empty", {
			method: "PATCH",
			responseType: "none",
		}),
		undefined,
	);
	assert.equal(
		await azure.request("https://example.invalid/no-content", {
			method: "DELETE",
			responseType: "none",
		}),
		undefined,
	);
	const metadataResult = await azure.requestWithMetadata(
		"https://example.invalid/no-content-metadata",
		{
			method: "DELETE",
			responseType: "none",
		},
	);
	assert.equal(metadataResult.data, undefined);
	assert.equal(metadataResult.metadata.status, 204);
});

test("Azure requester reports the method, URL, status, status text, and response body on failure", async (t) => {
	const url = "https://example.invalid/failure?continuation=fake-token";
	const { fetch, calls } = createMockFetch(t, [
		{
			status: 429,
			statusText: "Too Many Requests",
			body: '{"message":"fake rate limit detail"}',
		},
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	await assert.rejects(
		azure.request(url, {
			method: "POST",
			body: { comment: "fake comment" },
		}),
		(error) => {
			assert.equal(error?.name, "Error");
			assert.ok(error instanceof AzureRequestError);
			assert.equal(isAzureRequestError(error), true);
			assert.equal(error.kind, "http");
			assert.equal(error.status, 429);
			assert.equal(error.retryAfterMs, undefined);
			assert.equal(
				error?.message,
				`Azure DevOps API request (POST ${url}) failed: 429 Too Many Requests\n{"message":"fake rate limit detail"}`,
			);
			assert.equal(error?.message.includes(fakePat), false);
			assert.equal(calls[0].headers.authorization, expectedAuthorization);
			return true;
		},
	);
});

test("Azure requester bounds successful response bodies when a caller sets a limit", async (t) => {
	const { fetch } = createMockFetch(t, [
		{ body: "123456" },
		{ json: { value: "too-large" } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	await assert.rejects(
		azure.request("https://example.invalid/text-limit", {
			responseType: "text",
			maxResponseBytes: 5,
		}),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "response");
			assert.match(error.message, /response body exceeded 5 bytes/);
			return true;
		},
	);
	await assert.rejects(
		azure.request("https://example.invalid/json-limit", {
			maxResponseBytes: 8,
		}),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "response");
			assert.match(error.message, /response body exceeded 8 bytes/);
			return true;
		},
	);
});

test("Azure requester aborts stalled requests at the caller-supplied timeout", async () => {
	const fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		});
	const azure = createAzureRequester({ pat: fakePat, fetch });
	const caller = new AbortController();

	await assert.rejects(
		azure.request("https://example.invalid/stalled", {
			signal: caller.signal,
			timeoutMs: 10,
		}),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "timeout");
			assert.equal(
				error.message,
				"Azure DevOps API request (GET https://example.invalid/stalled) timed out after 10ms.",
			);
			return true;
		},
	);
	caller.abort(new Error(`late caller reason ${fakePat}`));
});

test("Azure requester supports external cancellation in every response mode without leaking reasons", async () => {
	const secretReason = `Authorization: Bearer caller-secret password=${fakePat}\u001b[31m`;
	const fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), {
				once: true,
			});
		});
	const azure = createAzureRequester({ pat: fakePat, fetch });

	for (const options of [
		{},
		{ responseType: "text" },
		{ responseType: "none" },
	]) {
		const controller = new AbortController();
		const pending = azure.request("https://example.invalid/cancelled", {
			...options,
			signal: controller.signal,
			timeoutMs: 1_000,
		});
		controller.abort(new Error(secretReason));

		await assert.rejects(pending, (error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "abort");
			assert.equal(error.name, "Error");
			assert.doesNotMatch(
				error.message,
				/caller-secret|test-only-fake-pat|Authorization|\u001b/,
			);
			assert.doesNotMatch(
				JSON.stringify(error),
				/caller-secret|test-only-fake-pat|Authorization|\u001b/,
			);
			return true;
		});
	}
});

test("Azure requester gives the first cancellation source precedence", async () => {
	const caller = new AbortController();
	caller.abort(new Error(`timeout-like ${fakePat}`));
	let fetchCalled = false;
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => {
			fetchCalled = true;
			throw new Error("must not run");
		},
	});

	await assert.rejects(
		azure.request("https://example.invalid/pre-cancelled", {
			signal: caller.signal,
			timeoutMs: 1,
		}),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "abort");
			assert.doesNotMatch(error.message, /timeout-like|test-only-fake-pat/);
			return true;
		},
	);
	assert.equal(fetchCalled, false);
});

test("Azure requester exposes parsed Retry-After delays only for valid HTTP values", async (t) => {
	const now = 1_000;
	const futureDate = new Date(now + 120_000).toUTCString();
	const { fetch } = createMockFetch(t, [
		{ status: 429, headers: { "retry-after": "17" } },
		{ status: 503, headers: { "retry-after": futureDate } },
		{ status: 503, headers: { "retry-after": "-4" } },
		{ status: 503, headers: { "retry-after": "not-a-date" } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch, now: () => now });

	const errors = [];
	for (let index = 0; index < 4; index += 1) {
		try {
			await azure.request(`https://example.invalid/retry/${index}`);
			assert.fail("request should reject");
		} catch (error) {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "http");
			errors.push(error);
		}
	}

	assert.equal(errors[0].status, 429);
	assert.equal(errors[0].retryAfterMs, 17_000);
	assert.equal(errors[1].status, 503);
	assert.equal(errors[1].retryAfterMs, 120_000);
	assert.equal(errors[2].retryAfterMs, undefined);
	assert.equal(errors[3].retryAfterMs, undefined);
});

test("Azure requester classifies and sanitizes bounded network failures", async () => {
	const basicCredential = Buffer.from(`:${fakePat}`).toString("base64");
	const source =
		`\u001b[31mAuthorization: Basic ${basicCredential} password=${fakePat} client_secret=source-secret ` +
		"x".repeat(5_000);
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => {
			throw new Error(source);
		},
	});

	await assert.rejects(
		azure.request(
			`https://user:${fakePat}@example.invalid/${encodeURIComponent(fakePat)}?access_token=another-secret`,
		),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "network");
			assert.equal(error.status, undefined);
			assert.equal(error.retryAfterMs, undefined);
			assert.doesNotMatch(
				error.message,
				/test-only-fake-pat|another-secret|source-secret|Authorization.*Basic|\u001b/,
			);
			assert.match(error.message, /<redacted>/);
			assert.ok(error.message.length < 3_500);
			assert.doesNotMatch(
				JSON.stringify(error),
				/test-only-fake-pat|another-secret|source-secret|Authorization.*Basic|\u001b/,
			);
			return true;
		},
	);
});

test("Azure requester classifies malformed successful JSON as a sanitized response failure", async (t) => {
	const basicCredential = Buffer.from(`:${fakePat}`).toString("base64");
	const { fetch } = createMockFetch(t, [
		{
			body:
				`{"Authorization":"Basic ${basicCredential}",` +
				`"proxy-authorization":"Bearer response-secret","password":"${fakePat}"`,
		},
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	await assert.rejects(
		azure.request("https://example.invalid/malformed"),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "response");
			assert.doesNotMatch(
				error.message,
				/test-only-fake-pat|response-secret|Authorization.*Basic|\u001b/,
			);
			assert.doesNotMatch(
				JSON.stringify(error),
				/test-only-fake-pat|response-secret|Authorization.*Basic|\u001b/,
			);
			assert.ok(error.message.length < 1_500);
			return true;
		},
	);
});

test("Azure requester bounds and sanitizes untrusted API error details", async (t) => {
	const basicCredential = Buffer.from(`:${fakePat}`).toString("base64");
	const body =
		`\u001b[31mAuthorization: Basic ${basicCredential}\nAuthorization: Bearer response-secret\npassword=${fakePat}\n` +
		"x".repeat(5_000);
	const { fetch } = createMockFetch(t, [
		{ status: 500, statusText: "Bad Status", body },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	await assert.rejects(
		azure.request(
			"https://example.invalid/failure?continuationToken=opaque-secret",
		),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "http");
			assert.equal(error.status, 500);
			assert.doesNotMatch(
				error.message,
				/opaque-secret|test-only-fake-pat|response-secret|\u001b/,
			);
			assert.doesNotMatch(
				JSON.stringify(error),
				/opaque-secret|test-only-fake-pat|response-secret|\u001b/,
			);
			assert.match(error.message, /continuationToken=<redacted>/);
			assert.match(error.message, /Authorization: <redacted>/);
			assert.match(error.message, /password=<redacted>/);
			assert.match(error.message, /<response body truncated>/);
			assert.ok(error.message.length < 4_500);
			return true;
		},
	);
});

test("Azure requester validates timeout and response-limit options before fetch", async (t) => {
	const { fetch, calls } = createMockFetch(t);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	await assert.rejects(
		azure.request("https://example.invalid/invalid", { timeoutMs: 0 }),
		/timeoutMs must be a positive safe integer/,
	);
	await assert.rejects(
		azure.request("https://example.invalid/invalid", {
			maxResponseBytes: Number.MAX_SAFE_INTEGER + 1,
		}),
		/maxResponseBytes must be a positive safe integer/,
	);
	assert.deepEqual(calls, []);
});

test("cancellation settles promptly when fetch ignores its signal in every response mode", async () => {
	const modes = [{}, { responseType: "text" }, { responseType: "none" }];

	for (const cancellation of ["caller", "timeout"]) {
		for (const mode of modes) {
			let resolveFetch;
			let cancelledBodies = 0;
			const fetch = () =>
				new Promise((resolve) => {
					resolveFetch = resolve;
				});
			const azure = createAzureRequester({ pat: fakePat, fetch });
			const controller = new AbortController();
			const pending = azure.request("https://example.invalid/ignores-abort", {
				...mode,
				...(cancellation === "caller"
					? { signal: controller.signal }
					: { timeoutMs: 5 }),
			});
			if (cancellation === "caller")
				controller.abort(new Error(`secret ${fakePat}`));

			await assert.rejects(
				Promise.race([
					pending,
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error("cancellation was not prompt")),
							100,
						),
					),
				]),
				(error) => {
					assert.ok(error instanceof AzureRequestError);
					assert.equal(
						error.kind,
						cancellation === "caller" ? "abort" : "timeout",
					);
					return true;
				},
			);

			resolveFetch(
				new Response(
					new ReadableStream({
						cancel() {
							cancelledBodies += 1;
						},
					}),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(cancelledBodies, 1);
		}
	}
});

test("cancellation settles promptly when a response body read ignores its signal", async () => {
	let startedReading = false;
	const body = new ReadableStream({
		pull() {
			startedReading = true;
			return new Promise(() => {});
		},
		cancel() {
			return new Promise(() => {});
		},
	});
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => new Response(body),
	});
	const controller = new AbortController();
	const pending = azure.request("https://example.invalid/stalled-body", {
		responseType: "text",
		signal: controller.signal,
	});
	while (!startedReading)
		await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();

	await assert.rejects(
		Promise.race([
			pending,
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("body cancellation was not prompt")),
					100,
				),
			),
		]),
		(error) => error instanceof AzureRequestError && error.kind === "abort",
	);
});

test("response body transport errors are network failures, while decode and size failures are response failures", async () => {
	const partialFailureBody = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"partial":'));
			queueMicrotask(() =>
				controller.error(new Error("socket reset mid-body")),
			);
		},
	});
	const failedHttpBody = new ReadableStream({
		start(controller) {
			controller.error(new Error("socket reset while reading 401 detail"));
		},
	});
	const responses = [
		new Response(partialFailureBody),
		new Response('{"fragment":"must not appear"'),
		new Response("123456"),
		new Response(failedHttpBody, { status: 401, statusText: "Unauthorized" }),
	];
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => responses.shift(),
	});

	await assert.rejects(
		azure.request("https://example.invalid/partial"),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "network");
			return true;
		},
	);
	await assert.rejects(
		azure.request("https://example.invalid/malformed-generic"),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "response");
			assert.match(error.message, /response body was not valid JSON/);
			assert.doesNotMatch(error.message, /fragment|must not appear/);
			return true;
		},
	);
	await assert.rejects(
		azure.request("https://example.invalid/oversized", {
			responseType: "text",
			maxResponseBytes: 5,
		}),
		(error) => error instanceof AzureRequestError && error.kind === "response",
	);
	await assert.rejects(
		azure.request("https://example.invalid/http-body-failure"),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "http");
			assert.equal(error.status, 401);
			return true;
		},
	);
});

test("oversized timeout values are rejected before fetch", async () => {
	let fetchCalled = false;
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => {
			fetchCalled = true;
			return new Response();
		},
	});

	await assert.rejects(
		azure.request("https://example.invalid/timeout-overflow", {
			timeoutMs: 2_147_483_648,
		}),
		/no greater than 2147483647/,
	);
	assert.equal(fetchCalled, false);
});

test("a never-settling reader cancellation cannot block response-size rejection", async () => {
	let cancelStarted = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("oversized"));
		},
		cancel() {
			cancelStarted = true;
			return new Promise(() => {});
		},
	});
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => new Response(body),
	});

	await assert.rejects(
		Promise.race([
			azure.request("https://example.invalid/hostile-cancel", {
				responseType: "text",
				maxResponseBytes: 2,
			}),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("reader.cancel blocked rejection")),
					100,
				),
			),
		]),
		(error) => error instanceof AzureRequestError && error.kind === "response",
	);
	assert.equal(cancelStarted, true);
});

test("request-body serialization observes cancellation and sanitizes throwing toJSON failures", async () => {
	let toJSONCalls = 0;
	let fetchCalls = 0;
	const preAborted = new AbortController();
	preAborted.abort();
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => {
			fetchCalls += 1;
			return new Response();
		},
	});

	await assert.rejects(
		azure.request("https://example.invalid/pre-aborted-body", {
			signal: preAborted.signal,
			body: {
				toJSON() {
					toJSONCalls += 1;
				},
			},
		}),
		(error) => error instanceof AzureRequestError && error.kind === "abort",
	);
	assert.equal(toJSONCalls, 0);

	await assert.rejects(
		azure.request("https://example.invalid/throwing-body", {
			method: "POST",
			body: {
				toJSON() {
					throw new Error(
						`{"nested":{"client_secret":"white space secret"},"password":"${fakePat}"}`,
					);
				},
			},
		}),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "response");
			assert.doesNotMatch(
				error.message,
				/white space secret|test-only-fake-pat/,
			);
			assert.doesNotMatch(
				JSON.stringify(error),
				/white space secret|test-only-fake-pat/,
			);
			return true;
		},
	);
	assert.equal(fetchCalls, 0);
});

test("Retry-After uses response receipt time and saturates valid overflow deterministically", async () => {
	const date = new Date(20_000).toUTCString();
	const nowValues = [
		1_000, 4_000, 5_000, 8_000, 9_000, 12_000, 13_000, 16_000, 17_000, 20_000,
	];
	const responses = [
		new Response("delayed", { status: 429, headers: { "retry-after": "10" } }),
		new Response("delayed", { status: 503, headers: { "retry-after": date } }),
		new Response("delayed", {
			status: 503,
			headers: { "retry-after": "9".repeat(400) },
		}),
		new Response("delayed", { status: 503, headers: { "retry-after": "-1" } }),
		new Response("delayed", {
			status: 503,
			headers: { "retry-after": "invalid" },
		}),
	];
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () => responses.shift(),
		now: () => nowValues.shift(),
	});
	const errors = [];
	for (let index = 0; index < 5; index += 1) {
		try {
			await azure.request(
				`https://example.invalid/deterministic-retry/${index}`,
			);
			assert.fail("request should reject");
		} catch (error) {
			assert.ok(error instanceof AzureRequestError);
			errors.push(error);
		}
	}

	assert.equal(errors[0].retryAfterMs, 7_000);
	assert.equal(errors[1].retryAfterMs, 12_000);
	assert.equal(errors[2].retryAfterMs, Number.MAX_SAFE_INTEGER - 3_000);
	assert.equal(errors[3].retryAfterMs, undefined);
	assert.equal(errors[4].retryAfterMs, undefined);
});

test("HTTP error sanitization recursively redacts credentials and terminal controls", async () => {
	const encodedPat = Buffer.from(`:${fakePat}`).toString("base64");
	const body = JSON.stringify({
		message: "fake rate limit detail\n\tkept formatting",
		nested: {
			access_token: "white space token",
			ClientSecret: "another white space secret",
			deeper: [{ authorization: `Basic ${encodedPat}` }, { cookie: fakePat }],
		},
		controls: "carriage\rC1\u009b bidi\u202e ansi\u001b[31mend",
	});
	const azure = createAzureRequester({
		pat: fakePat,
		fetch: async () =>
			new Response(body, { status: 429, statusText: "Slow Down" }),
	});

	await assert.rejects(
		azure.request("https://example.invalid/sanitize"),
		(error) => {
			assert.ok(error instanceof AzureRequestError);
			assert.equal(error.kind, "http");
			assert.match(error.message, /fake rate limit detail/);
			assert.doesNotMatch(
				error.message,
				/white space token|another white space secret|test-only-fake-pat|\r|\u009b|\u202e|\u001b/,
			);
			const serialized = JSON.stringify(error);
			assert.doesNotMatch(
				serialized,
				/white space token|another white space secret|test-only-fake-pat|\r|\u009b|\u202e|\u001b/,
			);
			assert.equal(Object.hasOwn(error, "body"), false);
			return true;
		},
	);
});

test("authenticated-user lookup requests connection data and returns its identity id", async (t) => {
	const { fetch, calls } = createMockFetch(t, [
		{ json: { authenticatedUser: { id: "identity/id +?#" } } },
	]);
	const azure = createAzureRequester({ pat: fakePat, fetch });

	assert.equal(
		await getAuthenticatedUserId(azure, "org/name +&"),
		"identity/id +?#",
	);
	assert.deepEqual(calls, [
		{
			url:
				"https://dev.azure.com/org%2Fname%20%2B%26/_apis/connectionData?" +
				"connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
			method: "GET",
			headers: { authorization: expectedAuthorization },
			body: null,
		},
	]);
});

test("URL builders encode each context component and preserve API path syntax exactly", () => {
	const context = {
		organization: "org/name +&",
		project: "project?# /",
		repository: "repo/name +?#",
	};
	const orgProject =
		"https://dev.azure.com/org%2Fname%20%2B%26/project%3F%23%20%2F";
	const repos = `${orgProject}/_apis/git/repositories/repo%2Fname%20%2B%3F%23`;

	assert.equal(orgProjectUrl(context), orgProject);
	assert.equal(reposBaseUrl(context), repos);
	assert.equal(pullRequestApiUrl(context, 42), `${repos}/pullRequests/42`);
	assert.equal(
		pullRequestApiUrl(
			context,
			42,
			"/threads/7?api-version=7.1&includeDeleted=true",
		),
		`${repos}/pullRequests/42/threads/7?api-version=7.1&includeDeleted=true`,
	);
	assert.equal(
		pullRequestWebUrl(context, 42),
		`${orgProject}/_git/repo%2Fname%20%2B%3F%23/pullrequest/42`,
	);
});

test("Azure requester redacts sensitive or malformed URL fragments and preserves ordinary fragments", async (t) => {
	for (const [fragment, expectedFragment] of [
		["section-2", "section-2"],
		[encodeURIComponent(fakePat), "<redacted>"],
		["password=hidden-value", "<redacted>"],
		["%invalid", "<redacted>"],
	]) {
		const { fetch } = createMockFetch(t, [{ status: 403, body: "denied" }]);
		const azure = createAzureRequester({ pat: fakePat, fetch });
		await assert.rejects(
			azure.request(`https://example.invalid/items#${fragment}`),
			(error) => {
				assert.equal(error.kind, "http");
				assert.equal(
					error.message,
					`Azure DevOps API request (GET https://example.invalid/items#${expectedFragment}) failed: 403 \ndenied`,
				);
				return true;
			},
		);
	}
});
