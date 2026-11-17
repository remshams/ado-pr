import assert from "node:assert/strict";

import { createTempGitRepo } from "./test-helpers.mjs";

const origin = "https://dev.azure.com/acme/Test%20Project/_git/widgets";
export const apiBase =
	"https://dev.azure.com/acme/Test%20Project/_apis/git/repositories/widgets";
export const webBase =
	"https://dev.azure.com/acme/Test%20Project/_git/widgets/pullrequest";

export function createRepo(t, branch = "feature/dispatch") {
	return createTempGitRepo(t, { origin, branch });
}

export function request(call) {
	return { url: call.url, method: call.method, body: call.body };
}

export function semanticRequest(call) {
	return {
		url: call.url,
		method: call.method,
		body: typeof call.body === "string" ? JSON.parse(call.body) : call.body,
	};
}

export function assertSucceeded(result) {
	assert.equal(result.status, 0);
	assert.equal(result.stderr, "");
}

export function validationPr(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Build validation",
		status: "active",
		isDraft: true,
		sourceRefName: "refs/heads/feature/dispatch",
		repository: { id: "repo-id", name: "widgets" },
		lastMergeCommit: { commitId: "merge-1" },
		...overrides,
	};
}

export function validationBuild(overrides = {}) {
	return {
		id: 700,
		buildNumber: "20260818.1",
		status: "completed",
		result: "failed",
		reason: "pullRequest",
		sourceBranch: "refs/pull/42/merge",
		sourceVersion: "merge-1",
		queueTime: "2026-08-18T10:00:00Z",
		startTime: "2026-08-18T10:01:00Z",
		finishTime: "2026-08-18T10:03:00Z",
		repository: { id: "repo-id", name: "widgets", type: "TfsGit" },
		definition: { id: 9, name: "Widget CI" },
		_links: { web: { href: "https://dev.azure.com/acme/build/700" } },
		...overrides,
	};
}
