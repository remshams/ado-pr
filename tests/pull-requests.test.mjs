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

describe("pull request listing, resolution, creation, and updates", () => {
  test("lists the current identity's active repository pull requests in response order", async (t) => {
    const expected = [
      pullRequest({ pullRequestId: 91, title: "Second by ID" }),
      pullRequest({ pullRequestId: 12, title: "First by ID" }),
    ];
    const { service, calls } = createService(t, [
      { json: { authenticatedUser: { id: "creator/id +?#" } } },
      { json: { count: expected.length, value: expected } },
    ]);

    assert.deepEqual(await service.list(), expected);
    assert.deepEqual(
      calls.map(({ method, url, body }) => ({ method, url, body })),
      [
        {
          method: "GET",
          url:
            "https://dev.azure.com/test-org/_apis/connectionData?" +
            "connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
          body: null,
        },
        {
          method: "GET",
          url:
            `${repositoryUrl}/pullrequests?` +
            "searchCriteria.creatorId=creator%2Fid%20%2B%3F%23&" +
            "searchCriteria.status=active&api-version=7.1",
          body: null,
        },
      ],
    );
  });

  test("an explicit pull request ID short-circuits without looking up the branch or fetching", async (t) => {
    const { service, calls } = createService(t);

    assert.equal(await service.resolveId(123), 123);
    assert.deepEqual(calls, []);
  });

  test("fetches full pull request details for an explicit ID", async (t) => {
    const expected = pullRequest({
      description: "Review the account validation changes.",
      status: "active",
      isDraft: true,
      targetRefName: "refs/heads/main",
    });
    const { service, calls } = createService(t, [{ json: expected }]);

    assert.deepEqual(await service.get(42), expected);
    assert.deepEqual(
      calls.map(({ method, url, body }) => ({ method, url, body })),
      [
        {
          method: "GET",
          url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
          body: null,
        },
      ],
    );
  });

  test("resolves an explicit ID to full pull request details", async (t) => {
    const expected = pullRequest({ pullRequestId: 123, description: "Explicit PR" });
    const { service, calls } = createService(t, [{ json: expected }]);

    assert.deepEqual(await service.resolve(123), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${repositoryUrl}/pullRequests/123?api-version=7.1`);
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

  test("hydrates branch search results so the full description is returned", async (t) => {
    const candidate = pullRequest({
      pullRequestId: 74,
      description: "Truncated collection description",
    });
    const expected = pullRequest({
      pullRequestId: 74,
      description: "Full description ".repeat(30),
      status: "active",
      isDraft: false,
      targetRefName: "refs/heads/main",
    });
    const { service, calls } = createService(
      t,
      [{ json: { value: [candidate] } }, { json: expected }],
      async () => "feature/show-details",
    );

    assert.deepEqual(await service.resolve(undefined), expected);
    assert.deepEqual(
      calls.map(({ method, url }) => ({ method, url })),
      [
        {
          method: "GET",
          url: `${repositoryUrl}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fshow-details&searchCriteria.status=active&api-version=7.1`,
        },
        {
          method: "GET",
          url: `${repositoryUrl}/pullRequests/74?api-version=7.1`,
        },
      ],
    );
  });

  test("formats human-readable pull request details and strips branch ref prefixes", (t) => {
    const { service } = createService(t);

    assert.equal(
      service.format(
        pullRequest({
          description: "Line one\n\nLine two",
          status: "active",
          isDraft: true,
          targetRefName: "refs/heads/main",
        }),
      ),
      "PR #42: Test pull request\n" +
        "Status: active\n" +
        "Draft: yes\n" +
        "Source: feature/test\n" +
        "Target: main\n" +
        "URL: https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42\n" +
        "Description:\n" +
        "Line one\n\nLine two",
    );
  });

  test("formats missing metadata and an empty description explicitly", (t) => {
    const { service } = createService(t);

    assert.equal(
      service.format(pullRequest({ description: "" })),
      "PR #42: Test pull request\n" +
        "Status: unknown\n" +
        "Draft: unknown\n" +
        "Source: feature/test\n" +
        "Target: unknown\n" +
        "URL: https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42\n" +
        "Description:\n" +
        "(empty)",
    );
  });

  test("formats concise list items with refs, links, and draft state", (t) => {
    const { service } = createService(t);

    assert.equal(
      service.formatListItem(
        pullRequest({
          pullRequestId: 17,
          title: "Draft item",
          isDraft: true,
          sourceRefName: "refs/heads/feature/draft-item",
          targetRefName: "refs/heads/main",
        }),
      ),
      "- PR #17: Draft item [draft]\n" +
        "  feature/draft-item -> main\n" +
        "  https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/17",
    );
    assert.equal(
      service.formatListItem(pullRequest({ targetRefName: undefined })),
      "- PR #42: Test pull request\n" +
        "  feature/test -> unknown\n" +
        "  https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
    );
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

  test("updates only the pull request description", async (t) => {
    const updated = pullRequest({ description: "Updated description" });
    const { service, calls } = createService(t, [{ json: updated }]);

    assert.deepEqual(await service.update(42, { description: "Updated description" }), updated);
    assert.deepEqual(
      calls.map(({ method, url, body }) => ({ method, url, body: JSON.parse(body) })),
      [
        {
          method: "PATCH",
          url: `${repositoryUrl}/pullRequests/42?api-version=7.1`,
          body: { description: "Updated description" },
        },
      ],
    );
  });

  test("sends an explicitly empty description so an existing description can be cleared", async (t) => {
    const updated = pullRequest({ description: "" });
    const { service, calls } = createService(t, [{ json: updated }]);

    assert.deepEqual(await service.update(42, { description: "" }), updated);
    assert.deepEqual(JSON.parse(calls[0].body), { description: "" });
  });

  test("marks a pull request as draft without sending description", async (t) => {
    const updated = pullRequest({ isDraft: true });
    const { service, calls } = createService(t, [{ json: updated }]);

    assert.deepEqual(await service.update(42, { draft: true }), updated);
    assert.deepEqual(JSON.parse(calls[0].body), { isDraft: true });
  });

  test("updates description and draft state in one request", async (t) => {
    const updated = pullRequest({ description: "Work in progress", isDraft: true });
    const { service, calls } = createService(t, [{ json: updated }]);

    assert.deepEqual(
      await service.update(42, { description: "Work in progress", draft: true }),
      updated,
    );
    assert.deepEqual(JSON.parse(calls[0].body), {
      description: "Work in progress",
      isDraft: true,
    });
  });

  test("rejects an update without fields before making a request", async (t) => {
    const { service, calls } = createService(t);

    await assert.rejects(service.update(42, {}), {
      message: "At least one pull request field is required for an update.",
    });
    assert.deepEqual(calls, []);
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
