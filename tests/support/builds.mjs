import { createBuildService } from "../../src/builds/builds.ts";
import { createAzureRequester } from "../../src/shared/azure.ts";
import { createMockFetch } from "../test-helpers.mjs";

export const ctx = {
	organization: "test org",
	project: "test/project",
	repository: "checkout-name",
};
const pat = "test-only-fake-pat";
export const buildBase =
	"https://dev.azure.com/test%20org/test%2Fproject/_apis/build/builds";

export function pullRequest(overrides = {}) {
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

export function build(overrides = {}) {
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

export function headPr() {
	return pullRequest({
		lastMergeSourceCommit: { commitId: "HEAD-1" },
		isDraft: true,
	});
}

export function branchBuild(overrides = {}) {
	return build({
		reason: "manual",
		sourceBranch: "refs/heads/feature/widgets",
		sourceVersion: "head-1",
		...overrides,
	});
}

export function createPullRequestStub(
	resolveValues = [pullRequest()],
	getValues = resolveValues,
	branchPullRequests = [],
) {
	let resolveIndex = 0;
	let getIndex = 0;
	const calls = [];
	return {
		calls,
		service: {
			async resolve(requestedPrId) {
				calls.push({ method: "resolve", requestedPrId });
				const value =
					resolveValues[Math.min(resolveIndex, resolveValues.length - 1)];
				resolveIndex += 1;
				return value;
			},
			async get(prId) {
				calls.push({ method: "get", prId });
				const value = getValues[Math.min(getIndex, getValues.length - 1)];
				getIndex += 1;
				return value;
			},
			async findActiveForBranch(branch) {
				calls.push({ method: "findActiveForBranch", branch });
				return branchPullRequests;
			},
		},
	};
}

export function setup(
	t,
	responses,
	{ resolveValues, getValues, branchPullRequests } = {},
) {
	const { fetch, calls } = createMockFetch(t, responses);
	const azure = createAzureRequester({ pat, fetch });
	const pullRequests = createPullRequestStub(
		resolveValues,
		getValues,
		branchPullRequests,
	);
	const service = createBuildService({
		azure,
		ctx,
		pullRequests: pullRequests.service,
	});
	return { service, calls, pullRequestCalls: pullRequests.calls };
}

export function requestShapes(calls) {
	return calls.map(({ url, method, body, headers }) => ({
		url,
		method,
		body,
		headers,
	}));
}

export function listUrl(continuation) {
	return (
		`${buildBase}?reasonFilter=pullRequest&branchName=refs%2Fpull%2F42%2Fmerge&` +
		`repositoryId=Repo-ID&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=100&` +
		(continuation === undefined
			? ""
			: `continuationToken=${encodeURIComponent(continuation)}&`) +
		"api-version=7.1"
	);
}

export function showResponses({
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
