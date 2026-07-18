import assert from "node:assert/strict";
import test from "node:test";

import { createFileAnchorCache, resolveFileAnchor } from "../file-anchors.ts";
import { mockFetch } from "./test-helpers.mjs";

const ctx = {
  organization: "test-org",
  project: "test project",
  repository: "test/repo",
};
const pat = "test-only-pat";
const baseUrl =
  "https://dev.azure.com/test-org/test%20project/_apis/git/repositories/test%2Frepo/pullRequests";

function iterationsUrl(prId) {
  return `${baseUrl}/${prId}/iterations?api-version=7.1`;
}

function changesUrl(prId, iterationId, skip = 0) {
  return (
    `${baseUrl}/${prId}/iterations/${iterationId}/changes` +
    `?api-version=7.1&$top=500&$skip=${skip}`
  );
}

function assertRequestUrls(calls, expectedUrls) {
  assert.equal(calls.length, expectedUrls.length);
  assert.deepEqual(
    calls.map(({ method, url }) => ({ method, url })),
    expectedUrls.map((url) => ({ method: "GET", url })),
  );
}

test("normalizes a leading slash, defaults the range and offsets, and selects the maximum iteration", async (t) => {
  const calls = mockFetch(t, [
    { json: { value: [{ id: 4 }, { id: 12 }, { id: 7 }] } },
    {
      json: {
        changeEntries: [
          { changeTrackingId: 40, item: { path: "/other.ts" } },
          { changeTrackingId: 0, item: { path: "/src/file.ts" } },
        ],
      },
    },
  ]);

  const anchor = await resolveFileAnchor(
    ctx,
    31,
    pat,
    { file: "src/file.ts" },
    createFileAnchorCache(),
  );

  assert.deepEqual(anchor, {
    threadContext: {
      filePath: "/src/file.ts",
      rightFileStart: { line: 1, offset: 1 },
      rightFileEnd: { line: 1, offset: 1 },
    },
    pullRequestThreadContext: {
      iterationContext: {
        firstComparingIteration: 12,
        secondComparingIteration: 12,
      },
      changeTrackingId: 0,
    },
  });
  assertRequestUrls(calls, [iterationsUrl(31), changesUrl(31, 12)]);
});

test("preserves an existing leading slash and uses an explicit line range with fixed offsets", async (t) => {
  const calls = mockFetch(t, [{ json: { value: [{ id: 8 }] } }, { json: { changeEntries: [] } }]);

  const anchor = await resolveFileAnchor(
    ctx,
    32,
    pat,
    { file: "/src/ranged.ts", line: 6, endLine: 14 },
    createFileAnchorCache(),
  );

  assert.deepEqual(anchor, {
    threadContext: {
      filePath: "/src/ranged.ts",
      rightFileStart: { line: 6, offset: 1 },
      rightFileEnd: { line: 14, offset: 1 },
    },
    pullRequestThreadContext: {
      iterationContext: {
        firstComparingIteration: 8,
        secondComparingIteration: 8,
      },
    },
  });
  assert.equal(Object.hasOwn(anchor.pullRequestThreadContext, "changeTrackingId"), false);
  assertRequestUrls(calls, [iterationsUrl(32), changesUrl(32, 8)]);
});

test("uses the explicit start line as the default end line", async (t) => {
  const calls = mockFetch(t, [
    { json: { value: [{ id: 3 }] } },
    { json: { changeEntries: [{ changeTrackingId: 91, item: { path: "/one-line.ts" } }] } },
  ]);

  const anchor = await resolveFileAnchor(
    ctx,
    33,
    pat,
    { file: "one-line.ts", line: 27 },
    createFileAnchorCache(),
  );

  assert.deepEqual(anchor.threadContext, {
    filePath: "/one-line.ts",
    rightFileStart: { line: 27, offset: 1 },
    rightFileEnd: { line: 27, offset: 1 },
  });
  assert.equal(anchor.pullRequestThreadContext.changeTrackingId, 91);
  assertRequestUrls(calls, [iterationsUrl(33), changesUrl(33, 3)]);
});

test("rejects a PR with no iterations before requesting changes", async (t) => {
  const calls = mockFetch(t, [{ json: { value: [] } }]);

  await assert.rejects(
    resolveFileAnchor(ctx, 404, pat, { file: "missing.ts" }, createFileAnchorCache()),
    { message: "PR #404 has no iterations." },
  );
  assertRequestUrls(calls, [iterationsUrl(404)]);
});

test("pages after exactly 500 change entries and advances skip by 500", async (t) => {
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    changeTrackingId: index + 1,
    item: { path: `/generated/file-${index}.ts` },
  }));
  const calls = mockFetch(t, [
    { json: { value: [{ id: 21 }] } },
    { json: { changeEntries: firstPage, nextSkip: 900, nextTop: 17 } },
    {
      json: {
        changeEntries: [
          { changeTrackingId: 700, item: { path: "/other.ts" } },
          { changeTrackingId: 701, item: { path: "/target.ts" } },
        ],
      },
    },
  ]);

  const anchor = await resolveFileAnchor(
    ctx,
    34,
    pat,
    { file: "target.ts", line: 2 },
    createFileAnchorCache(),
  );

  assert.equal(anchor.pullRequestThreadContext.changeTrackingId, 701);
  assertRequestUrls(calls, [iterationsUrl(34), changesUrl(34, 21, 0), changesUrl(34, 21, 500)]);
});

test("reuses pending promises for concurrent duplicate anchor lookups", async (t) => {
  const calls = mockFetch(t, [
    { json: { value: [{ id: 15 }] } },
    {
      json: {
        changeEntries: [{ changeTrackingId: 88, item: { path: "/shared.ts" } }],
      },
    },
  ]);
  const cache = createFileAnchorCache();

  const [first, second] = await Promise.all([
    resolveFileAnchor(ctx, 35, pat, { file: "shared.ts", line: 4 }, cache),
    resolveFileAnchor(ctx, 35, pat, { file: "/shared.ts", line: 9 }, cache),
  ]);

  assert.equal(first.pullRequestThreadContext.changeTrackingId, 88);
  assert.equal(second.pullRequestThreadContext.changeTrackingId, 88);
  assert.equal(first.threadContext.rightFileStart.line, 4);
  assert.equal(second.threadContext.rightFileStart.line, 9);
  assertRequestUrls(calls, [iterationsUrl(35), changesUrl(35, 15)]);
});

test("separates change-tracking cache keys by PR, iteration, and file", async (t) => {
  const calls = mockFetch(t, [
    { json: { changeEntries: [{ changeTrackingId: 101, item: { path: "/a.ts" } }] } },
    { json: { changeEntries: [{ changeTrackingId: 102, item: { path: "/a.ts" } }] } },
    { json: { changeEntries: [{ changeTrackingId: 103, item: { path: "/a.ts" } }] } },
    { json: { changeEntries: [{ changeTrackingId: 104, item: { path: "/b.ts" } }] } },
  ]);
  const cache = createFileAnchorCache();

  const results = await Promise.all([
    cache.getChangeTrackingId(ctx, 41, 5, "/a.ts", pat),
    cache.getChangeTrackingId(ctx, 42, 5, "/a.ts", pat),
    cache.getChangeTrackingId(ctx, 41, 6, "/a.ts", pat),
    cache.getChangeTrackingId(ctx, 41, 5, "/b.ts", pat),
  ]);

  assert.deepEqual(results, [101, 102, 103, 104]);
  assertRequestUrls(calls, [
    changesUrl(41, 5),
    changesUrl(42, 5),
    changesUrl(41, 6),
    changesUrl(41, 5),
  ]);
});

test("retains and reuses a rejected iteration promise", async (t) => {
  const calls = mockFetch(t, [
    { status: 503, statusText: "Service Unavailable", body: "temporarily unavailable" },
  ]);
  const cache = createFileAnchorCache();

  const first = cache.getIterationId(ctx, 55, pat);
  const second = cache.getIterationId(ctx, 55, pat);

  assert.strictEqual(second, first);
  await assert.rejects(
    first,
    new RegExp(
      `Azure DevOps API request \\(GET ${iterationsUrl(55).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) failed: 503 Service Unavailable`,
    ),
  );
  await assert.rejects(second);
  assertRequestUrls(calls, [iterationsUrl(55)]);
});
