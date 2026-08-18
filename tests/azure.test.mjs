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
} from "../azure.ts";
import { createMockFetch } from "./test-helpers.mjs";

const fakePat = "test-only-fake-pat";
const expectedAuthorization = "<redacted>";

test("Azure requester defaults to an authenticated GET without a body", async (t) => {
  const { fetch, calls } = createMockFetch(t, [{ json: { value: ["fake-result"] } }]);
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

  const result = await azure.requestWithMetadata("https://example.invalid/items", {
    accept: "application/json",
  });

  assert.deepEqual(result.data, { value: ["first-page"] });
  assert.equal(result.metadata.headers.get("x-ms-continuationtoken"), "fake-next-page");
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

  const result = await azure.requestWithMetadata("https://example.invalid/log", {
    method: "POST",
    body: { query: "fake query" },
    responseType: "text",
    accept: "text/plain",
  });

  assert.equal(result.data, "accepted");
  assert.equal(result.metadata.headers.get("content-type"), "text/plain;charset=UTF-8");
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
  const { fetch, calls } = createMockFetch(t, [{ json: { id: 17, status: "fake-created" } }]);
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

  const result = await azure.request("https://example.invalid/attachment/flow.png", {
    method: "POST",
    rawBody: new Uint8Array([0, 255, 16, 32]),
    contentType: "application/octet-stream",
  });

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
  const { fetch } = createMockFetch(t, [{ body: "" }, { status: 204 }, { status: 204 }]);
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
  const metadataResult = await azure.requestWithMetadata("https://example.invalid/no-content-metadata", {
    method: "DELETE",
    responseType: "none",
  });
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
    azure.request("https://example.invalid/json-limit", { maxResponseBytes: 8 }),
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
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
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
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  const azure = createAzureRequester({ pat: fakePat, fetch });

  for (const options of [{}, { responseType: "text" }, { responseType: "none" }]) {
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
      assert.doesNotMatch(error.message, /caller-secret|test-only-fake-pat|Authorization|\u001b/);
      assert.doesNotMatch(JSON.stringify(error), /caller-secret|test-only-fake-pat|Authorization|\u001b/);
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
  const futureDate = new Date(Date.now() + 120_000).toUTCString();
  const { fetch } = createMockFetch(t, [
    { status: 429, headers: { "retry-after": "17" } },
    { status: 503, headers: { "retry-after": futureDate } },
    { status: 503, headers: { "retry-after": "-4" } },
    { status: 503, headers: { "retry-after": "not-a-date" } },
  ]);
  const azure = createAzureRequester({ pat: fakePat, fetch });

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
  assert.ok(errors[1].retryAfterMs > 118_000 && errors[1].retryAfterMs <= 120_000);
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
      assert.doesNotMatch(JSON.stringify(error), /test-only-fake-pat|another-secret|source-secret|Authorization.*Basic|\u001b/);
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
      assert.doesNotMatch(error.message, /test-only-fake-pat|response-secret|Authorization.*Basic|\u001b/);
      assert.doesNotMatch(JSON.stringify(error), /test-only-fake-pat|response-secret|Authorization.*Basic|\u001b/);
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
    azure.request("https://example.invalid/failure?continuationToken=opaque-secret"),
    (error) => {
      assert.ok(error instanceof AzureRequestError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, 500);
      assert.doesNotMatch(error.message, /opaque-secret|test-only-fake-pat|response-secret|\u001b/);
      assert.doesNotMatch(JSON.stringify(error), /opaque-secret|test-only-fake-pat|response-secret|\u001b/);
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
    azure.request("https://example.invalid/invalid", { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }),
    /maxResponseBytes must be a positive safe integer/,
  );
  assert.deepEqual(calls, []);
});

test("authenticated-user lookup requests connection data and returns its identity id", async (t) => {
  const { fetch, calls } = createMockFetch(t, [
    { json: { authenticatedUser: { id: "identity/id +?#" } } },
  ]);
  const azure = createAzureRequester({ pat: fakePat, fetch });

  assert.equal(await getAuthenticatedUserId(azure, "org/name +&"), "identity/id +?#");
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
  const orgProject = "https://dev.azure.com/org%2Fname%20%2B%26/project%3F%23%20%2F";
  const repos = `${orgProject}/_apis/git/repositories/repo%2Fname%20%2B%3F%23`;

  assert.equal(orgProjectUrl(context), orgProject);
  assert.equal(reposBaseUrl(context), repos);
  assert.equal(pullRequestApiUrl(context, 42), `${repos}/pullRequests/42`);
  assert.equal(
    pullRequestApiUrl(context, 42, "/threads/7?api-version=7.1&includeDeleted=true"),
    `${repos}/pullRequests/42/threads/7?api-version=7.1&includeDeleted=true`,
  );
  assert.equal(
    pullRequestWebUrl(context, 42),
    `${orgProject}/_git/repo%2Fname%20%2B%3F%23/pullrequest/42`,
  );
});
