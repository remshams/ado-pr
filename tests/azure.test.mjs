import assert from "node:assert/strict";
import test from "node:test";

import {
  azureRequest,
  orgProjectUrl,
  pullRequestApiUrl,
  pullRequestWebUrl,
  reposBaseUrl,
} from "../azure.ts";
import { mockFetch } from "./test-helpers.mjs";

const fakePat = "test-only-fake-pat";
const expectedAuthorization = "Basic OnRlc3Qtb25seS1mYWtlLXBhdA==";

test(
  "azureRequest defaults to an authenticated GET without a body",
  { concurrency: false },
  async (t) => {
    const calls = mockFetch(t, [{ json: { value: ["fake-result"] } }]);

    const result = await azureRequest("https://example.invalid/default", fakePat);

    assert.deepEqual(result, { value: ["fake-result"] });
    assert.deepEqual(calls, [
      {
        url: "https://example.invalid/default",
        method: "GET",
        headers: { authorization: expectedAuthorization },
        body: null,
      },
    ]);
  },
);

test(
  "azureRequest sends mutations with a JSON body and Content-Type",
  { concurrency: false },
  async (t) => {
    const calls = mockFetch(t, [{ json: { id: 17, status: "fake-created" } }]);
    const body = {
      title: "Fake pull request",
      reviewers: [{ id: "fake-reviewer" }],
      draft: false,
    };

    const result = await azureRequest("https://example.invalid/mutation", fakePat, {
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
  },
);

test(
  "azureRequest reports the method, URL, status, status text, and response body on failure",
  { concurrency: false },
  async (t) => {
    const url = "https://example.invalid/failure?continuation=fake-token";
    mockFetch(t, [
      {
        status: 429,
        statusText: "Too Many Requests",
        body: '{"message":"fake rate limit detail"}',
      },
    ]);

    await assert.rejects(
      azureRequest(url, fakePat, {
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
  },
);

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
