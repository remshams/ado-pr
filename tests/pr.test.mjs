import assert from "node:assert/strict";
import test from "node:test";

import { createTempGitRepo, runPr } from "./test-helpers.mjs";

const origin = "https://dev.azure.com/acme/Test%20Project/_git/widgets";
const apiBase = "https://dev.azure.com/acme/Test%20Project/_apis/git/repositories/widgets";
const webBase = "https://dev.azure.com/acme/Test%20Project/_git/widgets/pullrequest";

function createRepo(t, branch = "feature/dispatch") {
  return createTempGitRepo(t, { origin, branch });
}

function request(call) {
  return { url: call.url, method: call.method, body: call.body };
}

function assertSucceeded(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
}

test("create dispatches directly without resolving an existing pull request", (t) => {
  const cwd = createRepo(t);
  const result = runPr(
    t,
    [
      "create",
      "--title",
      "Dispatch coverage",
      "--description",
      "Regression test",
      "--source",
      "feature/source",
      "--target",
      "main",
      "--draft",
    ],
    {
      cwd,
      responses: [
        {
          json: {
            pullRequestId: 101,
            title: "Dispatch coverage",
            sourceRefName: "refs/heads/feature/source",
          },
        },
      ],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullrequests?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({
        sourceRefName: "refs/heads/feature/source",
        targetRefName: "refs/heads/main",
        title: "Dispatch coverage",
        description: "Regression test",
        isDraft: true,
      }),
    },
  ]);
  assert.equal(result.stdout, `Created PR #101: Dispatch coverage\n${webBase}/101\n`);
});

test("list uses an explicit PR and prints the filtered response as JSON", (t) => {
  const cwd = createRepo(t);
  const threads = [
    {
      id: 12,
      status: "active",
      comments: [{ id: 1, content: "Review this", author: { displayName: "Ada" } }],
    },
  ];
  const result = runPr(t, ["list", "--pr", "42", "--json"], {
    cwd,
    responses: [{ json: { value: threads } }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(result.stdout, `${JSON.stringify(threads, null, 2)}\n`);
});

test("list auto-resolves the branch PR before fetching threads and handles an empty text result", (t) => {
  const cwd = createRepo(t, "feature/dispatch-order");
  const result = runPr(t, ["list"], {
    cwd,
    responses: [
      {
        json: {
          value: [
            {
              pullRequestId: 73,
              title: "Resolved from branch",
              sourceRefName: "refs/heads/feature/dispatch-order",
            },
          ],
        },
      },
      { json: { value: [] } },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url:
        `${apiBase}/pullrequests?` +
        "searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fdispatch-order&" +
        "searchCriteria.status=active&api-version=7.1",
      method: "GET",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/73/threads?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(result.stdout, "No matching comment threads on PR #73.\n");
});

test("list prints representative nonempty text output", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["list", "--pr", "42"], {
    cwd,
    responses: [
      {
        json: {
          value: [
            {
              id: 9,
              status: "active",
              comments: [
                {
                  id: 1,
                  content: " Looks good ",
                  author: { displayName: "Ada" },
                },
              ],
            },
          ],
        },
      },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(
    result.stdout,
    `Comment threads on PR #42:\n\n` +
      `### Thread 9 — General (not tied to a file/line) [active]\n` +
      `${webBase}/42?discussionId=9\n` +
      `- **Ada**: Looks good\n\n` +
      `---\n\nSummary:\n\n` +
      `| Thread | Location | Status | Link |\n` +
      `| --- | --- | --- | --- |\n` +
      `| 9 | General (not tied to a file/line) | active | [Open](${webBase}/42?discussionId=9) |\n`,
  );
});

test("comment dispatches a general top-level thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["comment", "--pr", "42", "--message", "General note"], {
    cwd,
    responses: [{ json: { id: 31, comments: [] } }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({
        comments: [{ content: "General note" }],
        status: "active",
      }),
    },
  ]);
  assert.equal(
    result.stdout,
    `Posted new comment thread 31 on PR #42.\n${webBase}/42?discussionId=31\n`,
  );
});

test("comment resolves and dispatches an anchored top-level thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(
    t,
    [
      "comment",
      "--pr",
      "42",
      "--message",
      "Anchored note",
      "--file",
      "src/app.ts",
      "--line",
      "3",
      "--end-line",
      "5",
    ],
    {
      cwd,
      responses: [
        { json: { value: [{ id: 2 }, { id: 7 }] } },
        {
          json: {
            changeEntries: [{ changeTrackingId: 88, item: { path: "/src/app.ts" } }],
          },
        },
        { json: { id: 32, comments: [] } },
      ],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/iterations?api-version=7.1`,
      method: "GET",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/42/iterations/7/changes?` + "api-version=7.1&$top=500&$skip=0",
      method: "GET",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({
        comments: [{ content: "Anchored note" }],
        status: "active",
        threadContext: {
          filePath: "/src/app.ts",
          rightFileStart: { line: 3, offset: 1 },
          rightFileEnd: { line: 5, offset: 1 },
        },
        pullRequestThreadContext: {
          iterationContext: {
            firstComparingIteration: 7,
            secondComparingIteration: 7,
          },
          changeTrackingId: 88,
        },
      }),
    },
  ]);
  assert.equal(
    result.stdout,
    `Posted new comment thread 32 on PR #42.\n${webBase}/42?discussionId=32\n`,
  );
});

test("reply dispatches to the selected thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["reply", "--pr", "42", "--thread", "8", "--message", "Reply text"], {
    cwd,
    responses: [{ json: { id: 2 } }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads/8/comments?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({ content: "Reply text" }),
    },
  ]);
  assert.equal(result.stdout, "Posted reply to thread 8 on PR #42.\n");
});

test("resolve dispatches a fixed status update to the selected thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["resolve", "--pr", "42", "--thread", "9"], {
    cwd,
    responses: [{ json: { id: 9, status: "fixed" } }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
      method: "PATCH",
      body: JSON.stringify({ status: "fixed" }),
    },
  ]);
  assert.equal(result.stdout, "Marked thread 9 on PR #42 as resolved.\n");
});

test("batch reads stdin and dispatches operations in order with per-operation PR overrides", (t) => {
  const cwd = createRepo(t);
  const operations = [
    { action: "comment", message: "Batch note" },
    { action: "reply", pr: 77, thread: 8, message: "Batch reply" },
    { action: "resolve", thread: 9 },
  ];
  const result = runPr(t, ["batch", "--pr", "42"], {
    cwd,
    stdin: JSON.stringify(operations),
    responses: [
      { json: { id: 51, comments: [] } },
      { json: { id: 2 } },
      { json: { id: 9, status: "fixed" } },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({
        comments: [{ content: "Batch note" }],
        status: "active",
      }),
    },
    {
      url: `${apiBase}/pullRequests/77/threads/8/comments?api-version=7.1`,
      method: "POST",
      body: JSON.stringify({ content: "Batch reply" }),
    },
    {
      url: `${apiBase}/pullRequests/42/threads/9?api-version=7.1`,
      method: "PATCH",
      body: JSON.stringify({ status: "fixed" }),
    },
  ]);
  assert.equal(
    result.stdout,
    `[1/3] comment: posted new comment thread 51 on PR #42 (${webBase}/42?discussionId=51)\n` +
      `[2/3] reply: posted reply to thread 8 on PR #77\n` +
      `[3/3] resolve: marked thread 9 on PR #42 as resolved\n`,
  );
});

test("a top-level Azure error is printed and exits nonzero", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["list", "--pr", "42"], {
    cwd,
    responses: [
      {
        status: 503,
        statusText: "Service Unavailable",
        body: "Azure is temporarily unavailable",
      },
    ],
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(
    result.stderr,
    `Azure DevOps API request (GET ${apiBase}/pullRequests/42/threads?api-version=7.1) failed: ` +
      `503 Service Unavailable\nAzure is temporarily unavailable\n`,
  );
});
