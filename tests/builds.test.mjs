import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createAzureRequester } from "../azure.ts";
import { createBuildService, stripTerminalControls } from "../builds.ts";
import { createMockFetch } from "./test-helpers.mjs";

const ctx = {
  organization: "test org",
  project: "test/project",
  repository: "checkout-name",
};
const pat = "test-only-fake-pat";
const buildBase = "https://dev.azure.com/test%20org/test%2Fproject/_apis/build/builds";

function pullRequest(overrides = {}) {
  return {
    pullRequestId: 42,
    title: "Validate widgets",
    status: "active",
    isDraft: false,
    sourceRefName: "refs/heads/feature/widgets",
    repository: { id: "Repo-ID", name: "widgets" },
    lastMergeCommit: { commitId: "ABCDEF123" },
    ...overrides,
  };
}

function build(overrides = {}) {
  return {
    id: 700,
    buildNumber: "2026.8.18.1",
    status: "completed",
    result: "failed",
    reason: "pullRequest",
    sourceBranch: "refs/pull/42/merge",
    sourceVersion: "abcdef123",
    queueTime: "2026-08-18T10:00:00Z",
    startTime: "2026-08-18T10:01:00Z",
    finishTime: "2026-08-18T10:04:00Z",
    repository: { id: "repo-id", name: "widgets", type: "TfsGit" },
    definition: { id: 9, name: "Widget CI" },
    _links: { web: { href: "https://dev.azure.com/build/700" } },
    ...overrides,
  };
}

function createPullRequestStub(resolveValues = [pullRequest()], getValues = resolveValues) {
  let resolveIndex = 0;
  let getIndex = 0;
  const calls = [];
  return {
    calls,
    service: {
      async resolve(requestedPrId) {
        calls.push({ method: "resolve", requestedPrId });
        const value = resolveValues[Math.min(resolveIndex, resolveValues.length - 1)];
        resolveIndex += 1;
        return value;
      },
      async get(prId) {
        calls.push({ method: "get", prId });
        const value = getValues[Math.min(getIndex, getValues.length - 1)];
        getIndex += 1;
        return value;
      },
    },
  };
}

function setup(t, responses, { resolveValues, getValues } = {}) {
  const { fetch, calls } = createMockFetch(t, responses);
  const azure = createAzureRequester({ pat, fetch });
  const pullRequests = createPullRequestStub(resolveValues, getValues);
  const service = createBuildService({ azure, ctx, pullRequests: pullRequests.service });
  return { service, calls, pullRequestCalls: pullRequests.calls };
}

function requestShapes(calls) {
  return calls.map(({ url, method, body, headers }) => ({ url, method, body, headers }));
}

function listUrl(continuation) {
  return (
    `${buildBase}?reasonFilter=pullRequest&branchName=refs%2Fpull%2F42%2Fmerge&` +
    `repositoryId=Repo-ID&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&` +
    (continuation === undefined
      ? ""
      : `continuationToken=${encodeURIComponent(continuation)}&`) +
    "api-version=7.1"
  );
}

function showResponses({
  shownBuild = build(),
  records = [],
  logs = [],
  texts = [],
} = {}) {
  return [
    { json: shownBuild },
    { json: { id: "timeline", records } },
    { json: { count: logs.length, value: logs } },
    ...texts,
  ];
}

describe("build discovery", () => {
  test("lists only current associated builds with exact query semantics and a normalized envelope", async (t) => {
    const current = build();
    const stale = build({ id: 701, sourceVersion: "older" });
    const unrelatedBranch = build({ id: 702, sourceBranch: "refs/pull/99/merge" });
    const unrelatedReason = build({ id: 703, reason: "manual" });
    const { service, calls, pullRequestCalls } = setup(t, [
      { json: { count: 4, value: [current, stale, unrelatedBranch, unrelatedReason] } },
    ]);

    const result = await service.list(undefined);

    assert.deepEqual(result, {
      pullRequest: {
        id: 42,
        title: "Validate widgets",
        status: "active",
        draft: false,
        currentMergeCommit: "ABCDEF123",
      },
      history: false,
      builds: [current],
    });
    assert.deepEqual(pullRequestCalls, [
      { method: "resolve", requestedPrId: undefined },
      { method: "get", prId: 42 },
    ]);
    assert.deepEqual(requestShapes(calls), [
      {
        url: listUrl(),
        method: "GET",
        headers: { authorization: "<redacted>" },
        body: null,
      },
    ]);
  });

  test("history follows and encodes every continuation page while preserving response order", async (t) => {
    const first = build({ id: 702, sourceVersion: "old-two" });
    const second = build({ id: 701, sourceVersion: "old-one" });
    const token = "next/page +?#&=";
    const completed = pullRequest({
      status: "completed",
      lastMergeCommit: undefined,
      isDraft: true,
    });
    const { service, calls } = setup(
      t,
      [
        {
          json: { value: [first] },
          headers: { "x-ms-continuationtoken": token },
        },
        { json: { value: [second] } },
      ],
      { resolveValues: [completed] },
    );

    const result = await service.list(42, { history: true });

    assert.equal(result.history, true);
    assert.deepEqual(result.builds, [first, second]);
    assert.deepEqual(result.pullRequest, {
      id: 42,
      title: "Validate widgets",
      status: "completed",
      draft: true,
      currentMergeCommit: null,
    });
    assert.deepEqual(calls.map(({ url }) => url), [listUrl(), listUrl(token)]);
  });

  test("rejects a repeated continuation token instead of looping", async (t) => {
    const { service, calls } = setup(t, [
      { json: { value: [] }, headers: { "x-ms-continuationtoken": "repeat" } },
      { json: { value: [] }, headers: { "x-ms-continuationtoken": "repeat" } },
    ]);

    await assert.rejects(service.list(42, { history: true }), {
      message: "Azure DevOps build pagination repeated a continuation token; refusing to loop.",
    });
    assert.equal(calls.length, 2);
  });

  test("rejects duplicate builds and oversized continuation tokens", async (t) => {
    const duplicate = setup(t, [
      {
        json: { value: [build()] },
        headers: { "x-ms-continuationtoken": "next" },
      },
      { json: { value: [build()] } },
    ]);
    await assert.rejects(
      duplicate.service.list(42, { history: true }),
      /duplicate build ID 700/,
    );

    const oversized = setup(t, [
      {
        json: { value: [] },
        headers: { "x-ms-continuationtoken": "x".repeat(8_193) },
      },
    ]);
    await assert.rejects(
      oversized.service.list(42, { history: true }),
      /oversized continuation token/,
    );
    assert.equal(oversized.calls.length, 1);
  });

  test("rejects a current-list result if the PR changes during pagination", async (t) => {
    const changedCommit = setup(
      t,
      [{ json: { value: [build()] } }],
      { getValues: [pullRequest({ lastMergeCommit: { commitId: "new-merge" } })] },
    );
    await assert.rejects(changedCommit.service.list(42), /changed while current builds were being listed/);

    const changedStatus = setup(
      t,
      [{ json: { value: [build()] } }],
      { getValues: [pullRequest({ status: "completed" })] },
    );
    await assert.rejects(changedStatus.service.list(42), /only active pull requests are eligible/);
  });

  test("current listing rejects inactive and merge-less PRs before the Build API", async (t) => {
    const inactive = setup(t, [], {
      resolveValues: [pullRequest({ status: "abandoned" })],
    });
    await assert.rejects(inactive.service.list(42), /only active pull requests are eligible/);
    assert.deepEqual(inactive.calls, []);

    const missingCommit = setup(t, [], {
      resolveValues: [pullRequest({ lastMergeCommit: undefined })],
    });
    await assert.rejects(
      missingCommit.service.list(42),
      /no lastMergeCommit\.commitId.*current merge version will not be guessed/,
    );
    assert.deepEqual(missingCommit.calls, []);
  });

  test("fails on malformed association-critical PR and Build list data", async (t) => {
    const malformedPr = setup(t, [], {
      resolveValues: [pullRequest({ repository: { name: "widgets" } })],
    });
    await assert.rejects(malformedPr.service.list(42), /pull request\.repository\.id/);

    const malformedEnvelope = setup(t, [{ json: { value: {} } }]);
    await assert.rejects(malformedEnvelope.service.list(42), /build list response\.value must be an array/);

    const malformedBuild = setup(t, [
      { json: { value: [build({ sourceVersion: undefined })] } },
    ]);
    await assert.rejects(malformedBuild.service.list(42), /sourceVersion must be a non-empty string/);
  });

  test("formats deterministic current/history rows and explicit empty results", async (t) => {
    const historical = build({ id: 699, sourceVersion: "older", status: "inProgress", result: undefined });
    const { service } = setup(t, [
      { json: { value: [build(), historical] } },
    ]);
    const result = await service.list(42, { history: true });

    assert.equal(
      service.formatList(result),
      "Builds for PR #42: Validate widgets (history)\n\n" +
        "- Build 700/2026.8.18.1 — Widget CI\n" +
        "  Status/result: completed/failed [current]\n" +
        "  Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z\n" +
        "  https://dev.azure.com/build/700\n\n" +
        "- Build 699/2026.8.18.1 — Widget CI\n" +
        "  Status/result: inProgress/unknown [history]\n" +
        "  Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z\n" +
        "  https://dev.azure.com/build/700",
    );

    assert.equal(
      service.formatList({ ...result, history: false, builds: [] }),
      "No associated current merge version builds found for PR #42.",
    );
  });
});

describe("build diagnosis", () => {
  test("shows a historical build, orders its graph, expands every problem result, and deduplicates logs", async (t) => {
    const sharedLog = { id: 17, type: "Container", lineCount: 450 };
    const records = [
      { id: "task-b", parentId: "job", type: "Task", name: "Tests", order: 2, state: "completed", result: "failed", attempt: 1, issues: [{ type: "error", category: "test", message: "2 failed" }], log: { id: 17 } },
      { id: "stage", type: "Stage", name: "Validate", order: 1, state: "completed", result: "succeeded", attempt: 1 },
      { id: "task-a", parentId: "job", type: "Task", name: "Compile", order: 1, state: "completed", result: "succeededWithIssues", attempt: 2, issues: [{ type: "warning", message: "types" }], log: { id: 17 } },
      { id: "job", parentId: "stage", type: "Job", name: "Linux", order: 1, state: "completed", result: "failed", attempt: 1 },
      { id: "canceled", type: "Task", name: "Cleanup", order: 3, state: "completed", result: "canceled", attempt: 1 },
      { id: "abandoned", type: "Task", name: "Publish", order: 4, state: "completed", result: "abandoned", attempt: 1 },
      { id: "success", type: "Task", name: "Skipped expansion", order: 5, state: "completed", result: "succeeded", attempt: 1, log: { id: 99 } },
    ];
    const oldBuild = build({ sourceVersion: "old-version" });
    const { service, calls } = setup(
      t,
      showResponses({
        shownBuild: oldBuild,
        records,
        logs: [sharedLog],
        texts: [{ body: "\u001b[31merror\u001b[0m\nordinary\tline\n" }],
      }),
      { resolveValues: [pullRequest({ status: "completed" })] },
    );

    const result = await service.show(42, 700);

    assert.equal(result.current, false);
    assert.deepEqual(result.build, oldBuild);
    assert.deepEqual(result.timeline, { id: "timeline", records });
    assert.equal(result.problemRecords.length, 5);
    assert.deepEqual(
      result.problemRecords.map((entry) => entry.record.id),
      ["job", "task-a", "task-b", "canceled", "abandoned"],
    );
    assert.equal(result.problemRecords[1].logText, "\u001b[31merror\u001b[0m\nordinary\tline\n");
    assert.deepEqual(result.problemRecords[1].logRange, { startLine: 250, endLine: 450 });
    assert.equal(result.problemRecords[2].logText, result.problemRecords[1].logText);
    assert.equal(result.problemRecords[0].noLog, true);
    assert.equal(result.problemRecords[3].noLog, true);
    assert.equal(result.problemRecords[4].noLog, true);
    assert.equal(service.hasLogErrors(result), false);
    assert.deepEqual(calls.map(({ url }) => url), [
      `${buildBase}/700?api-version=7.1`,
      `${buildBase}/700/timeline?api-version=7.1`,
      `${buildBase}/700/logs?api-version=7.1`,
      `${buildBase}/700/logs/17?startLine=250&endLine=450&api-version=7.1`,
    ]);
    assert.equal(calls[3].headers.accept, "text/plain");

    const human = service.formatShow(result);
    assert.match(human, /PR: #42 \(history\)/);
    assert.match(human, /- Stage\/Validate:[\s\S]*  - Job\/Linux:[\s\S]*    - Task\/Compile/);
    assert.match(human, /Problem 1: Job\/Linux \[failed\]/);
    assert.match(human, /error\nordinary\tline/);
    assert.doesNotMatch(human, /\u001b/);
  });

  test("a matching build on a completed PR is still classified as historical", async (t) => {
    const completed = pullRequest({ status: "completed" });
    const { service } = setup(t, showResponses(), { resolveValues: [completed] });
    const result = await service.show(42, 700);
    assert.equal(result.current, false);
    assert.match(service.formatShow(result), /PR: #42 \(history\)/);
  });

  test("full logs omit bounds and lineCount while retaining raw JSON-compatible text", async (t) => {
    const records = [
      { id: "problem", type: "Task", name: "Lint", result: "failed", log: { id: 2 } },
    ];
    const { service, calls } = setup(
      t,
      showResponses({
        records,
        logs: [{ id: 2, type: "Container" }],
        texts: [{ body: "top\n\u001b]0;hostile\u0007bottom\n" }],
      }),
    );

    const result = await service.show(undefined, 700, { fullLogs: true });

    assert.equal(result.problemRecords[0].logMode, "full");
    assert.equal(result.problemRecords[0].logRange, null);
    assert.equal(result.problemRecords[0].logText, "top\n\u001b]0;hostile\u0007bottom\n");
    assert.equal(calls[3].url, `${buildBase}/700/logs/2?api-version=7.1`);
    assert.match(service.formatShow(result), /FULL LOGS; potentially sensitive/);
    assert.doesNotMatch(service.formatShow(result), /hostile/);
  });

  test("requests exact 200-line boundaries and represents a metadata-proven empty log without downloading", async (t) => {
    const records = [
      { id: "short", result: "failed", log: { id: 1 } },
      { id: "boundary", result: "failed", log: { id: 2 } },
      { id: "long", result: "failed", log: { id: 3 } },
      { id: "empty", result: "failed", log: { id: 4 } },
    ];
    const { service, calls } = setup(t, showResponses({
      records,
      logs: [
        { id: 1, lineCount: 199 },
        { id: 2, lineCount: 200 },
        { id: 3, lineCount: 201 },
        { id: 4, lineCount: 0 },
      ],
      texts: [{ body: "short" }, { body: "boundary" }, { body: "long" }],
    }));

    const result = await service.show(42, 700);

    assert.deepEqual(result.problemRecords.map(({ logRange }) => logRange), [
      { startLine: 0, endLine: 199 },
      { startLine: 0, endLine: 200 },
      { startLine: 1, endLine: 201 },
      { startLine: 0, endLine: 0 },
    ]);
    assert.equal(result.problemRecords[3].logText, "");
    assert.deepEqual(calls.slice(3).map(({ url }) => url), [
      `${buildBase}/700/logs/1?startLine=0&endLine=199&api-version=7.1`,
      `${buildBase}/700/logs/2?startLine=0&endLine=200&api-version=7.1`,
      `${buildBase}/700/logs/3?startLine=1&endLine=201&api-version=7.1`,
    ]);
  });

  test("locally enforces the final-200-line and default byte limits", async (t) => {
    const records = [
      { id: "problem", type: "Task", name: "Lint", result: "failed", log: { id: 5 } },
    ];
    const serverIgnoredRange = setup(
      t,
      showResponses({
        records,
        logs: [{ id: 5, lineCount: 300 }],
        texts: [{ body: `${Array.from({ length: 250 }, (_value, index) => `line-${index}`).join("\n")}\n` }],
      }),
    );
    const result = await serverIgnoredRange.service.show(42, 700);
    const lines = result.problemRecords[0].logText.trimEnd().split("\n");
    assert.equal(lines.length, 200);
    assert.equal(lines[0], "line-50");
    assert.equal(lines.at(-1), "line-249");

    const oversized = setup(
      t,
      showResponses({
        records,
        logs: [{ id: 5, lineCount: 1 }],
        texts: [{ body: "x".repeat(2 * 1024 * 1024 + 1) }],
      }),
    );
    const partial = await oversized.service.show(42, 700);
    assert.equal(oversized.service.hasLogErrors(partial), true);
    assert.match(partial.problemRecords[0].logError, /response body exceeded 2097152 bytes/);
  });

  test("continues after unique log failures, shares errors, and sanitizes terminal controls", async (t) => {
    const records = [
      { id: "one", type: "Task", name: "One", result: "failed", log: { id: 1 } },
      { id: "shared", type: "Task", name: "Shared", result: "failed", log: { id: 1 } },
      { id: "two", type: "Task", name: "Two", result: "failed", log: { id: 2 } },
    ];
    const { service, calls } = setup(
      t,
      showResponses({
        records,
        logs: [{ id: 1, lineCount: 3 }, { id: 2, lineCount: 2 }],
        texts: [
          { status: 503, statusText: "Unavailable", body: "\u001b[31mbad\u001b[0m" },
          { body: "second log" },
        ],
      }),
    );

    const result = await service.show(42, 700);

    assert.equal(calls.length, 5);
    assert.equal(service.hasLogErrors(result), true);
    assert.equal(result.problemRecords[0].logError.includes("\u001b"), false);
    assert.match(result.problemRecords[0].logError, /bad/);
    assert.equal(result.problemRecords[1].logError, result.problemRecords[0].logError);
    assert.equal(result.problemRecords[2].logText, "second log");
  });

  test("fails before log text on unrelated builds, malformed timelines, missing metadata, and unbounded defaults", async (t) => {
    const unrelated = setup(t, [{ json: build({ repository: { id: "other", type: "TfsGit" } }) }]);
    await assert.rejects(unrelated.service.show(42, 700), /not associated.*repository ID/);
    assert.equal(unrelated.calls.length, 1);

    const malformedTimeline = setup(t, [
      { json: build() },
      { json: { records: {} } },
    ]);
    await assert.rejects(malformedTimeline.service.show(42, 700), /timeline\.records must be an array/);
    assert.equal(malformedTimeline.calls.length, 2);

    const missingMetadata = setup(t, showResponses({
      records: [{ id: "p", result: "failed", log: { id: 9 } }],
      logs: [],
    }));
    await assert.rejects(missingMetadata.service.show(42, 700), /references log 9.*did not contain it/);
    assert.equal(missingMetadata.calls.length, 3);

    const noLineCount = setup(t, showResponses({
      records: [{ id: "p", result: "failed", log: { id: 9 } }],
      logs: [{ id: 9 }],
    }));
    await assert.rejects(noLineCount.service.show(42, 700), /no lineCount metadata.*unbounded log/);
    assert.equal(noLineCount.calls.length, 3);
  });

  test("timeline formatting is deterministic, includes orphan/cycle records once, and strips controls", async (t) => {
    const records = [
      { id: "root", parentId: null, type: "Stage", name: "Root", order: 0, result: "succeeded" },
      { id: "root-child", parentId: "ROOT", type: "Job", name: "Root Child", order: 1, result: "succeeded" },
      { id: "orphan", parentId: "missing", type: "Task", name: "\u001b[31mOrphan\u001b[0m", order: 2, result: "succeeded" },
      { id: "a", parentId: "B", type: "Stage", name: "A", order: 1, result: "succeeded" },
      { id: "b", parentId: "a", type: "Job", name: "B", order: 1, result: "succeeded" },
    ];
    const { service } = setup(t, showResponses({ records }));
    const result = await service.show(42, 700);
    const human = service.formatShow(result);

    assert.equal((human.match(/Stage\/Root/g) ?? []).length, 1);
    assert.equal((human.match(/Job\/Root Child/g) ?? []).length, 1);
    assert.equal((human.match(/Stage\/A/g) ?? []).length, 1);
    assert.equal((human.match(/Job\/B/g) ?? []).length, 1);
    assert.equal((human.match(/Task\/Orphan/g) ?? []).length, 1);
    assert.match(human, /orphan parent missing/);
    assert.match(human, /cycle/);
    assert.equal(
      stripTerminalControls("a\u001b[2Jb\u0000c\rrewrite\r\nnext\t\nd\u202E"),
      "abcrewrite\nnext\t\nd",
    );
  });

  test("formats a deep timeline iteratively with bounded indentation", async (t) => {
    const records = Array.from({ length: 10_000 }, (_value, index) => ({
      id: `node-${index}`,
      parentId: index === 0 ? null : `NODE-${index - 1}`,
      type: "Task",
      name: `Node ${index}`,
      order: index,
      result: "succeeded",
    }));
    const { service } = setup(t, showResponses({ records }));
    const result = await service.show(42, 700);
    const human = service.formatShow(result);
    assert.equal((human.match(/Task\/Node/g) ?? []).length, records.length);
    assert.match(human, /\[depth 9999\]/);
  });
});

describe("safe build retry", () => {
  for (const retryableResult of ["failed", "partiallySucceeded", "canceled"]) {
    test(`double-validates and sends the exact documented PATCH for ${retryableResult}`, async (t) => {
      const initial = build({ result: retryableResult });
      const refreshed = build({ result: retryableResult.toUpperCase() });
      const returned = build({
        id: 701,
        buildNumber: "2026.8.18.2",
        status: "inProgress",
        _links: { web: { href: "https://dev.azure.com/build/701" } },
      });
      delete returned.result;
      const { service, calls, pullRequestCalls } = setup(
        t,
        [{ json: initial }, { json: refreshed }, { json: returned }],
        { resolveValues: [pullRequest()], getValues: [pullRequest({ isDraft: true })] },
      );

      const result = await service.retry(undefined, 700);

      assert.deepEqual(result, returned);
      assert.deepEqual(pullRequestCalls, [
        { method: "resolve", requestedPrId: undefined },
        { method: "get", prId: 42 },
      ]);
      assert.deepEqual(calls.map(({ url, method, body }) => ({ url, method, body })), [
        { url: `${buildBase}/700?api-version=7.1`, method: "GET", body: null },
        { url: `${buildBase}/700?api-version=7.1`, method: "GET", body: null },
        {
          url: `${buildBase}/700?retry=true&api-version=7.1`,
          method: "PATCH",
          body: JSON.stringify({ id: 700 }),
        },
      ]);
      assert.equal(
        service.formatRetry(result),
        "Azure DevOps accepted the retry request for build 701/2026.8.18.2.\n" +
          "Returned status/result: inProgress/unknown\n" +
          "URL: https://dev.azure.com/build/701",
      );
    });
  }

  test("rejects every ineligible initial state without a refresh or PATCH", async (t) => {
    const cases = [
      ["successful", pullRequest(), build({ result: "succeeded" }), /only failed, partiallySucceeded, or canceled/],
      ["partially successful spelling outside the documented enum", pullRequest(), build({ result: "succeededWithIssues" }), /only failed, partiallySucceeded, or canceled/],
      ["abandoned result", pullRequest(), build({ result: "abandoned" }), /only failed, partiallySucceeded, or canceled/],
      ["queued", pullRequest(), build({ status: "notStarted", result: null }), /must be completed/],
      ["running", pullRequest(), build({ status: "inProgress" }), /must be completed/],
      ["cancelling", pullRequest(), build({ status: "cancelling", result: "canceled" }), /must be completed/],
      ["missing status", pullRequest(), build({ status: null }), /has no status/],
      ["missing result", pullRequest(), build({ result: null }), /has no result/],
      ["stale", pullRequest(), build({ sourceVersion: "old" }), /historical/],
      ["unrelated", pullRequest(), build({ sourceBranch: "refs/pull/9/merge" }), /not associated/],
      ["completed PR", pullRequest({ status: "completed" }), build(), /only active pull requests/],
      ["abandoned PR", pullRequest({ status: "abandoned" }), build(), /only active pull requests/],
      ["missing merge", pullRequest({ lastMergeCommit: undefined }), build(), /no lastMergeCommit/],
    ];

    for (const [name, pr, candidate, expected] of cases) {
      await t.test(name, async (t) => {
        const { service, calls, pullRequestCalls } = setup(t, [{ json: candidate }], {
          resolveValues: [pr],
        });
        await assert.rejects(service.retry(42, 700), expected);
        assert.equal(calls.length, 1);
        assert.deepEqual(pullRequestCalls, [{ method: "resolve", requestedPrId: 42 }]);
      });
    }
  });

  test("repeats all checks after refresh and never PATCHes changed PR/build state", async (t) => {
    const changedPr = setup(t, [{ json: build() }, { json: build() }], {
      resolveValues: [pullRequest()],
      getValues: [pullRequest({ status: "completed" })],
    });
    await assert.rejects(changedPr.service.retry(42, 700), /after refresh.*only active/s);
    assert.equal(changedPr.calls.length, 2);

    const changedBuild = setup(t, [{ json: build() }, { json: build({ status: "inProgress" }) }], {
      resolveValues: [pullRequest()],
      getValues: [pullRequest()],
    });
    await assert.rejects(changedBuild.service.retry(42, 700), /after refresh.*must be completed/s);
    assert.equal(changedBuild.calls.length, 2);
    assert.ok(changedBuild.calls.every(({ method }) => method === "GET"));
  });

  test("treats a stale post-PATCH response as an uncertain outcome", async (t) => {
    const { service, calls } = setup(t, [
      { json: build() },
      { json: build() },
      { json: build({ sourceVersion: "old-version" }) },
    ]);

    await assert.rejects(service.retry(42, 700), (error) => {
      assert.match(error.message, /failed after dispatch/);
      assert.match(error.message, /does not match PR #42's current merge commit/);
      return true;
    });
    assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
  });

  test("does not repeat a failed PATCH and gives uncertain-outcome inspection guidance", async (t) => {
    const { service, calls } = setup(t, [
      { json: build() },
      { json: build() },
      { status: 503, statusText: "Service Unavailable", body: "try later" },
    ]);

    await assert.rejects(service.retry(42, 700), (error) => {
      assert.match(error.message, /failed after dispatch/);
      assert.match(error.message, /server outcome may be uncertain/);
      assert.match(error.message, /do not retry automatically/);
      assert.match(error.message, /pr\.sh build show --pr 42 --build 700/);
      assert.match(error.message, /pr\.sh build list --pr 42 --history/);
      return true;
    });
    assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
  });

  test("rejects non-positive IDs before any resolution or request", async (t) => {
    const { service, calls, pullRequestCalls } = setup(t, []);
    await assert.rejects(service.show(42, 0), {
      message: "Build ID must be a positive safe integer.",
    });
    await assert.rejects(service.retry(42, -1), {
      message: "Build ID must be a positive safe integer.",
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(pullRequestCalls, []);
  });
});
