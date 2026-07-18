import assert from "node:assert/strict";
import test from "node:test";

import { createFileAnchorCache } from "../file-anchors.ts";
import {
  deleteComment,
  editComment,
  formatSummaryTable,
  formatThread,
  getFilteredThreads,
  postComment,
  postReply,
  resolveThread,
  threadWebUrl,
} from "../threads.ts";
import { mockFetch } from "./test-helpers.mjs";

const ctx = {
  organization: "my org",
  project: "Project/A",
  repository: "repo #1",
};
const prId = 42;
const pat = "test-pat";
const apiBase =
  "https://dev.azure.com/my%20org/Project%2FA/_apis/git/repositories/repo%20%231/pullRequests/42";
const webBase = "https://dev.azure.com/my%20org/Project%2FA/_git/repo%20%231/pullrequest/42";

function textComment(id, content, author = { id: `user-${id}`, displayName: `User ${id}` }) {
  return { id, content, author };
}

function thread(id, overrides = {}) {
  return {
    id,
    status: "active",
    comments: [textComment(id, `comment ${id}`)],
    ...overrides,
  };
}

function requestShapes(calls) {
  return calls.map(({ url, method, body }) => ({ url, method, body }));
}

test.describe("threads", { concurrency: false }, () => {
  test("getFilteredThreads removes deleted threads/comments and threads without real comments", async (t) => {
    const relevant = thread(5, {
      comments: [
        { id: 50, content: "build event", commentType: "system" },
        textComment(51, "  useful review  "),
      ],
    });
    const calls = mockFetch(t, [
      {
        json: {
          value: [
            thread(1, { isDeleted: true }),
            thread(2, { comments: [] }),
            thread(3, { comments: [{ id: 30, content: "system", commentType: "system" }] }),
            thread(4, { comments: [textComment(40, "   ")] }),
            thread(6, { comments: [{ ...textComment(60, "deleted"), isDeleted: true }] }),
            relevant,
          ],
        },
      },
    ]);

    const result = await getFilteredThreads(ctx, prId, pat, {
      excludeResolved: false,
      excludeOwn: false,
    });

    assert.deepEqual(result, [relevant]);
    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads?api-version=7.1`,
        method: "GET",
        body: null,
      },
    ]);
  });

  test("getFilteredThreads keeps only active, pending, and status-less threads when excluding resolved", async (t) => {
    const active = thread(1);
    const pending = thread(2, { status: "pending" });
    const statusLess = thread(3);
    delete statusLess.status;
    const calls = mockFetch(t, [
      {
        json: {
          value: [
            active,
            pending,
            statusLess,
            thread(4, { status: "fixed" }),
            thread(5, { status: "closed" }),
          ],
        },
      },
    ]);

    const result = await getFilteredThreads(ctx, prId, pat, {
      excludeResolved: true,
      excludeOwn: false,
    });

    assert.deepEqual(result, [active, pending, statusLess]);
    assert.equal(calls.length, 1, "identity lookup stays lazy when --exclude-own is disabled");
  });

  test("getFilteredThreads excludes own-only threads and requests identity after threads", async (t) => {
    const ownAuthor = { id: "me", displayName: "Current User" };
    const otherAuthor = { id: "reviewer", displayName: "Reviewer" };
    const fromReviewer = thread(2, {
      comments: [textComment(20, "mine", ownAuthor), textComment(21, "review", otherAuthor)],
    });
    const fromUnknownAuthor = thread(4, {
      comments: [{ id: 40, content: "anonymous review" }],
    });
    const calls = mockFetch(t, [
      {
        json: {
          value: [
            thread(1, { comments: [textComment(10, "mine", ownAuthor)] }),
            fromReviewer,
            thread(3, {
              comments: [
                textComment(30, "mine", ownAuthor),
                {
                  id: 31,
                  content: "reviewer changed status",
                  commentType: "system",
                  author: otherAuthor,
                },
              ],
            }),
            fromUnknownAuthor,
          ],
        },
      },
      { json: { id: "me" } },
    ]);

    const result = await getFilteredThreads(ctx, prId, pat, {
      excludeResolved: false,
      excludeOwn: true,
    });

    assert.deepEqual(result, [fromReviewer, fromUnknownAuthor]);
    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads?api-version=7.1`,
        method: "GET",
        body: null,
      },
      {
        url: "https://vssps.dev.azure.com/my%20org/_apis/profile/profiles/me?api-version=7.1",
        method: "GET",
        body: null,
      },
    ]);
  });

  test("getFilteredThreads combines resolved and own-thread exclusions in request order", async (t) => {
    const ownAuthor = { id: "me", displayName: "Current User" };
    const otherAuthor = { id: "reviewer", displayName: "Reviewer" };
    const activeOther = thread(3, {
      comments: [textComment(30, "active review", otherAuthor)],
    });
    const calls = mockFetch(t, [
      {
        json: {
          value: [
            thread(1, { comments: [textComment(10, "mine", ownAuthor)] }),
            thread(2, {
              status: "fixed",
              comments: [textComment(20, "resolved review", otherAuthor)],
            }),
            activeOther,
          ],
        },
      },
      { json: { id: "me" } },
    ]);

    const result = await getFilteredThreads(ctx, prId, pat, {
      excludeResolved: true,
      excludeOwn: true,
    });

    assert.deepEqual(result, [activeOther]);
    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads?api-version=7.1`,
        method: "GET",
        body: null,
      },
      {
        url: "https://vssps.dev.azure.com/my%20org/_apis/profile/profiles/me?api-version=7.1",
        method: "GET",
        body: null,
      },
    ]);
  });

  test("formatThread exactly formats general threads and unknown authors", () => {
    const value = thread(7, {
      status: undefined,
      comments: [
        { id: 70, content: "  Please explain this.  " },
        { id: 71, content: "ignored", commentType: "system" },
        textComment(72, "   "),
      ],
    });

    assert.equal(
      formatThread(value, ctx, prId),
      `### Thread 7 — General (not tied to a file/line) [active]\n${webBase}?discussionId=7\n- **unknown** (comment 70): Please explain this.`,
    );
  });

  test("formatThread exactly formats single-line, range, and right-side-preferred locations", () => {
    const single = thread(8, {
      status: "pending",
      threadContext: {
        filePath: "/src/single.ts",
        leftFileStart: { line: 5 },
        leftFileEnd: { line: 5 },
      },
    });
    const range = thread(9, {
      status: "fixed",
      threadContext: {
        filePath: "/src/range.ts",
        rightFileStart: { line: 20 },
        rightFileEnd: { line: 24 },
        leftFileStart: { line: 2 },
        leftFileEnd: { line: 3 },
      },
    });

    assert.equal(
      formatThread(single, ctx, prId),
      `### Thread 8 — /src/single.ts:5 [pending]\n${webBase}?discussionId=8\n- **User 8** (comment 8): comment 8`,
    );
    assert.equal(
      formatThread(range, ctx, prId),
      `### Thread 9 — /src/range.ts:20-24 [fixed]\n${webBase}?discussionId=9\n- **User 9** (comment 9): comment 9`,
    );
  });

  test("formatSummaryTable exactly formats general, file-only, single, and range rows", () => {
    const threads = [
      thread(1, { status: undefined }),
      thread(2, { threadContext: { filePath: "/src/file-only.ts" } }),
      thread(3, {
        status: "pending",
        threadContext: {
          filePath: "/src/single.ts",
          rightFileStart: { line: 11 },
          rightFileEnd: { line: 11 },
          leftFileStart: { line: 1 },
          leftFileEnd: { line: 2 },
        },
      }),
      thread(4, {
        status: "fixed",
        threadContext: {
          filePath: "/src/range.ts",
          leftFileStart: { line: 30 },
          leftFileEnd: { line: 33 },
        },
      }),
    ];

    assert.equal(
      formatSummaryTable(threads, ctx, prId),
      `| Thread | Location | Status | Link |\n` +
        `| --- | --- | --- | --- |\n` +
        `| 1 | General (not tied to a file/line) | active | [Open](${webBase}?discussionId=1) |\n` +
        `| 2 | /src/file-only.ts | active | [Open](${webBase}?discussionId=2) |\n` +
        `| 3 | /src/single.ts:11 | pending | [Open](${webBase}?discussionId=3) |\n` +
        `| 4 | /src/range.ts:30-33 | fixed | [Open](${webBase}?discussionId=4) |`,
    );
  });

  test("threadWebUrl returns the exact encoded Azure DevOps discussion URL", () => {
    assert.equal(threadWebUrl(ctx, prId, 123), `${webBase}?discussionId=123`);
  });

  test("postReply sends the exact comments request", async (t) => {
    const calls = mockFetch(t, [{ json: {} }]);

    await postReply(ctx, prId, 17, "Reply text", pat);

    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads/17/comments?api-version=7.1`,
        method: "POST",
        body: '{"content":"Reply text"}',
      },
    ]);
  });

  test("editComment PATCHes the comment content", async (t) => {
    const calls = mockFetch(t, [{ json: {} }]);

    await editComment(ctx, prId, 17, 23, "Edited text", pat);

    assert.equal(calls.length, 1);
    const [call] = requestShapes(calls);
    assert.equal(call.url, `${apiBase}/threads/17/comments/23?api-version=7.1`);
    assert.equal(call.method, "PATCH");
    assert.deepEqual(JSON.parse(call.body), { content: "Edited text" });
  });

  test("deleteComment DELETEs the comment and accepts an empty success response", async (t) => {
    const calls = mockFetch(t, [{ body: "" }]);

    await deleteComment(ctx, prId, 17, 23, pat);

    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads/17/comments/23?api-version=7.1`,
        method: "DELETE",
        body: null,
      },
    ]);
  });

  test("postComment sends the exact general-thread request", async (t) => {
    const posted = thread(51);
    const calls = mockFetch(t, [{ json: posted }]);

    const result = await postComment(
      ctx,
      prId,
      "General comment",
      pat,
      undefined,
      createFileAnchorCache(),
    );

    assert.deepEqual(result, posted);
    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads?api-version=7.1`,
        method: "POST",
        body: '{"comments":[{"content":"General comment"}],"status":"active"}',
      },
    ]);
  });

  test("postComment resolves a real file anchor and sends the exact anchored-thread request", async (t) => {
    const posted = thread(52);
    const calls = mockFetch(t, [
      { json: { value: [{ id: 1 }, { id: 3 }, { id: 2 }] } },
      {
        json: {
          changeEntries: [
            { changeTrackingId: 70, item: { path: "/src/other.ts" } },
            { changeTrackingId: 77, item: { path: "/src/app.ts" } },
          ],
        },
      },
      { json: posted },
    ]);

    const result = await postComment(
      ctx,
      prId,
      "Anchored comment",
      pat,
      { file: "src/app.ts", line: 4, endLine: 9 },
      createFileAnchorCache(),
    );

    assert.deepEqual(result, posted);
    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/iterations?api-version=7.1`,
        method: "GET",
        body: null,
      },
      {
        url: `${apiBase}/iterations/3/changes?api-version=7.1&$top=500&$skip=0`,
        method: "GET",
        body: null,
      },
      {
        url: `${apiBase}/threads?api-version=7.1`,
        method: "POST",
        body: '{"comments":[{"content":"Anchored comment"}],"status":"active","threadContext":{"filePath":"/src/app.ts","rightFileStart":{"line":4,"offset":1},"rightFileEnd":{"line":9,"offset":1}},"pullRequestThreadContext":{"iterationContext":{"firstComparingIteration":3,"secondComparingIteration":3},"changeTrackingId":77}}',
      },
    ]);
  });

  test("resolveThread sends the exact fixed-status request", async (t) => {
    const calls = mockFetch(t, [{ json: {} }]);

    await resolveThread(ctx, prId, 19, pat);

    assert.deepEqual(requestShapes(calls), [
      {
        url: `${apiBase}/threads/19?api-version=7.1`,
        method: "PATCH",
        body: '{"status":"fixed"}',
      },
    ]);
  });
});
