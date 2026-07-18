import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createAzureRequester } from "../azure.ts";
import { createPullRequestService } from "../pull-requests.ts";
import { createMockFetch } from "./test-helpers.mjs";

const ctx = {
  organization: "test-org",
  project: "test-project",
  repository: "test-repository",
};
const pat = "test-only-fake-pat";
const repositoryUrl =
  "https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository";
const pullRequestsUrl = `${repositoryUrl}/pullrequests?api-version=7.1`;

function pullRequest(overrides = {}) {
  return {
    pullRequestId: 42,
    title: "Test pull request",
    sourceRefName: "refs/heads/feature/test",
    ...overrides,
  };
}

function createService(
  t,
  responses = [],
  getCurrentBranch = async () => assert.fail("Unexpected current branch lookup"),
) {
  const { fetch, calls } = createMockFetch(t, responses);
  const azure = createAzureRequester({ pat, fetch });
  const service = createPullRequestService({ azure, ctx, getCurrentBranch });
  return { service, calls };
}

describe("pull request resolution and creation", () => {
  test("an explicit pull request ID short-circuits without looking up the branch or fetching", async (t) => {
    const { service, calls } = createService(t);

    assert.equal(await service.resolveId(123), 123);
    assert.deepEqual(calls, []);
  });

  test("uses the current branch and URL-encodes its full source ref", async (t) => {
    const { service, calls } = createService(
      t,
      [{ json: { value: [pullRequest({ pullRequestId: 73 })] } }],
      async () => "feature/a+b",
    );

    assert.equal(await service.resolveId(undefined), 73);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(
      calls[0].url,
      `${repositoryUrl}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fa%2Bb&searchCriteria.status=active&api-version=7.1`,
    );
    assert.equal(calls[0].body, null);
  });

  test("reports when the current branch has no active pull request", async (t) => {
    const { service, calls } = createService(
      t,
      [{ json: { value: [] } }],
      async () => "feature/missing",
    );

    await assert.rejects(service.resolveId(undefined), {
      message:
        'No active pull request found for branch "feature/missing" in test-org/test-project/test-repository.',
    });

    assert.equal(calls.length, 1);
  });

  test("reports every candidate when the current branch has multiple active pull requests", async (t) => {
    const { service, calls } = createService(
      t,
      [
        {
          json: {
            value: [
              pullRequest({ pullRequestId: 10, title: "First candidate" }),
              pullRequest({ pullRequestId: 20, title: "Second candidate" }),
            ],
          },
        },
      ],
      async () => "feature/ambiguous",
    );

    await assert.rejects(service.resolveId(undefined), {
      message:
        'Multiple active pull requests found for branch "feature/ambiguous"; pass --pr <id> to disambiguate:\n' +
        "  #10: First candidate\n" +
        "  #20: Second candidate",
    });

    assert.equal(calls.length, 1);
  });

  test("creates from explicit source and target branches while normalizing only plain refs", async (t) => {
    const created = pullRequest({ pullRequestId: 88 });
    const { service, calls } = createService(t, [{ json: created }]);

    assert.deepEqual(
      await service.create({
        title: "Release fix",
        description: "Ready to merge",
        sourceBranch: "feature/release-fix",
        targetBranch: "refs/heads/release/2026",
        draft: false,
      }),
      created,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, pullRequestsUrl);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), {
      sourceRefName: "refs/heads/feature/release-fix",
      targetRefName: "refs/heads/release/2026",
      title: "Release fix",
      description: "Ready to merge",
      isDraft: false,
    });
  });

  test("resolves the current source and default target before posting the creation request", async (t) => {
    const created = pullRequest({ pullRequestId: 91 });
    const { service, calls } = createService(
      t,
      [{ json: { defaultBranch: "refs/heads/main" } }, { json: created }],
      async () => "feature/from-git",
    );

    assert.deepEqual(
      await service.create({
        title: "Detected branches",
        draft: false,
      }),
      created,
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ method, url }) => ({ method, url })),
      [
        { method: "GET", url: `${repositoryUrl}?api-version=7.1` },
        { method: "POST", url: pullRequestsUrl },
      ],
    );
    assert.deepEqual(JSON.parse(calls[1].body), {
      sourceRefName: "refs/heads/feature/from-git",
      targetRefName: "refs/heads/main",
      title: "Detected branches",
      description: "",
      isDraft: false,
    });
  });

  test("does not post when the repository has no default branch", async (t) => {
    const { service, calls } = createService(t, [{ json: {} }]);

    await assert.rejects(
      service.create({
        title: "Cannot target",
        sourceBranch: "feature/known-source",
        draft: false,
      }),
      {
        message:
          "Could not determine the default branch for test-org/test-project/test-repository; pass --target explicitly.",
      },
    );

    assert.deepEqual(
      calls.map(({ method, url }) => ({ method, url })),
      [{ method: "GET", url: `${repositoryUrl}?api-version=7.1` }],
    );
  });

  test("sends an empty description and the requested draft state", async (t) => {
    const { service, calls } = createService(t, [{ json: pullRequest() }]);

    await service.create({
      title: "Draft without description",
      sourceBranch: "refs/heads/feature/draft",
      targetBranch: "main",
      draft: true,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].body), {
      sourceRefName: "refs/heads/feature/draft",
      targetRefName: "refs/heads/main",
      title: "Draft without description",
      description: "",
      isDraft: true,
    });
  });
});
