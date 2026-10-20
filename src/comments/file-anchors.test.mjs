import assert from "node:assert/strict";
import test from "node:test";

import { createAzureRequester } from "../shared/azure.ts";
import { createFileAnchorService } from "./file-anchors.ts";
import { createMockFetch } from "../../tests/test-helpers.mjs";

const ctx = {
	organization: "test-org",
	project: "test project",
	repository: "test/repo",
};
const pat = "test-only-pat";
const baseUrl =
	"https://dev.azure.com/test-org/test%20project/_apis/git/repositories/test%2Frepo/pullRequests";

function setup(t, responses) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const service = createFileAnchorService({ azure, ctx });
	return { service, calls };
}

function iterationsUrl(prId) {
	return `${baseUrl}/${prId}/iterations?api-version=7.1`;
}

function changesUrl(prId, iterationId, skip = 0, top = 500) {
	return (
		`${baseUrl}/${prId}/iterations/${iterationId}/changes` +
		`?api-version=7.1&$top=${top}&$skip=${skip}`
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
	const { service, calls } = setup(t, [
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

	const anchor = await service.resolve(
		31,
		{ file: "src/file.ts" },
		service.createCache(),
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
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 8 }] } },
		{ json: { changeEntries: [] } },
	]);

	const anchor = await service.resolve(
		32,
		{ file: "/src/ranged.ts", line: 6, endLine: 14 },
		service.createCache(),
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
	assert.equal(
		Object.hasOwn(anchor.pullRequestThreadContext, "changeTrackingId"),
		false,
	);
	assertRequestUrls(calls, [iterationsUrl(32), changesUrl(32, 8)]);
});

test("uses the explicit start line as the default end line", async (t) => {
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 3 }] } },
		{
			json: {
				changeEntries: [
					{ changeTrackingId: 91, item: { path: "/one-line.ts" } },
				],
			},
		},
	]);

	const anchor = await service.resolve(
		33,
		{ file: "one-line.ts", line: 27 },
		service.createCache(),
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
	const { service, calls } = setup(t, [{ json: { value: [] } }]);

	await assert.rejects(
		service.resolve(404, { file: "missing.ts" }, service.createCache()),
		{
			message: "PR #404 has no iterations.",
		},
	);
	assertRequestUrls(calls, [iterationsUrl(404)]);
});

test("uses non-default server continuation values for the next page", async (t) => {
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 21 }] } },
		{
			json: {
				changeEntries: [{ changeTrackingId: 700, item: { path: "/other.ts" } }],
				nextSkip: 900,
				nextTop: 17,
			},
		},
		{
			json: {
				changeEntries: [
					{ changeTrackingId: 701, item: { path: "/target.ts" } },
				],
			},
		},
	]);

	const anchor = await service.resolve(
		34,
		{ file: "target.ts", line: 2 },
		service.createCache(),
	);

	assert.equal(anchor.pullRequestThreadContext.changeTrackingId, 701);
	assertRequestUrls(calls, [
		iterationsUrl(34),
		changesUrl(34, 21),
		changesUrl(34, 21, 900, 17),
	]);
});

test("stops when server continuation values indicate completion", async (t) => {
	const fullPage = Array.from({ length: 500 }, (_, index) => ({
		changeTrackingId: index + 1,
		item: { path: `/generated/file-${index}.ts` },
	}));
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 22 }] } },
		{ json: { changeEntries: fullPage, nextSkip: 0, nextTop: 0 } },
	]);

	const anchor = await service.resolve(
		36,
		{ file: "absent.ts" },
		service.createCache(),
	);

	assert.equal(
		Object.hasOwn(anchor.pullRequestThreadContext, "changeTrackingId"),
		false,
	);
	assertRequestUrls(calls, [iterationsUrl(36), changesUrl(36, 22)]);
});

test("falls back to fixed-size pagination when continuation fields are absent", async (t) => {
	const firstPage = Array.from({ length: 500 }, (_, index) => ({
		changeTrackingId: index + 1,
		item: { path: `/generated/file-${index}.ts` },
	}));
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 23 }] } },
		{ json: { changeEntries: firstPage } },
		{
			json: {
				changeEntries: [
					{ changeTrackingId: 702, item: { path: "/fallback-target.ts" } },
				],
			},
		},
	]);

	const anchor = await service.resolve(
		37,
		{ file: "fallback-target.ts" },
		service.createCache(),
	);

	assert.equal(anchor.pullRequestThreadContext.changeTrackingId, 702);
	assertRequestUrls(calls, [
		iterationsUrl(37),
		changesUrl(37, 23),
		changesUrl(37, 23, 500),
	]);
});

test("reuses pending promises for concurrent duplicate anchor lookups", async (t) => {
	const { service, calls } = setup(t, [
		{ json: { value: [{ id: 15 }] } },
		{
			json: {
				changeEntries: [{ changeTrackingId: 88, item: { path: "/shared.ts" } }],
			},
		},
	]);
	const cache = service.createCache();

	const [first, second] = await Promise.all([
		service.resolve(35, { file: "shared.ts", line: 4 }, cache),
		service.resolve(35, { file: "/shared.ts", line: 9 }, cache),
	]);

	assert.equal(first.pullRequestThreadContext.changeTrackingId, 88);
	assert.equal(second.pullRequestThreadContext.changeTrackingId, 88);
	assert.equal(first.threadContext.rightFileStart.line, 4);
	assert.equal(second.threadContext.rightFileStart.line, 9);
	assertRequestUrls(calls, [iterationsUrl(35), changesUrl(35, 15)]);
});

test("separates change-tracking cache keys by PR, iteration, and file", async (t) => {
	const { service, calls } = setup(t, [
		{
			json: {
				changeEntries: [{ changeTrackingId: 101, item: { path: "/a.ts" } }],
			},
		},
		{
			json: {
				changeEntries: [{ changeTrackingId: 102, item: { path: "/a.ts" } }],
			},
		},
		{
			json: {
				changeEntries: [{ changeTrackingId: 103, item: { path: "/a.ts" } }],
			},
		},
		{
			json: {
				changeEntries: [{ changeTrackingId: 104, item: { path: "/b.ts" } }],
			},
		},
	]);
	const cache = service.createCache();

	const results = await Promise.all([
		cache.getChangeTrackingId(41, 5, "/a.ts"),
		cache.getChangeTrackingId(42, 5, "/a.ts"),
		cache.getChangeTrackingId(41, 6, "/a.ts"),
		cache.getChangeTrackingId(41, 5, "/b.ts"),
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
	const { service, calls } = setup(t, [
		{
			status: 503,
			statusText: "Service Unavailable",
			body: "temporarily unavailable",
		},
	]);
	const cache = service.createCache();

	const first = cache.getIterationId(55);
	const second = cache.getIterationId(55);

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
