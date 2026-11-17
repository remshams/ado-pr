import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	build,
	buildBase,
	pullRequest,
	setup,
	showResponses,
} from "../../tests/support/builds.mjs";

describe("build diagnosis", () => {
	test("shows a historical build, orders its graph, expands every problem result, and deduplicates logs", async (t) => {
		const sharedLog = { id: 17, type: "Container", lineCount: 450 };
		const records = [
			{
				id: "task-b",
				parentId: "job",
				type: "Task",
				name: "Tests",
				order: 2,
				state: "completed",
				result: "failed",
				attempt: 1,
				issues: [{ type: "error", category: "test", message: "2 failed" }],
				log: { id: 17 },
			},
			{
				id: "stage",
				type: "Stage",
				name: "Validate",
				order: 1,
				state: "completed",
				result: "succeeded",
				attempt: 1,
			},
			{
				id: "task-a",
				parentId: "job",
				type: "Task",
				name: "Compile",
				order: 1,
				state: "completed",
				result: "succeededWithIssues",
				attempt: 2,
				issues: [{ type: "warning", message: "types" }],
				log: { id: 17 },
			},
			{
				id: "job",
				parentId: "stage",
				type: "Job",
				name: "Linux",
				order: 1,
				state: "completed",
				result: "failed",
				attempt: 1,
			},
			{
				id: "canceled",
				type: "Task",
				name: "Cleanup",
				order: 3,
				state: "completed",
				result: "canceled",
				attempt: 1,
			},
			{
				id: "abandoned",
				type: "Task",
				name: "Publish",
				order: 4,
				state: "completed",
				result: "abandoned",
				attempt: 1,
			},
			{
				id: "success",
				type: "Task",
				name: "Skipped expansion",
				order: 5,
				state: "completed",
				result: "succeeded",
				attempt: 1,
				log: { id: 99 },
			},
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
		assert.equal(
			result.problemRecords[1].logText,
			"\u001b[31merror\u001b[0m\nordinary\tline\n",
		);
		assert.deepEqual(result.problemRecords[1].logRange, {
			startLine: 250,
			endLine: 450,
		});
		assert.equal(
			result.problemRecords[2].logText,
			result.problemRecords[1].logText,
		);
		assert.equal(result.problemRecords[0].noLog, true);
		assert.equal(result.problemRecords[3].noLog, true);
		assert.equal(result.problemRecords[4].noLog, true);
		assert.equal(service.hasLogErrors(result), false);
		assert.deepEqual(
			calls.map(({ url }) => url),
			[
				`${buildBase}/700?api-version=7.1`,
				`${buildBase}/700/timeline?api-version=7.1`,
				`${buildBase}/700/logs?api-version=7.1`,
				`${buildBase}/700/logs/17?startLine=250&endLine=450&api-version=7.1`,
			],
		);
		assert.equal(calls[3].headers.accept, "text/plain");

		const human = service.formatShow(result);
		assert.match(human, /PR: #42 \(history; stale\)/);
		assert.match(
			human,
			/- Stage\/Validate:[\s\S]* {2}- Job\/Linux:[\s\S]* {4}- Task\/Compile/,
		);
		assert.match(human, /Problem 1: Job\/Linux \[failed\]/);
		assert.match(human, /error\nordinary\tline/);
		assert.doesNotMatch(human, /\u001b/);
	});

	test("a matching build on a completed PR is still classified as historical", async (t) => {
		const completed = pullRequest({ status: "completed" });
		const { service } = setup(t, showResponses(), {
			resolveValues: [completed],
		});
		const result = await service.show(42, 700);
		assert.equal(result.current, false);
		assert.match(service.formatShow(result), /PR: #42 \(history; stale\)/);
	});

	test("full logs omit bounds and lineCount while retaining raw JSON-compatible text", async (t) => {
		const records = [
			{
				id: "problem",
				type: "Task",
				name: "Lint",
				result: "failed",
				log: { id: 2 },
			},
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
		assert.equal(
			result.problemRecords[0].logText,
			"top\n\u001b]0;hostile\u0007bottom\n",
		);
		assert.equal(calls[3].url, `${buildBase}/700/logs/2?api-version=7.1`);
		assert.match(
			service.formatShow(result),
			/FULL LOGS; potentially sensitive/,
		);
		assert.doesNotMatch(service.formatShow(result), /hostile/);
	});

	test("requests exact 200-line boundaries and represents a metadata-proven empty log without downloading", async (t) => {
		const records = [
			{ id: "short", result: "failed", log: { id: 1 } },
			{ id: "boundary", result: "failed", log: { id: 2 } },
			{ id: "long", result: "failed", log: { id: 3 } },
			{ id: "empty", result: "failed", log: { id: 4 } },
		];
		const { service, calls } = setup(
			t,
			showResponses({
				records,
				logs: [
					{ id: 1, lineCount: 199 },
					{ id: 2, lineCount: 200 },
					{ id: 3, lineCount: 201 },
					{ id: 4, lineCount: 0 },
				],
				texts: [{ body: "short" }, { body: "boundary" }, { body: "long" }],
			}),
		);

		const result = await service.show(42, 700);

		assert.deepEqual(
			result.problemRecords.map(({ logRange }) => logRange),
			[
				{ startLine: 0, endLine: 199 },
				{ startLine: 0, endLine: 200 },
				{ startLine: 1, endLine: 201 },
				{ startLine: 0, endLine: 0 },
			],
		);
		assert.equal(result.problemRecords[3].logText, "");
		assert.deepEqual(
			calls.slice(3).map(({ url }) => url),
			[
				`${buildBase}/700/logs/1?startLine=0&endLine=199&api-version=7.1`,
				`${buildBase}/700/logs/2?startLine=0&endLine=200&api-version=7.1`,
				`${buildBase}/700/logs/3?startLine=1&endLine=201&api-version=7.1`,
			],
		);
	});

	test("locally enforces the final-200-line and default byte limits", async (t) => {
		const records = [
			{
				id: "problem",
				type: "Task",
				name: "Lint",
				result: "failed",
				log: { id: 5 },
			},
		];
		const serverIgnoredRange = setup(
			t,
			showResponses({
				records,
				logs: [{ id: 5, lineCount: 300 }],
				texts: [
					{
						body: `${Array.from({ length: 250 }, (_value, index) => `line-${index}`).join("\n")}\n`,
					},
				],
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
		assert.match(
			partial.problemRecords[0].logError,
			/response body exceeded 2097152 bytes/,
		);
	});

	test("continues after unique log failures, shares errors, and sanitizes terminal controls", async (t) => {
		const records = [
			{
				id: "one",
				type: "Task",
				name: "One",
				result: "failed",
				log: { id: 1 },
			},
			{
				id: "shared",
				type: "Task",
				name: "Shared",
				result: "failed",
				log: { id: 1 },
			},
			{
				id: "two",
				type: "Task",
				name: "Two",
				result: "failed",
				log: { id: 2 },
			},
		];
		const { service, calls } = setup(
			t,
			showResponses({
				records,
				logs: [
					{ id: 1, lineCount: 3 },
					{ id: 2, lineCount: 2 },
				],
				texts: [
					{
						status: 503,
						statusText: "Unavailable",
						body: "\u001b[31mbad\u001b[0m",
					},
					{ body: "second log" },
				],
			}),
		);

		const result = await service.show(42, 700);

		assert.equal(calls.length, 5);
		assert.equal(service.hasLogErrors(result), true);
		assert.equal(result.problemRecords[0].logError.includes("\u001b"), false);
		assert.match(result.problemRecords[0].logError, /bad/);
		assert.equal(
			result.problemRecords[1].logError,
			result.problemRecords[0].logError,
		);
		assert.equal(result.problemRecords[2].logText, "second log");
	});

	test("fails before log text on unrelated builds, malformed timelines, missing metadata, and unbounded defaults", async (t) => {
		const unrelated = setup(t, [
			{ json: build({ repository: { id: "other", type: "TfsGit" } }) },
		]);
		await assert.rejects(
			unrelated.service.show(42, 700),
			/not associated.*repository ID/,
		);
		assert.equal(unrelated.calls.length, 1);

		const malformedTimeline = setup(t, [
			{ json: build() },
			{ json: { records: {} } },
		]);
		await assert.rejects(
			malformedTimeline.service.show(42, 700),
			/timeline\.records must be an array/,
		);
		assert.equal(malformedTimeline.calls.length, 2);

		const missingMetadata = setup(
			t,
			showResponses({
				records: [{ id: "p", result: "failed", log: { id: 9 } }],
				logs: [],
			}),
		);
		await assert.rejects(
			missingMetadata.service.show(42, 700),
			/references log 9.*did not contain it/,
		);
		assert.equal(missingMetadata.calls.length, 3);

		const noLineCount = setup(
			t,
			showResponses({
				records: [{ id: "p", result: "failed", log: { id: 9 } }],
				logs: [{ id: 9 }],
			}),
		);
		await assert.rejects(
			noLineCount.service.show(42, 700),
			/no lineCount metadata.*unbounded log/,
		);
		assert.equal(noLineCount.calls.length, 3);
	});

	test("timeline formatting is deterministic, includes orphan/cycle records once, and strips controls", async (t) => {
		const records = [
			{
				id: "root",
				parentId: null,
				type: "Stage",
				name: "Root",
				order: 0,
				result: "succeeded",
			},
			{
				id: "root-child",
				parentId: "ROOT",
				type: "Job",
				name: "Root Child",
				order: 1,
				result: "succeeded",
			},
			{
				id: "orphan",
				parentId: "missing",
				type: "Task",
				name: "\u001b[31mOrphan\u001b[0m",
				order: 2,
				result: "succeeded",
			},
			{
				id: "a",
				parentId: "B",
				type: "Stage",
				name: "A",
				order: 1,
				result: "succeeded",
			},
			{
				id: "b",
				parentId: "a",
				type: "Job",
				name: "B",
				order: 1,
				result: "succeeded",
			},
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
