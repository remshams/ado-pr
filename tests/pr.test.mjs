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

function semanticRequest(call) {
  return {
    url: call.url,
    method: call.method,
    body: call.body === null ? null : JSON.parse(call.body),
  };
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
      "pr",
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

test("show fetches an explicit PR and prints human-readable details", (t) => {
  const cwd = createRepo(t);
  const pr = {
    pullRequestId: 42,
    title: "Account validation",
    description: "Validate accounts before saving.",
    status: "active",
    isDraft: true,
    sourceRefName: "refs/heads/feature/account-validation",
    targetRefName: "refs/heads/main",
  };
  const result = runPr(t, ["pr", "show", "--pr", "42"], {
    cwd,
    responses: [{ json: pr }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(
    result.stdout,
    "PR #42: Account validation\n" +
      "Status: active\n" +
      "Draft: yes\n" +
      "Source: feature/account-validation\n" +
      "Target: main\n" +
      `URL: ${webBase}/42\n` +
      "Description:\n" +
      "Validate accounts before saving.\n",
  );
});

test("show prints an explicit PR as JSON", (t) => {
  const cwd = createRepo(t);
  const pr = {
    pullRequestId: 42,
    title: "JSON details",
    description: "Machine readable",
    status: "active",
    isDraft: false,
    sourceRefName: "refs/heads/feature/json",
    targetRefName: "refs/heads/main",
  };
  const result = runPr(t, ["pr", "show", "--pr", "42", "--json"], {
    cwd,
    responses: [{ json: pr }],
  });

  assertSucceeded(result);
  assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("show hydrates the active PR found for the current branch", (t) => {
  const cwd = createRepo(t, "feature/branch-details");
  const candidate = {
    pullRequestId: 73,
    title: "Branch details",
    description: "Truncated collection description",
    sourceRefName: "refs/heads/feature/branch-details",
  };
  const pr = {
    ...candidate,
    description: "Found from the current branch with the full description.",
    status: "active",
    isDraft: false,
    targetRefName: "refs/heads/main",
  };
  const result = runPr(t, ["pr", "show", "--json"], {
    cwd,
    responses: [{ json: { value: [candidate] } }, { json: pr }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url:
        `${apiBase}/pullrequests?` +
        "searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fbranch-details&" +
        "searchCriteria.status=active&api-version=7.1",
      method: "GET",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/73?api-version=7.1`,
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(result.stdout, `${JSON.stringify(pr, null, 2)}\n`);
});

test("pr edit replaces the description for an explicit PR without fetching it first", (t) => {
  const cwd = createRepo(t);
  const result = runPr(
    t,
    ["pr", "edit", "--pr", "42", "--description", "Updated from the command line"],
    {
      cwd,
      responses: [
        {
          json: {
            pullRequestId: 42,
            title: "Updated PR",
            description: "Updated from the command line",
            sourceRefName: "refs/heads/feature/dispatch",
          },
        },
      ],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42?api-version=7.1`,
      method: "PATCH",
      body: { description: "Updated from the command line" },
    },
  ]);
  assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit marks an explicit PR as draft without fetching it first", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["pr", "edit", "--pr", "42", "--draft"], {
    cwd,
    responses: [
      {
        json: {
          pullRequestId: 42,
          title: "Draft PR",
          isDraft: true,
          sourceRefName: "refs/heads/feature/dispatch",
        },
      },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42?api-version=7.1`,
      method: "PATCH",
      body: { isDraft: true },
    },
  ]);
  assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit clears draft state with --no-draft", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["pr", "edit", "--pr", "42", "--no-draft"], {
    cwd,
    responses: [
      {
        json: {
          pullRequestId: 42,
          title: "Ready PR",
          isDraft: false,
          sourceRefName: "refs/heads/feature/dispatch",
        },
      },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42?api-version=7.1`,
      method: "PATCH",
      body: { isDraft: false },
    },
  ]);
  assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit combines description and draft changes in one request", (t) => {
  const cwd = createRepo(t);
  const result = runPr(
    t,
    ["pr", "edit", "--pr", "42", "--description", "Work in progress", "--draft"],
    {
      cwd,
      responses: [
        {
          json: {
            pullRequestId: 42,
            title: "Combined update",
            description: "Work in progress",
            isDraft: true,
            sourceRefName: "refs/heads/feature/dispatch",
          },
        },
      ],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42?api-version=7.1`,
      method: "PATCH",
      body: { description: "Work in progress", isDraft: true },
    },
  ]);
  assert.equal(result.stdout, `Updated PR #42.\n${webBase}/42\n`);
});

test("pr edit resolves the branch PR and can clear its description", (t) => {
  const cwd = createRepo(t, "feature/clear-description");
  const result = runPr(t, ["pr", "edit", "--description", ""], {
    cwd,
    responses: [
      {
        json: {
          value: [
            {
              pullRequestId: 73,
              title: "Clear description",
              sourceRefName: "refs/heads/feature/clear-description",
            },
          ],
        },
      },
      {
        json: {
          pullRequestId: 73,
          title: "Clear description",
          description: "",
          sourceRefName: "refs/heads/feature/clear-description",
        },
      },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url:
        `${apiBase}/pullrequests?` +
        "searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fclear-description&" +
        "searchCriteria.status=active&api-version=7.1",
      method: "GET",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/73?api-version=7.1`,
      method: "PATCH",
      body: { description: "" },
    },
  ]);
  assert.equal(result.stdout, `Updated PR #73.\n${webBase}/73\n`);
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
  const result = runPr(t, ["comment", "list", "--pr", "42", "--json"], {
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

test("list forwards exclude flags, fetches connection data after threads, and prints only threads surviving both filters", (t) => {
  const cwd = createRepo(t);
  const currentUser = { id: "me", displayName: "Current User" };
  const reviewer = { id: "reviewer", displayName: "Reviewer" };
  const survivor = {
    id: 13,
    status: "active",
    comments: [{ id: 3, content: "Keep this", author: reviewer }],
  };
  const result = runPr(
    t,
    ["comment", "list", "--pr", "42", "--json", "--exclude-own", "--exclude-resolved"],
    {
      cwd,
      responses: [
        {
          json: {
            value: [
              {
                id: 11,
                status: "active",
                comments: [{ id: 1, content: "My note", author: currentUser }],
              },
              {
                id: 12,
                status: "fixed",
                comments: [{ id: 2, content: "Already resolved", author: reviewer }],
              },
              survivor,
            ],
          },
        },
        { json: { authenticatedUser: { id: currentUser.id } } },
      ],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "GET",
      body: null,
    },
    {
      url:
        "https://dev.azure.com/acme/_apis/connectionData?" +
        "connectOptions=1&lastChangeId=-1&lastChangeId64=-1&api-version=7.1-preview.1",
      method: "GET",
      body: null,
    },
  ]);
  assert.equal(result.stdout, `${JSON.stringify([survivor], null, 2)}\n`);
});

test("list auto-resolves the branch PR before fetching threads and handles an empty text result", (t) => {
  const cwd = createRepo(t, "feature/dispatch-order");
  const result = runPr(t, ["comment", "list"], {
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
  const result = runPr(t, ["comment", "list", "--pr", "42"], {
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
      `- **Ada** (comment 1): Looks good\n\n` +
      `---\n\nSummary:\n\n` +
      `| Thread | Location | Status | Link |\n` +
      `| --- | --- | --- | --- |\n` +
      `| 9 | General (not tied to a file/line) | active | [Open](${webBase}/42?discussionId=9) |\n`,
  );
});

test("comment dispatches a general top-level thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["comment", "create", "--pr", "42", "--message", "General note"], {
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
      "create",
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
  const result = runPr(
    t,
    ["comment", "reply", "--pr", "42", "--thread", "8", "--message", "Reply text"],
    {
      cwd,
      responses: [{ json: { id: 2 } }],
    },
  );

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

test("edit dispatches a comment content update and prints success", (t) => {
  const cwd = createRepo(t);
  const result = runPr(
    t,
    [
      "comment",
      "edit",
      "--pr",
      "42",
      "--thread",
      "8",
      "--comment",
      "3",
      "--message",
      "Revised text",
    ],
    {
      cwd,
      responses: [{ json: { id: 3, content: "Revised text" } }],
    },
  );

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
      method: "PATCH",
      body: { content: "Revised text" },
    },
  ]);
  assert.equal(result.stdout, "Edited comment 3 in thread 8 on PR #42.\n");
});

test("delete dispatches a bodyless comment deletion and prints success", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["comment", "delete", "--pr", "42", "--thread", "8", "--comment", "3"], {
    cwd,
    responses: [{ body: "" }],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(request), [
    {
      url: `${apiBase}/pullRequests/42/threads/8/comments/3?api-version=7.1`,
      method: "DELETE",
      body: null,
    },
  ]);
  assert.equal(result.stdout, "Deleted comment 3 from thread 8 on PR #42.\n");
});

test("resolve dispatches a fixed status update to the selected thread", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["comment", "resolve", "--pr", "42", "--thread", "9"], {
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
    { command: "comment.create", message: "Batch note" },
    { command: "comment.reply", pr: 77, thread: 8, message: "Batch reply" },
    { command: "comment.edit", thread: 9, comment: 3, message: "Batch edit" },
    { command: "comment.delete", thread: 10, comment: 4 },
    { command: "comment.resolve", thread: 11 },
  ];
  const result = runPr(t, ["comment", "batch", "--pr", "42"], {
    cwd,
    stdin: JSON.stringify(operations),
    responses: [
      { json: { id: 51, comments: [] } },
      { json: { id: 2 } },
      { json: { id: 3, content: "Batch edit" } },
      { body: "" },
      { json: { id: 11, status: "fixed" } },
    ],
  });

  assertSucceeded(result);
  assert.deepEqual(result.calls.map(semanticRequest), [
    {
      url: `${apiBase}/pullRequests/42/threads?api-version=7.1`,
      method: "POST",
      body: {
        comments: [{ content: "Batch note" }],
        status: "active",
      },
    },
    {
      url: `${apiBase}/pullRequests/77/threads/8/comments?api-version=7.1`,
      method: "POST",
      body: { content: "Batch reply" },
    },
    {
      url: `${apiBase}/pullRequests/42/threads/9/comments/3?api-version=7.1`,
      method: "PATCH",
      body: { content: "Batch edit" },
    },
    {
      url: `${apiBase}/pullRequests/42/threads/10/comments/4?api-version=7.1`,
      method: "DELETE",
      body: null,
    },
    {
      url: `${apiBase}/pullRequests/42/threads/11?api-version=7.1`,
      method: "PATCH",
      body: { status: "fixed" },
    },
  ]);
  assert.equal(
    result.stdout,
    `[1/5] comment.create: posted new comment thread 51 on PR #42 (${webBase}/42?discussionId=51)\n` +
      `[2/5] comment.reply: posted reply to thread 8 on PR #77\n` +
      `[3/5] comment.edit: edited comment 3 in thread 9 on PR #42\n` +
      `[4/5] comment.delete: deleted comment 4 from thread 10 on PR #42\n` +
      `[5/5] comment.resolve: marked thread 11 on PR #42 as resolved\n`,
  );
});

test("a top-level Azure error is printed and exits nonzero", (t) => {
  const cwd = createRepo(t);
  const result = runPr(t, ["comment", "list", "--pr", "42"], {
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
