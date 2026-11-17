import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	branchBuild,
	build,
	createPullRequestStub,
	ctx,
	headPr,
	listUrl,
	pullRequest,
	setup,
	showResponses,
} from "../../tests/support/builds.mjs";
import { createBuildService } from "./builds.ts";

describe("head-aware build selection", () => {
	test("classifies current and stale merge and source-branch builds", async (t) => {
		for (const [candidate, association, current] of [
			[build(), "pr-merge", true],
			[build({ sourceVersion: "old-merge" }), "pr-merge", false],
			[branchBuild(), "branch-head", true],
			[branchBuild({ sourceVersion: "old-head" }), "branch-head", false],
		]) {
			await t.test(`${association} ${current}`, async (t) => {
				const { service } = setup(t, showResponses({ shownBuild: candidate }), {
					resolveValues: [headPr()],
				});
				const result = await service.show(42, 700);
				assert.equal(result.current, current);
				assert.equal(result.association, association);
				const text = service.formatShow(result);
				assert.ok(
					text.includes(
						`Association: ${association}; commit: ${candidate.sourceVersion}`,
					),
				);
				assert.ok(text.includes(current ? "(current)" : "(history; stale)"));
			});
		}
	});

	test("rejects manual merge-ref runs for show, wait and retry", async (t) => {
		for (const operation of ["show", "wait", "retry"]) {
			await t.test(operation, async (t) => {
				const { service } = setup(t, [{ json: build({ reason: "manual" }) }], {
					resolveValues: [headPr()],
				});
				await assert.rejects(
					service[operation](42, 700),
					/not associated.*reason/,
				);
			});
		}
	});

	test("accepts any reason on the source branch and does not need a merge commit", async (t) => {
		for (const reason of ["manual", "individualCI", "pullRequest"]) {
			await t.test(reason, async (t) => {
				const { service } = setup(
					t,
					showResponses({ shownBuild: branchBuild({ reason }) }),
					{ resolveValues: [{ ...headPr(), lastMergeCommit: undefined }] },
				);
				assert.equal((await service.show(42, 700)).current, true);
			});
		}
	});

	test("missing head metadata never makes a branch build current", async (t) => {
		const { service } = setup(t, showResponses({ shownBuild: branchBuild() }));
		assert.equal((await service.show(42, 700)).current, false);
	});

	test("validates the head commit response shape", async (t) => {
		for (const lastMergeSourceCommit of ["head-1", {}, { commitId: "" }]) {
			const { service } = setup(t, [], {
				resolveValues: [pullRequest({ lastMergeSourceCommit })],
			});
			await assert.rejects(service.show(42, 700), /lastMergeSourceCommit/);
		}
	});

	test("latest chooses by queue time across both build kinds and ignores newer stale runs", async (t) => {
		for (const newestKind of ["pr-merge", "branch-head"]) {
			await t.test(newestKind, async (t) => {
				const merge = build({
					queueTime:
						newestKind === "pr-merge"
							? "2026-08-19T12:00:00Z"
							: "2026-08-17T10:00:00Z",
				});
				const branch = branchBuild({
					id: 701,
					queueTime: "2026-08-18T10:00:00Z",
				});
				const selected = newestKind === "pr-merge" ? merge : branch;
				const { service, calls } = setup(
					t,
					[
						{
							json: {
								value: [
									build({
										id: 702,
										sourceVersion: "stale",
										queueTime: "2026-08-20T10:00:00Z",
									}),
									merge,
									build({ id: 703, reason: "manual" }),
								],
							},
						},
						{ json: { value: [branch] } },
						...showResponses({ shownBuild: selected }).slice(1),
					],
					{ resolveValues: [headPr()] },
				);
				const result = await service.show(42, "latest");
				assert.equal(result.build.id, selected.id);
				assert.equal(result.association, newestKind);
				assert.equal(result.current, true);
				assert.equal(calls[0].url, listUrl());
				const branchUrl = new URL(calls[1].url);
				assert.equal(
					branchUrl.searchParams.get("branchName"),
					"refs/heads/feature/widgets",
				);
				assert.equal(branchUrl.searchParams.get("reasonFilter"), null);
				assert.equal(branchUrl.searchParams.get("repositoryId"), "Repo-ID");
				assert.equal(branchUrl.searchParams.get("repositoryType"), "TfsGit");
				assert.equal(
					branchUrl.searchParams.get("queryOrder"),
					"queueTimeDescending",
				);
				assert.equal(branchUrl.searchParams.get("$top"), "100");
			});
		}
	});

	test("latest pages both queries and excludes builds returned on unrelated refs", async (t) => {
		const branch = branchBuild({ id: 701 });
		const { service, calls } = setup(
			t,
			[
				{
					json: { value: [] },
					headers: { "x-ms-continuationtoken": "merge-next" },
				},
				{ json: { value: [branch, build({ sourceVersion: "old" })] } },
				{
					json: {
						value: [
							build(),
							branchBuild({ id: 702, sourceBranch: "refs/heads/other" }),
						],
					},
					headers: { "x-ms-continuationtoken": "branch-next" },
				},
				{ json: { value: [branch] } },
				...showResponses({ shownBuild: branch }).slice(1),
			],
			{ resolveValues: [headPr()] },
		);
		assert.equal((await service.show(42, "latest")).build.id, 701);
		assert.equal(
			new URL(calls[1].url).searchParams.get("continuationToken"),
			"merge-next",
		);
		assert.equal(
			new URL(calls[3].url).searchParams.get("continuationToken"),
			"branch-next",
		);
	});

	test("headBuild reports the newest validating build of either kind", async (t) => {
		const branch = branchBuild({ id: 701 });
		const { service, calls } = setup(
			t,
			[
				{ json: { value: [build({ sourceVersion: "old-merge" })] } },
				{ json: { value: [branch] } },
			],
			{ resolveValues: [headPr()] },
		);
		assert.deepEqual(await service.headBuild(headPr()), {
			association: "branch-head",
			current: true,
			build: branch,
		});
		assert.equal(calls.length, 2);
	});

	test("headBuild marks the newest associated build stale when none validates the head", async (t) => {
		const stale = build({ sourceVersion: "old-merge" });
		const { service } = setup(
			t,
			[{ json: { value: [stale] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		assert.deepEqual(await service.headBuild(headPr()), {
			association: "pr-merge",
			current: false,
			build: stale,
		});
	});

	test("headBuild treats a build on the head of a completed PR as current", async (t) => {
		const completed = { ...headPr(), status: "completed" };
		const branch = branchBuild({ id: 702 });
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [branch] } }],
			{ resolveValues: [completed] },
		);
		assert.deepEqual(await service.headBuild(completed), {
			association: "branch-head",
			current: true,
			build: branch,
		});
	});

	test("headBuild returns null when no associated build exists", async (t) => {
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		assert.equal(await service.headBuild(headPr()), null);
	});

	test("show latest returns the newest associated stale build with its commit", async (t) => {
		const stale = branchBuild({
			sourceVersion: "old-head",
			queueTime: "2026-08-19T10:00:00Z",
		});
		const { service } = setup(
			t,
			[
				{ json: { value: [build({ sourceVersion: "old-merge" })] } },
				{ json: { value: [stale] } },
				...showResponses({ shownBuild: stale }).slice(1),
			],
			{ resolveValues: [headPr()] },
		);
		const result = await service.show(42, "latest");
		assert.deepEqual(result.build, stale);
		assert.equal(result.current, false);
		assert.match(
			service.formatShow(result),
			/stale.*\nAssociation: branch-head; commit: old-head/,
		);
	});

	test("show latest fails clearly if neither query has associated builds", async (t) => {
		const { service } = setup(
			t,
			[{ json: { value: [] } }, { json: { value: [] } }],
			{ resolveValues: [headPr()] },
		);
		await assert.rejects(service.show(42, "latest"), /head commit HEAD-1/);
	});

	test("wait accepts explicit historical branch builds and selects current branch builds for latest", async (t) => {
		for (const selection of [700, "latest"]) {
			await t.test(String(selection), async (t) => {
				const candidate = branchBuild({
					result: "succeeded",
					sourceVersion: selection === "latest" ? "head-1" : "old-head",
				});
				const { service } = setup(
					t,
					[
						...(selection === "latest"
							? [{ json: { value: [] } }, { json: { value: [candidate] } }]
							: []),
						{ json: candidate },
					],
					{ resolveValues: [headPr()] },
				);
				const result = await service.wait(42, selection);
				assert.equal(result.outcome, "succeeded");
				assert.equal(result.association, "branch-head");
				assert.equal(result.buildId, 700);
				assert.equal(result.pollCount, 1);
				assert.match(
					service.formatWaitResult(result),
					/Association: branch-head/,
				);
			});
		}
	});

	test("retries a current branch build after refresh even without a merge commit", async (t) => {
		const candidate = branchBuild();
		const pr = { ...headPr(), lastMergeCommit: undefined };
		const { service, calls } = setup(
			t,
			[{ json: candidate }, { json: candidate }, { json: candidate }],
			{ resolveValues: [pr] },
		);
		assert.deepEqual(await service.retry(42, 700), candidate);
		assert.equal(calls[2].method, "PATCH");
		assert.match(service.formatRetry(candidate), /Association: branch-head/);
	});

	test("never retries stale branch builds or a head that changed during refresh", async (t) => {
		for (const changedDuringRefresh of [false, true]) {
			await t.test(String(changedDuringRefresh), async (t) => {
				const { service, calls } = setup(
					t,
					changedDuringRefresh
						? [{ json: branchBuild() }, { json: branchBuild() }]
						: [{ json: branchBuild({ sourceVersion: "old-head" }) }],
					{
						resolveValues: [headPr()],
						getValues: [
							pullRequest({ lastMergeSourceCommit: { commitId: "new-head" } }),
						],
					},
				);
				await assert.rejects(service.retry(42, 700), /historical/);
				assert.ok(calls.every(({ method }) => method === "GET"));
			});
		}
	});
});

describe("head metadata and latest selection contracts", () => {
	test("errors identify the exact missing or malformed PR field", async (t) => {
		for (const [overrides, field] of [
			[{ sourceRefName: undefined }, "sourceRefName"],
			[{ lastMergeCommit: {} }, "lastMergeCommit.commitId"],
			[{ lastMergeSourceCommit: {} }, "lastMergeSourceCommit.commitId"],
		]) {
			const { service } = setup(t, [], {
				resolveValues: [pullRequest(overrides)],
			});
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: pull request.${field} must be a non-empty string.`,
			});
		}
	});

	test("null commit metadata leaves associated builds stale", async (t) => {
		const { service } = setup(t, showResponses(), {
			resolveValues: [
				pullRequest({ lastMergeCommit: null, lastMergeSourceCommit: null }),
			],
		});
		const result = await service.show(42, 700);
		assert.equal(result.current, false);
		assert.equal(result.pullRequest.currentMergeCommit, null);
	});

	test("cancellation during latest selection stops before polling a build", async () => {
		const controller = new AbortController();
		let queries = 0;
		const service = createBuildService({
			ctx,
			pullRequests: createPullRequestStub().service,
			azure: {
				async requestWithMetadata(_url, options) {
					assert.equal(options.signal, controller.signal);
					assert.equal(options.timeoutMs, 30_000);
					assert.equal(options.maxResponseBytes, 16 * 1024 * 1024);
					queries += 1;
					if (queries === 2) controller.abort();
					return {
						data: { value: queries === 1 ? [build()] : [] },
						metadata: { headers: new Headers() },
					};
				},
				async request() {
					assert.fail("must not poll after cancellation");
				},
			},
			now: () => 0,
		});
		await assert.rejects(
			service.wait(42, "latest", { signal: controller.signal }),
			/abort/i,
		);
		assert.equal(queries, 2);
	});
});
