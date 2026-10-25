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
const iterationsUrl =
	"https://dev.azure.com/test-org/test-project/_apis/git/repositories/test-repository/pullRequests/42/iterations?api-version=7.1";
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
		lastMergeCommit: { commitId: "merge-1" },
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

function policy(name, blocking, status) {
	const satisfied = ["approved", "notapplicable"].includes(
		status.toLowerCase(),
	);
	return { name, blocking, satisfied, status };
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
		iterations = [{ id: 1 }, { id: 3 }, { id: 2 }],
		policies = [],
		responses = [],
	} = {},
) {
	const { fetch, calls } = createMockFetch(t, [
		{ json: { value: iterations } },
		...responses,
	]);
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
			async policyEvaluations(resolved) {
				stubCalls.push(["policyEvaluations", resolved]);
				if (policies instanceof Error) throw policies;
				return policies;
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
			["policyEvaluations", pullRequest()],
		]);
		assert.deepEqual(
			calls.map((call) => call.url),
			[iterationsUrl],
		);
		assert.equal(
			service.format(status),
			[
				"PR #42: Add widgets (active)",
				"https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
				"Draft: no",
				"Head: head-1",
				"Merge commit: merge-1",
				"Iteration: 3",
				"Build: succeeded - build 700 (20261020.1, pr-merge) validates the head",
				"Copilot review (best effort): none",
				"Unresolved threads: 0",
				"Merge status: succeeded",
				"Blocked by: none",
				"Reviewers: Ada: approved",
			].join("\n"),
		);
	});

	test("returns a stable JSON shape without raw Azure objects", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({
				reviewers: [
					{ id: "ada", displayName: "Ada", vote: -10, isRequired: true },
					{ id: "bob", uniqueName: "bob@example.test" },
				],
			}),
			policies: [
				policy("Minimum number of reviewers", true, "rejected"),
				policy("Work item linking", false, "queued"),
			],
			threads: [
				reviewThread(1),
				copilotThread("Copilot code review completed", "2026-10-20T10:04:00Z"),
			],
		});
		assert.deepEqual(JSON.parse(JSON.stringify(await service.get(42))), {
			id: 42,
			title: "Add widgets",
			state: "active",
			draft: false,
			url: "https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
			headCommit: "head-1",
			mergeCommit: "merge-1",
			iteration: 3,
			build: {
				id: 700,
				number: "20261020.1",
				status: "completed",
				result: "succeeded",
				sourceVersion: "head-1",
				association: "pr-merge",
				validatesHead: true,
			},
			copilot: { state: "completed", text: null, date: "2026-10-20T10:04:00Z" },
			unresolvedThreads: 1,
			mergeStatus: "succeeded",
			conflicts: { kind: "none" },
			blockingPolicies: {
				kind: "listed",
				policies: [{ name: "Minimum number of reviewers", status: "rejected" }],
			},
			reviewers: [
				{ name: "Ada", vote: -10, voteLabel: "rejected", required: true },
				{
					name: "bob@example.test",
					vote: 0,
					voteLabel: "no vote",
					required: false,
				},
			],
		});
	});

	test("reports the highest iteration number, or unknown without iterations", async (t) => {
		const withIterations = setup(t, { iterations: [{ id: 2 }, { id: 11 }] });
		const status = await withIterations.service.get(42);
		assert.equal(status.iteration, 11);

		const without = setup(t, { iterations: [] });
		const empty = await without.service.get(42);
		assert.equal(empty.iteration, null);
		assert.match(without.service.format(empty), /^Iteration: unknown$/m);
	});

	test("reports an unknown iteration when the iterations cannot be read", async (t) => {
		const { fetch } = createMockFetch(t, [
			{ status: 503, statusText: "Unavailable", body: "later" },
		]);
		const service = createStatusService({
			azure: createAzureRequester({ pat: "test-only-fake-pat", fetch }),
			ctx,
			pullRequests: { resolve: async () => pullRequest() },
			builds: {
				headBuild: async () => null,
				policyEvaluations: async () => [],
			},
			threads: { listAll: async () => [] },
		});
		const status = await service.get(42);
		assert.equal(status.iteration, null);
		assert.match(service.format(status), /^Iteration: unknown$/m);
	});

	test("shows an unknown draft state when Azure sent none", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({ isDraft: undefined }),
		});
		const status = await service.get(42);
		assert.equal(status.draft, null);
		assert.match(service.format(status), /^Draft: unknown$/m);
	});

	test("shows the merge commit as unknown when Azure sent none", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({ lastMergeCommit: undefined }),
		});
		const status = await service.get(42);
		assert.equal(status.mergeCommit, null);
		assert.match(service.format(status), /^Merge commit: unknown$/m);
	});

	test("lists only blocking policies that are neither approved nor not applicable", async (t) => {
		const policies = [
			policy("Minimum number of reviewers", true, "rejected"),
			policy("Work item linking", true, "queued"),
			policy("Build", true, "running"),
			policy("Broken check", true, "Broken"),
			policy("Approved check", true, "approved"),
			policy("Skipped check", true, "notApplicable"),
			policy("Optional check", false, "rejected"),
		];
		const { service } = setup(t, { policies });
		const status = await service.get(42);
		assert.deepEqual(
			status.blockingPolicies.policies.map((policy) => policy.name),
			[
				"Minimum number of reviewers",
				"Work item linking",
				"Build",
				"Broken check",
			],
		);
		assert.match(
			service.format(status),
			/^Blocked by: Minimum number of reviewers \(rejected\), Work item linking \(queued\), Build \(running\), Broken check \(Broken\)$/m,
		);
	});

	test("sanitizes policy names in the Blocked by line", async (t) => {
		const { service } = setup(t, {
			policies: [policy("Evil\u001b[31m policy", true, "rejected")],
		});
		const text = service.format(await service.get(42));
		assert.doesNotMatch(text, /\u001b/);
		assert.match(text, /^Blocked by: Evil.* policy \(rejected\)$/m);
	});

	test("still reports the status when the policies cannot be listed", async (t) => {
		const { service } = setup(t, {
			policies: new Error("policy lookup denied"),
		});
		const status = await service.get(42);
		assert.deepEqual(status.blockingPolicies, {
			kind: "unavailable",
			error: "policy lookup denied",
		});
		assert.match(
			service.format(status),
			/^Blocked by: could not be listed \(policy lookup denied\)$/m,
		);
	});

	test("emits null for the missing Copilot text and date", async (t) => {
		const { service } = setup(t);
		const status = await service.get(42);
		assert.deepEqual(JSON.parse(JSON.stringify(status.copilot)), {
			state: "none",
			text: null,
			date: null,
		});
	});

	test("strips terminal controls from the policy error", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({ mergeStatus: "conflicts" }),
			policies: new Error("denied\u001b[31m by policy"),
			responses: [{ status: 400, statusText: "Bad Request", body: "nope" }],
		});
		const text = service.format(await service.get(42));
		assert.doesNotMatch(text, /\u001b/);
		assert.match(
			text,
			/^Blocked by: could not be listed \(denied.* by policy\)$/m,
		);
	});

	test("flags required reviewers", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({
				reviewers: [
					{ id: "ada", displayName: "Ada", vote: 10, isRequired: true },
					{ id: "bob", displayName: "Bob", vote: 0, isRequired: false },
				],
			}),
		});
		assert.match(
			service.format(await service.get(42)),
			/^Reviewers: Ada: approved \(required\), Bob: no vote$/m,
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
		const status = await service.get(42);
		const text = service.format(status);
		assert.deepEqual(status.conflicts.conflicts[0], {
			path: "/src/a.ts",
			type: "content",
		});
		assert.equal(calls[1].url, conflictsUrl);
		assert.match(
			text,
			/^Merge status: conflicts\nConflicts \(3\):\n {2}- \/src\/a\.ts \(content\)\n {2}- unknown path \(delete\)\n {2}- \/src\/b.*\.ts \(unknown\)\nBlocked by: none\nReviewers:/m,
		);
		assert.doesNotMatch(text, /\u001b/);
	});

	test("strips terminal controls from the title and reviewer names", async (t) => {
		const { service } = setup(t, {
			pr: pullRequest({
				title: "Add\u001b[31m widgets",
				reviewers: [{ id: "eve", displayName: "Eve\u001b[2J", vote: 10 }],
			}),
		});
		const text = service.format(await service.get(42));
		assert.doesNotMatch(text, /\u001b/);
		assert.match(text, /^PR #42: Add.*widgets \(active\)$/m);
		assert.match(text, /^Reviewers: Eve.*: approved$/m);
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

	test("prints unknown Copilot wording as sanitized text with its date", async (t) => {
		const requested = copilotThread(
			"Copilot balanced review requested by branch policy.",
			"2026-10-20T10:00:00Z",
		);
		const cancelled = {
			...copilotThread(
				"Copilot code review\u001b[31m cancelled\nby the author",
				"2026-10-20T10:30:00Z",
			),
			id: 91,
		};
		const { service } = setup(t, { threads: [requested, cancelled] });
		assert.match(
			service.format(await service.get(42)),
			/^Copilot review \(best effort\): "Copilot code review.* cancelled by the author" \(2026-10-20T10:30:00Z\)$/m,
		);
	});

	test("bounds long unknown Copilot wording", async (t) => {
		const { service } = setup(t, {
			threads: [
				copilotThread(
					`Copilot review ${"x".repeat(500)}`,
					"2026-10-20T10:30:00Z",
				),
			],
		});
		const line = service
			.format(await service.get(42))
			.split("\n")
			.find((entry) => entry.startsWith("Copilot review"));
		assert.ok(line.length < 200, line);
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
				"PR #42: Add widgets (unknown)",
				"https://dev.azure.com/test-org/test-project/_git/test-repository/pullrequest/42",
				"Draft: yes",
				"Head: unknown",
				"Merge commit: merge-1",
				"Iteration: 3",
				"Build: succeeded - build 700 (20261020.1, pr-merge) validates the head",
				"Copilot review (best effort): none",
				"Unresolved threads: 0",
				"Merge status: unknown",
				"Blocked by: none",
				"Reviewers: none",
			].join("|"),
		);
	});
});
