import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockFetch } from "../../tests/test-helpers.mjs";
import { createAzureRequester } from "../shared/azure.ts";
import { createStatusService } from "./status.ts";

const ctx = {
	organization: "test-org",
	project: "test-project",
	repository: "test-repository",
};
const conflictsUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository/pullRequests/42/conflicts?$top=50&api-version=7.1-preview.1";

function pullRequest(overrides = {}) {
	return {
		pullRequestId: 42,
		title: "Add widgets",
		status: "active",
		isDraft: false,
		sourceRefName: "refs/heads/feature/widgets",
		lastMergeSourceCommit: { commitId: "head-1" },
		mergeStatus: "succeeded",
		reviewers: [{ id: "ada", displayName: "Ada", vote: 10 }],
		...overrides,
	};
}

function headBuild(overrides = {}) {
	return {
		association: "pr-merge",
		current: true,
		build: {
			id: 700,
			buildNumber: "20261020.1",
			status: "completed",
			result: "succeeded",
			sourceVersion: "head-1",
		},
		...overrides,
	};
}

function reviewThread(id, status = "active") {
	return {
		id,
		status,
		comments: [{ id, content: `comment ${id}`, commentType: "text" }],
	};
}

function copilotThread(content, publishedDate) {
	return {
		id: 90,
		comments: [{ id: 1, content, commentType: "system", publishedDate }],
	};
}

function setup(
	t,
	{
		pr = pullRequest(),
		build = headBuild(),
		threads = [],
		responses = [],
	} = {},
) {
	const { fetch, calls } = createMockFetch(t, responses);
	const stubCalls = [];
	const service = createStatusService({
		azure: createAzureRequester({ pat: "test-only-fake-pat", fetch }),
		ctx,
		pullRequests: {
			async resolve(requested) {
				stubCalls.push(["resolve", requested]);
				return pr;
			},
		},
		builds: {
			async headBuild(resolved) {
				stubCalls.push(["headBuild", resolved]);
				return build;
			},
		},
		threads: {
			async listAll(prId) {
				stubCalls.push(["listAll", prId]);
				return threads;
			},
		},
	});
	return { service, calls, stubCalls };
}

describe("status", () => {
	test("reports a clean PR without requesting conflicts", async (t) => {
		const { service, calls, stubCalls } = setup(t);
		const status = await service.get(42);
		assert.deepEqual(stubCalls, [
			["resolve", 42],
			["headBuild", pullRequest()],
			["listAll", 42],
		]);
		assert.equal(calls.length, 0);
		assert.equal(
			service.format(status),
			[
				"PR #42: Add widgets (active)",
				"https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
				"Head: head-1",
				"Build: succeeded - build 700 (20261020.1, pr-merge) validates the head",
				"Copilot review (best effort): none",
				"Unresolved threads: 0",
				"Merge status: succeeded",
				"Reviewers: Ada: approved",
			].join("\n"),
		);
	});

	test("marks the newest associated build stale when none validates the head", async (t) => {
		const build = headBuild({
			current: false,
			association: "branch-head",
			build: {
				id: 701,
				buildNumber: "20261019.3",
				status: "completed",
				result: "failed",
				sourceVersion: "old-head",
			},
		});
		const { service } = setup(t, { build });
		const text = service.format(await service.get(undefined));
		assert.match(
			text,
			/^Build: stale - no build validates head head-1; newest is build 701 \(20261019\.3, branch-head\) at old-head with failed$/m,
		);
	});

	test("reports the build status while it has no result yet", async (t) => {
		const build = headBuild();
		build.build.status = "inProgress";
		build.build.result = undefined;
		const { service } = setup(t, { build });
		assert.match(
			service.format(await service.get(42)),
			/^Build: inProgress - build 700/m,
		);
	});

	test("reports when no build is associated with the PR", async (t) => {
		const { service } = setup(t, { build: null });
		assert.match(
			service.format(await service.get(42)),
			/^Build: none \(no build is associated with this PR\)$/m,
		);
	});

	test("counts unresolved review threads and ignores system entries", async (t) => {
		const { service } = setup(t, {
			threads: [
				reviewThread(1),
				reviewThread(2, "pending"),
				reviewThread(3, "fixed"),
				copilotThread("Policy updated", "2026-10-20T10:00:00Z"),
			],
		});
		const status = await service.get(42);
		assert.equal(status.unresolvedThreads, 2);
		assert.match(service.format(status), /^Unresolved threads: 2$/m);
	});

	test("lists conflicts from Azure when the merge status reports them", async (t) => {
		const { service, calls } = setup(t, {
			pr: pullRequest({ mergeStatus: "conflicts" }),
			responses: [
				{
					json: {
						value: [
							{ conflictPath: "/src/a.ts", conflictType: "content" },
							{ conflictType: "delete" },
							{ conflictPath: "/src/b\u001b[31m.ts" },
						],
					},
				},
			],
		});
		const text = service.format(await service.get(42));
		assert.equal(calls[0].url, conflictsUrl);
		assert.match(
			text,
			/^Merge status: conflicts\nConflicts \(3\):\n {2}- \/src\/a\.ts \(content\)\n {2}- unknown path \(delete\)\n {2}- \/src\/b.*\.ts \(unknown\)\nReviewers:/m,
		);
		assert.doesNotMatch(text, /\u001b/);
	});

	test("still reports the conflicting merge status when the conflict list fails", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({ mergeStatus: "Conflicts" }),
			responses: [{ status: 400, statusText: "Bad Request", body: "nope" }],
		});
		const text = service.format(await service.get(42));
		assert.match(text, /^Merge status: Conflicts$/m);
		assert.match(text, /^Conflicts: could not be listed \(.*400/m);
	});

	test("reports the latest Copilot activity from the timeline", async (t) => {
		const cases = [
			[[], "none"],
			[
				[
					copilotThread(
						"Copilot balanced review requested by branch policy.",
						"2026-10-20T10:00:00Z",
					),
				],
				"requested (2026-10-20T10:00:00Z)",
			],
			[
				[
					copilotThread(
						"Copilot balanced review requested by branch policy.",
						"2026-10-20T10:00:00Z",
					),
					copilotThread(
						"Copilot code review completed",
						"2026-10-20T10:04:00Z",
					),
				],
				"completed (2026-10-20T10:04:00Z)",
			],
		];
		for (const [threads, expected] of cases) {
			const { service } = setup(t, { threads });
			const text = service.format(await service.get(42));
			assert.ok(
				text.includes(`Copilot review (best effort): ${expected}\n`),
				text,
			);
		}
	});

	test("shows draft PRs, unknown fields and reviewers without votes", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({
				isDraft: true,
				status: undefined,
				mergeStatus: undefined,
				lastMergeSourceCommit: undefined,
				reviewers: [],
			}),
		});
		assert.equal(
			service
				.format(await service.get(42))
				.split("\n")
				.join("|"),
			[
				"PR #42: Add widgets (unknown, draft)",
				"https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
				"Head: unknown",
				"Build: succeeded - build 700 (20261020.1, pr-merge) validates the head",
				"Copilot review (best effort): none",
				"Unresolved threads: 0",
				"Merge status: unknown",
				"Reviewers: none",
			].join("|"),
		);
	});
});
