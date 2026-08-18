import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AzureRequestError, createAzureRequester } from "../azure.ts";
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

function transientError(kind, status, retryAfterMs) {
  return new AzureRequestError(`safe ${kind} failure`, kind, { status, retryAfterMs });
}

function createWaitHarness(responses, { resolvedPr = pullRequest(), start = 0 } = {}) {
  const clock = { value: start };
  const calls = [];
  const sleeps = [];
  const pullRequestCalls = [];
  let responseIndex = 0;
  const azure = {
    async request(url, options) {
      calls.push({ url, options, at: clock.value });
      if (responseIndex >= responses.length) throw new Error("Unexpected build poll");
      const response = responses[responseIndex++];
      if (typeof response === "function") return response({ clock, options, calls });
      if (response instanceof Error) throw response;
      return response;
    },
    async requestWithMetadata() {
      throw new Error("wait must not use requestWithMetadata");
    },
  };
  const pullRequests = {
    async resolve(requestedPrId) {
      pullRequestCalls.push({ method: "resolve", requestedPrId });
      return resolvedPr;
    },
    async get() {
      throw new Error("wait must resolve the PR only once");
    },
  };
  const sleep = async (milliseconds, signal) => {
    if (signal?.aborted) throw new AzureRequestError("sleep aborted", "abort");
    sleeps.push({ at: clock.value, milliseconds });
    clock.value += milliseconds;
  };
  const service = createBuildService({
    azure,
    ctx,
    pullRequests,
    now: () => clock.value,
    sleep,
  });
  return { service, clock, calls, sleeps, pullRequestCalls };
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

describe("deterministic build wait", () => {
  const terminalCases = [
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["partiallySucceeded", "partiallySucceeded"],
    ["canceled", "canceled"],
    ["unknown Azure result", "abandoned", "unknown"],
    ["missing Azure result", undefined, "unknown"],
  ];
  for (const [name, azureResult, expectedOutcome = name] of terminalCases) {
    test(`maps immediate completed ${name}`, async () => {
      const observed = build({ status: "CoMpLeTeD", result: azureResult });
      const { service, calls, sleeps, pullRequestCalls } = createWaitHarness([observed]);

      const result = await service.wait(undefined, 700);

      assert.equal(result.outcome, expectedOutcome);
      assert.equal(result.timedOut, false);
      assert.equal(result.build, observed);
      assert.equal(result.pollCount, 1);
      assert.equal(result.transientFailureCount, 0);
      assert.equal(result.elapsedSeconds, 0);
      assert.deepEqual(sleeps, []);
      assert.deepEqual(pullRequestCalls, [{ method: "resolve", requestedPrId: undefined }]);
      assert.equal(calls[0].options.timeoutMs, 30_000);
      assert.equal(calls[0].options.maxResponseBytes, 16 * 1024 * 1024);
    });
  }

  test("allows a historical associated build on a completed PR", async () => {
    const historical = build({ sourceVersion: "old-merge", result: "succeeded" });
    const { service, pullRequestCalls } = createWaitHarness([historical], {
      resolvedPr: pullRequest({ status: "completed", lastMergeCommit: undefined }),
    });
    const result = await service.wait(42, 700);
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.build, historical);
    assert.deepEqual(pullRequestCalls, [{ method: "resolve", requestedPrId: 42 }]);
  });

  for (const status of ["notStarted", "inProgress", "cancelling", "postponed"]) {
    test(`accepts ${status} and transitions to terminal without timeline/log calls`, async () => {
      const first = build({ status: status.toUpperCase(), result: undefined });
      const completed = build({ status: "completed", result: "SUCCEEDED" });
      const events = [];
      const { service, calls, sleeps } = createWaitHarness([first, completed]);

      const result = await service.wait(42, 700, {
        intervalSeconds: 10,
        onProgress: (event) => events.push(event),
      });

      assert.equal(result.outcome, "succeeded");
      assert.equal(result.pollCount, 2);
      assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
      assert.deepEqual(events.map(({ type, change }) => [type, change]), [
        ["state", "initial"],
        ["state", "changed"],
      ]);
      assert.deepEqual(calls.map(({ url }) => url), [
        `${buildBase}/700?api-version=7.1`,
        `${buildBase}/700?api-version=7.1`,
      ]);
      assert.ok(calls.every(({ options }) => options.method === undefined));
    });
  }

  test("uses default interval/timeout and validates inclusive service boundaries", async () => {
    const defaults = createWaitHarness([
      build({ status: "inProgress", result: undefined }),
      build({ result: "succeeded" }),
    ]);
    const defaultResult = await defaults.service.wait(42, 700);
    assert.equal(defaultResult.elapsedSeconds, 60);
    assert.deepEqual(defaults.sleeps, [{ at: 0, milliseconds: 60_000 }]);

    const defaultTimeout = createWaitHarness([
      ({ clock }) => {
        clock.value += 3_600_000;
        return build({ result: "succeeded" });
      },
    ]);
    assert.equal((await defaultTimeout.service.wait(42, 700)).outcome, "timeout");

    for (const [intervalSeconds, timeoutSeconds] of [
      [10, 10],
      [3_600, 86_400],
    ]) {
      const boundary = createWaitHarness([build({ result: "succeeded" })]);
      assert.equal(
        (await boundary.service.wait(42, 700, { intervalSeconds, timeoutSeconds })).outcome,
        "succeeded",
      );
    }

    const invalidId = createWaitHarness([]);
    await assert.rejects(invalidId.service.wait(42, 0), /positive safe integer/);
    assert.deepEqual(invalidId.pullRequestCalls, []);

    for (const options of [
      { intervalSeconds: 9 },
      { intervalSeconds: 3_601 },
      { intervalSeconds: 10.5 },
      { timeoutSeconds: 9 },
      { timeoutSeconds: 86_401 },
      { timeoutSeconds: 10.5 },
    ]) {
      const invalid = createWaitHarness([]);
      await assert.rejects(invalid.service.wait(42, 700, options), /whole number from/);
      assert.deepEqual(invalid.pullRequestCalls, []);
      assert.deepEqual(invalid.calls, []);
    }
  });

  test("times out with the latest valid build and never polls at the deadline", async () => {
    const observed = build({ status: "inProgress", result: undefined });
    const { service, calls, sleeps } = createWaitHarness([observed]);

    const result = await service.wait(42, 700, { intervalSeconds: 10, timeoutSeconds: 10 });

    assert.deepEqual(result, {
      pullRequest: {
        id: 42,
        title: "Validate widgets",
        status: "active",
        draft: false,
        currentMergeCommit: "ABCDEF123",
      },
      build: observed,
      pollCount: 1,
      transientFailureCount: 0,
      elapsedSeconds: 10,
      timedOut: true,
      outcome: "timeout",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
  });

  test("times out with no observation before the third transient failure", async () => {
    const { service, calls } = createWaitHarness([transientError("network")]);
    const result = await service.wait(42, 700, { intervalSeconds: 10, timeoutSeconds: 10 });
    assert.equal(result.build, null);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.pollCount, 1);
    assert.equal(result.transientFailureCount, 1);
    assert.equal(calls.length, 1);
  });

  test("treats a completion response received after the deadline as timeout", async () => {
    const { service, calls } = createWaitHarness([
      ({ clock }) => {
        clock.value += 10_001;
        return build({ result: "succeeded" });
      },
    ]);
    const result = await service.wait(42, 700, { timeoutSeconds: 10 });
    assert.equal(result.outcome, "timeout");
    assert.equal(result.build, null);
    assert.equal(result.pollCount, 1);
    assert.equal(result.transientFailureCount, 0);
    assert.equal(calls[0].options.timeoutMs, 10_000);
  });

  test("counts attempts, keeps cumulative failures, and resets the consecutive count after an observation", async () => {
    const warningEvents = [];
    const errors = Array.from({ length: 4 }, () => transientError("network"));
    const { service } = createWaitHarness([
      errors[0],
      errors[1],
      build({ status: "inProgress", result: undefined }),
      errors[2],
      errors[3],
      build({ result: "succeeded" }),
    ]);
    const result = await service.wait(42, 700, {
      intervalSeconds: 10,
      timeoutSeconds: 100,
      onProgress(event) {
        if (event.type === "transient-warning") warningEvents.push(event);
      },
    });
    assert.equal(result.pollCount, 6);
    assert.equal(result.transientFailureCount, 4);
    assert.deepEqual(warningEvents.map(({ attempt, consecutiveFailureCount }) => [attempt, consecutiveFailureCount]), [
      [1, 1], [2, 2], [4, 1], [5, 2],
    ]);
  });

  test("throws a sanitized operational error on the third consecutive transient failure", async () => {
    const hostile = new AzureRequestError("bad\u001b[31m\u202E detail", "network");
    const warnings = [];
    const { service, calls } = createWaitHarness([hostile, hostile, hostile]);
    await assert.rejects(
      service.wait(42, 700, {
        intervalSeconds: 10,
        timeoutSeconds: 100,
        onProgress: (event) => warnings.push(event),
      }),
      (error) => {
        assert.match(error.message, /stopped after 3 consecutive transient/);
        assert.doesNotMatch(error.message, /\u001b|\u202E/);
        return true;
      },
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(warnings.map(({ attempt, consecutiveFailureCount }) => [attempt, consecutiveFailureCount]), [
      [1, 1], [2, 2], [3, 3],
    ]);
  });

  test("classifies network, timeout, 408, 429, and 5xx errors as transient", async () => {
    const cases = [
      transientError("network"),
      transientError("timeout"),
      transientError("http", 408),
      transientError("http", 429),
      transientError("http", 500),
      transientError("http", 503),
      transientError("http", 599),
    ];
    for (const candidate of cases) {
      const { service } = createWaitHarness([candidate, build({ result: "succeeded" })]);
      const result = await service.wait(42, 700, { intervalSeconds: 10, timeoutSeconds: 30 });
      assert.equal(result.outcome, "succeeded");
      assert.equal(result.transientFailureCount, 1);
      assert.equal(result.pollCount, 2);
    }
  });

  test("fails immediately for non-transient HTTP and response errors", async () => {
    for (const candidate of [
      transientError("http", 401),
      transientError("http", 403),
      transientError("http", 404),
      transientError("response"),
    ]) {
      const { service, calls, sleeps } = createWaitHarness([candidate]);
      await assert.rejects(service.wait(42, 700), (error) => error === candidate);
      assert.equal(calls.length, 1);
      assert.deepEqual(sleeps, []);
    }
  });

  test("schedules from attempt completion and honors HTTP Retry-After with five-minute heartbeats", async () => {
    const events = [];
    const scheduling = createWaitHarness([
      ({ clock }) => {
        clock.value += 2_000;
        return build({ status: "inProgress", result: undefined });
      },
      build({ result: "succeeded" }),
    ]);
    await scheduling.service.wait(42, 700, { intervalSeconds: 10, timeoutSeconds: 30 });
    assert.deepEqual(scheduling.calls.map(({ at }) => at), [0, 12_000]);

    const retryAfter = createWaitHarness([
      transientError("http", 429, 700_000),
      build({ result: "succeeded" }),
    ]);
    const result = await retryAfter.service.wait(42, 700, {
      intervalSeconds: 10,
      timeoutSeconds: 1_000,
      onProgress: (event) => events.push(event),
    });
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(retryAfter.calls.map(({ at }) => at), [0, 700_000]);
    assert.deepEqual(retryAfter.sleeps.map(({ milliseconds }) => milliseconds), [300_000, 300_000, 100_000]);
    assert.equal(events.filter(({ type }) => type === "heartbeat").length, 2);
    assert.equal(events.filter(({ type }) => type === "transient-warning")[0].retryAfterMs, 700_000);
  });

  test("clips Retry-After sleep and request timeout to the overall deadline", async () => {
    const { service, calls, sleeps } = createWaitHarness([
      transientError("http", 429, 60_000),
    ]);
    const result = await service.wait(42, 700, { intervalSeconds: 10, timeoutSeconds: 10 });
    assert.equal(result.outcome, "timeout");
    assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeoutMs, 10_000);
  });

  test("cancels promptly during an injected sleep", async () => {
    const controller = new AbortController();
    let sleepStarted = false;
    const azure = {
      async request() { return build({ status: "inProgress", result: undefined }); },
      async requestWithMetadata() { throw new Error("unexpected"); },
    };
    const sleep = () => new Promise(() => {
      sleepStarted = true;
    });
    const service = createBuildService({
      azure,
      ctx,
      pullRequests: createPullRequestStub().service,
      now: () => 0,
      sleep,
    });
    const waiting = service.wait(42, 700, { intervalSeconds: 10, signal: controller.signal });
    while (!sleepStarted) await Promise.resolve();
    controller.abort();
    await assert.rejects(waiting, (error) => error.kind === "abort");
  });

  test("cancels the active request through the caller signal", async () => {
    const controller = new AbortController();
    let requestStarted = false;
    const azure = {
      request(_url, options) {
        requestStarted = true;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new AzureRequestError("request aborted", "abort")), { once: true });
        });
      },
      async requestWithMetadata() { throw new Error("unexpected"); },
    };
    const service = createBuildService({
      azure,
      ctx,
      pullRequests: createPullRequestStub().service,
      now: () => 0,
    });
    const waiting = service.wait(42, 700, { signal: controller.signal });
    while (!requestStarted) await Promise.resolve();
    controller.abort();
    await assert.rejects(waiting, (error) => error.kind === "abort");
  });

  test("rejects wrong IDs, association changes, and missing/none/unknown statuses immediately", async () => {
    const changedAssociation = createWaitHarness([
      build({ status: "inProgress", result: undefined }),
      build({ repository: { id: "other", type: "TfsGit" } }),
    ]);
    await assert.rejects(
      changedAssociation.service.wait(42, 700, { intervalSeconds: 10 }),
      /repository ID/,
    );
    assert.equal(changedAssociation.calls.length, 2);

    const cases = [
      [build({ id: 701 }), /expected 700/],
      [build({ repository: { id: "other", type: "TfsGit" } }), /repository ID/],
      [build({ repository: { id: "repo-id", type: "GitHub" } }), /repository type/],
      [build({ reason: "manual" }), /reason/],
      [build({ sourceBranch: "refs\/pull\/99\/merge" }), /source branch/],
      [build({ status: undefined }), /no build status/],
      [build({ status: null }), /no build status/],
      [build({ status: "none" }), /unknown build status none/],
      [build({ status: "queued" }), /unknown build status queued/],
    ];
    for (const [candidate, expected] of cases) {
      const { service, calls } = createWaitHarness([candidate]);
      await assert.rejects(service.wait(42, 700), expected);
      assert.equal(calls.length, 1);
    }
  });

  test("de-duplicates unchanged progress states and sanitizes all human wait text", async () => {
    const events = [];
    const hostilePr = pullRequest({ title: "widgets\u001b[31m\u202E" });
    const { service } = createWaitHarness([
      build({ status: "inProgress", result: undefined }),
      build({ status: "INPROGRESS", result: undefined }),
      build({ status: "postponed", result: "odd\u001b[31m\u202E" }),
      build({ status: "completed", result: "failed\u202E" }),
    ], { resolvedPr: hostilePr });
    const result = await service.wait(42, 700, {
      intervalSeconds: 10,
      timeoutSeconds: 40,
      onProgress: (event) => events.push(event),
    });
    const states = events.filter(({ type }) => type === "state");
    assert.deepEqual(states.map(({ change, status }) => [change, status]), [
      ["initial", "inProgress"],
      ["changed", "postponed"],
      ["changed", "completed"],
    ]);
    const formattedProgress = service.formatWaitProgress({
      ...states[1],
      status: "bad\u001b[31m\u202E",
      result: "bad\u001b[0m",
      build: build({ status: "bad\u001b[31m\u202E", result: "bad\u001b[0m" }),
    });
    const formattedResult = service.formatWaitResult(result);
    assert.doesNotMatch(formattedProgress, /\u001b|\u202E/);
    assert.doesNotMatch(formattedResult, /\u001b|\u202E/);
    assert.match(formattedProgress, /PR #42, build 700.*status|PR #42, build 700.*state/);
    assert.match(formattedResult, /outcome unknown/);

    for (const outcome of ["partiallySucceeded", "failed", "canceled", "unknown"]) {
      const failureText = service.formatWaitResult({
        ...result,
        build: build({ result: outcome }),
        outcome,
      });
      assert.match(failureText, /pr\.sh build show --pr 42 --build 700/);
    }
    const timeoutText = service.formatWaitResult({
      ...result,
      build: null,
      timedOut: true,
      outcome: "timeout",
    });
    assert.match(timeoutText, /timed out/);
  });
});
