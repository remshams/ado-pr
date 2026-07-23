import assert from "node:assert/strict";
import test from "node:test";

import {
  createAzureRequester,
  getAuthenticatedUserId,
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
  const { fetch } = createMockFetch(t, [{ body: "" }, { status: 204 }]);
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
});

test("Azure requester reports the method, URL, status, status text, and response body on failure", async (t) => {
  const url = "https://example.invalid/failure?continuation=fake-token";
  const { fetch } = createMockFetch(t, [
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
      assert.equal(
        error?.message,
        `Azure DevOps API request (POST ${url}) failed: 429 Too Many Requests\n{"message":"fake rate limit detail"}`,
      );
      return true;
    },
  );
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
