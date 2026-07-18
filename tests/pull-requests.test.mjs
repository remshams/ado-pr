import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createPullRequest, resolvePullRequestId } from "../pull-requests.ts";
import { createTempGitRepo, isolateGitEnvironment, mockFetch } from "./test-helpers.mjs";

const ctx = {
  organization: "test-org",
  project: "test-project",
  repository: "test-repository",
};
const pat = "test-only-fake-pat";
const repositoryUrl =
  "https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository";
const pullRequestsUrl = `${repositoryUrl}/pullrequests?api-version=7.1`;

async function withWorkingDirectory(path, callback) {
  const previousCwd = process.cwd();
  process.chdir(path);
  try {
    return await callback();
  } finally {
    process.chdir(previousCwd);
  }
}

function pullRequest(overrides = {}) {
  return {
    pullRequestId: 42,
    title: "Test pull request",
    sourceRefName: "refs/heads/feature/test",
    ...overrides,
  };
}

describe("pull request resolution and creation", { concurrency: false }, () => {
  test("an explicit pull request ID short-circuits without inspecting Git or fetching", async (t) => {
    const calls = mockFetch(t);

    assert.equal(await resolvePullRequestId(ctx, 123, pat), 123);
    assert.deepEqual(calls, []);
  });

  test("auto-detects the current branch and URL-encodes its full source ref", async (t) => {
    isolateGitEnvironment(t);
    const repo = createTempGitRepo(t, { branch: "feature/a+b" });
    const calls = mockFetch(t, [{ json: { value: [pullRequest({ pullRequestId: 73 })] } }]);

    await withWorkingDirectory(repo, async () => {
      assert.equal(await resolvePullRequestId(ctx, undefined, pat), 73);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(
      calls[0].url,
      `${repositoryUrl}/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fa%2Bb&searchCriteria.status=active&api-version=7.1`,
    );
    assert.equal(calls[0].body, null);
  });

  test("ignores hostile ambient Git redirection when auto-detecting the branch", async (t) => {
    const hostileEnvironment = {
      GIT_DIR: "/hostile/not-a-repository",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://dev.azure.com/",
    };
    const previousEnvironment = new Map(
      Object.keys(hostileEnvironment).map((name) => [name, process.env[name]]),
    );

    try {
      Object.assign(process.env, hostileEnvironment);
      await t.test(
        "with isolated production Git environment",
        { concurrency: false },
        async (t) => {
          isolateGitEnvironment(t);
          const repo = createTempGitRepo(t, { branch: "feature/isolated" });
          const calls = mockFetch(t, [{ json: { value: [pullRequest({ pullRequestId: 74 })] } }]);

          await withWorkingDirectory(repo, async () => {
            assert.equal(await resolvePullRequestId(ctx, undefined, pat), 74);
          });

          assert.equal(calls.length, 1);
          assert.match(
            calls[0].url,
            /searchCriteria\.sourceRefName=refs%2Fheads%2Ffeature%2Fisolated/,
          );
        },
      );
    } finally {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("reports when the current branch has no active pull request", async (t) => {
    isolateGitEnvironment(t);
    const repo = createTempGitRepo(t, { branch: "feature/missing" });
    const calls = mockFetch(t, [{ json: { value: [] } }]);

    await withWorkingDirectory(repo, async () => {
      await assert.rejects(resolvePullRequestId(ctx, undefined, pat), {
        message:
          'No active pull request found for branch "feature/missing" in test-org/test-project/test-repository.',
      });
    });

    assert.equal(calls.length, 1);
  });

  test("reports every candidate when the current branch has multiple active pull requests", async (t) => {
    isolateGitEnvironment(t);
    const repo = createTempGitRepo(t, { branch: "feature/ambiguous" });
    const calls = mockFetch(t, [
      {
        json: {
          value: [
            pullRequest({ pullRequestId: 10, title: "First candidate" }),
            pullRequest({ pullRequestId: 20, title: "Second candidate" }),
          ],
        },
      },
    ]);

    await withWorkingDirectory(repo, async () => {
      await assert.rejects(resolvePullRequestId(ctx, undefined, pat), {
        message:
          'Multiple active pull requests found for branch "feature/ambiguous"; pass --pr <id> to disambiguate:\n' +
          "  #10: First candidate\n" +
          "  #20: Second candidate",
      });
    });

    assert.equal(calls.length, 1);
  });

  test("creates from explicit source and target branches while normalizing only plain refs", async (t) => {
    const created = pullRequest({ pullRequestId: 88 });
    const calls = mockFetch(t, [{ json: created }]);

    assert.deepEqual(
      await createPullRequest(ctx, pat, {
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
    isolateGitEnvironment(t);
    const repo = createTempGitRepo(t, { branch: "feature/from-git" });
    const created = pullRequest({ pullRequestId: 91 });
    const calls = mockFetch(t, [{ json: { defaultBranch: "refs/heads/main" } }, { json: created }]);

    await withWorkingDirectory(repo, async () => {
      assert.deepEqual(
        await createPullRequest(ctx, pat, {
          title: "Detected branches",
          draft: false,
        }),
        created,
      );
    });

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
    const calls = mockFetch(t, [{ json: {} }]);

    await assert.rejects(
      createPullRequest(ctx, pat, {
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
    const calls = mockFetch(t, [{ json: pullRequest() }]);

    await createPullRequest(ctx, pat, {
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
