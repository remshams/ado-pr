import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { build, setup } from "../../tests/support/builds.mjs";

describe("build output contracts", () => {
	test("show prints empty diagnostics and missing build metadata", (t) => {
		const { service } = setup(t, []);
		assert.equal(
			service.formatShow({
				pullRequest: { id: 42 },
				current: false,
				association: "pr-merge",
				build: { id: 700 },
				timeline: { records: [] },
				problemRecords: [],
			}),
			[
				"Build 700/unknown — unknown",
				"PR: #42 (history; stale)",
				"Association: pr-merge; commit: unknown",
				"Status/result: unknown/unknown",
				"Queue/start/finish: unknown / unknown / unknown",
				"URL: unknown",
				"",
				"Timeline:",
				"(no stage/job/task records)",
				"",
				"Problem diagnostics (final 200 lines per log):",
				"(no problem records)",
			].join("\n"),
		);
	});

	test("show separates issue, missing-log, failed-log, and full-log sections", (t) => {
		const { service } = setup(t, []);
		const records = [
			{
				id: "task",
				type: "Task",
				name: "Lint\nchecks\t",
				result: "failed",
				state: "completed",
				attempt: 0,
				order: 2,
			},
			{
				id: "stage",
				type: "Stage",
				name: "Validate",
				result: "failed",
				state: "completed",
				order: 1,
			},
		];
		const result = {
			pullRequest: { id: 42 },
			current: true,
			association: "pr-merge",
			build: build(),
			timeline: { records },
			problemRecords: [
				{
					record: records[0],
					issues: [{ type: "error", category: "lint", message: "Fix imports" }],
					noLog: true,
				},
				{
					record: records[1],
					issues: [],
					logMode: "tail",
					logRange: { startLine: 1, endLine: 3 },
					logError: "unavailable\nnow",
				},
				{
					record: records[0],
					issues: [],
					logMode: "full",
					logText: "before\u001b[31mred\u001b[0mafter",
				},
			],
		};
		assert.equal(service.hasLogErrors(result), true);
		assert.equal(
			service.formatShow(result),
			[
				"Build 700/2026.8.18.1 — Widget CI",
				"PR: #42 (current)",
				"Association: pr-merge; commit: abcdef123",
				"Status/result: completed/failed",
				"Queue/start/finish: 2026-08-18T10:00:00Z / 2026-08-18T10:01:00Z / 2026-08-18T10:04:00Z",
				"URL: https://dev.azure.com/build/700",
				"",
				"Timeline:",
				"- Stage/Validate: state=completed, result=failed, attempt=unknown",
				"- Task/Lint checks : state=completed, result=failed, attempt=0",
				"",
				"Problem diagnostics (FULL LOGS; potentially sensitive):",
				"Problem 1: Task/Lint checks  [failed]",
				"Issues:",
				"- error/lint: Fix imports",
				"Log: (no log reference)",
				"",
				"Problem 2: Stage/Validate [failed]",
				"Issues: (none)",
				"Log (tail log (lines 1-3)): ERROR: unavailable now",
				"",
				"Problem 3: Task/Lint checks  [failed]",
				"Issues: (none)",
				"Log (full log (potentially sensitive)):",
				"beforeredafter",
			].join("\n"),
		);
	});

	test("retry validates its result and uses explicit unknown values", (t) => {
		const { service } = setup(t, []);
		assert.throws(() => service.formatRetry(build({ id: 0 })), {
			message:
				"Malformed Azure DevOps response: retry result build.id must be a positive safe integer.",
		});
		assert.equal(
			service.formatRetry(
				build({
					definition: null,
					_links: null,
					buildNumber: null,
					result: null,
				}),
			),
			[
				"Azure DevOps accepted the retry request for build 700/unknown.",
				"Association: pr-merge",
				"Returned status/result: completed/unknown",
				"URL: unknown",
			].join("\n"),
		);
	});

	test("wait gives failure inspection guidance only for unsuccessful outcomes", (t) => {
		const { service } = setup(t, []);
		const result = {
			pullRequest: { id: 42 },
			buildId: 700,
			build: { status: "completed", result: "failed" },
			elapsedSeconds: 12.25,
			pollCount: 3,
			transientFailureCount: 1,
			timedOut: false,
			outcome: "failed",
			validatesHead: true,
		};
		assert.equal(
			service.formatWaitResult(result),
			"build 700 for PR #42 finished with outcome failed.\nStatus/result: completed/failed; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown\nValidates head: yes\nInspect failure details with `pr.sh build show --pr 42 --build 700`.",
		);
		assert.equal(
			service.formatWaitResult({
				...result,
				outcome: "succeeded",
				build: { status: "completed", result: "succeeded" },
			}),
			"build 700 for PR #42 finished with outcome succeeded.\nStatus/result: completed/succeeded; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown\nValidates head: yes",
		);
		assert.equal(
			service.formatWaitResult({ ...result, timedOut: true, build: null }),
			"build 700 for PR #42 timed out. Latest status/result: unknown/unknown; 12.3s elapsed; 3 poll(s); 1 transient failure(s).\nAssociation: unknown",
		);
		assert.equal(
			service.formatWaitProgress({ ...result, type: "heartbeat", build: null }),
			"PR #42, build 700: still waiting at unknown/unknown; 12.3s elapsed; 3 poll(s); 1 transient failure(s).",
		);
	});

	test("wait reports a superseded build instead of failure guidance", (t) => {
		const { service } = setup(t, []);
		const result = {
			pullRequest: { id: 42, status: "active", currentHeadCommit: "head-2" },
			buildId: 700,
			build: { status: "completed", result: "canceled" },
			association: "pr-merge",
			elapsedSeconds: 0,
			pollCount: 1,
			transientFailureCount: 0,
			timedOut: false,
			outcome: "canceled",
			validatesHead: false,
			headBuildId: 702,
			alreadyCompleted: true,
		};
		const lines = service.formatWaitResult(result).split("\n");
		assert.equal(
			lines[0],
			"build 700 for PR #42 had already finished when the wait first read it, with outcome canceled.",
		);
		assert.equal(
			lines.at(-1),
			"Superseded: this build no longer validates the head of the pull request (commit head-2). Build 702 validates it; wait for it with `pr.sh build wait --latest --pr 42`.",
		);
		assert.equal(
			service
				.formatWaitResult({ ...result, headBuildId: null })
				.split("\n")
				.at(-1),
			"Superseded: this build no longer validates the head of the pull request (commit head-2). No build for it was found; wait for one with `pr.sh build wait --latest --pr 42`.",
		);
		assert.equal(
			service
				.formatWaitResult({
					...result,
					pullRequest: { ...result.pullRequest, status: "completed" },
				})
				.split("\n")
				.at(-1),
			"Inspect failure details with `pr.sh build show --pr 42 --build 700`.",
		);
	});
});
