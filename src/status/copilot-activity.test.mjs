import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { latestCopilotActivity } from "./copilot-activity.ts";

function system(content, publishedDate, overrides = {}) {
	return {
		id: 1,
		comments: [{ id: 1, content, commentType: "system", publishedDate }],
		...overrides,
	};
}

describe("latestCopilotActivity", () => {
	test("reports none without threads or Copilot entries", () => {
		assert.deepEqual(latestCopilotActivity([]), { state: "none" });
		assert.deepEqual(
			latestCopilotActivity([
				system("Policy status updated", "2026-10-20T09:00:00Z"),
				system("Build validation queued", "2026-10-20T09:00:00Z"),
			]),
			{ state: "none" },
		);
	});

	test("reports a requested review with its date", () => {
		assert.deepEqual(
			latestCopilotActivity([
				system(
					"Copilot balanced review requested by branch policy.",
					"2026-10-20T10:00:00Z",
				),
			]),
			{ state: "requested", date: "2026-10-20T10:00:00Z" },
		);
	});

	test("reports a completed review with its date", () => {
		assert.deepEqual(
			latestCopilotActivity([
				system("Copilot code review completed", "2026-10-20T10:05:00Z"),
			]),
			{ state: "completed", date: "2026-10-20T10:05:00Z" },
		);
	});

	test("takes the newest entry regardless of thread order", () => {
		const requested = system(
			"Copilot balanced review requested by branch policy.",
			"2026-10-21T08:00:00Z",
		);
		const completed = system(
			"Copilot code review completed",
			"2026-10-20T10:05:00Z",
		);
		for (const threads of [
			[completed, requested],
			[requested, completed],
		]) {
			assert.deepEqual(latestCopilotActivity(threads), {
				state: "requested",
				date: "2026-10-21T08:00:00Z",
			});
		}
	});

	test("reports unknown wording that is newer than a requested entry as other", () => {
		const requested = system(
			"Copilot balanced review requested by branch policy.",
			"2026-10-20T10:00:00Z",
		);
		const cancelled = system(
			"  Copilot code review cancelled\n",
			"2026-10-20T10:30:00Z",
		);
		for (const threads of [
			[requested, cancelled],
			[cancelled, requested],
		]) {
			assert.deepEqual(latestCopilotActivity(threads), {
				state: "other",
				text: "Copilot code review cancelled",
				date: "2026-10-20T10:30:00Z",
			});
		}
	});

	test("lets a newer requested entry replace unknown wording", () => {
		assert.deepEqual(
			latestCopilotActivity([
				system("Copilot code review failed", "2026-10-20T10:00:00Z"),
				system(
					"Copilot balanced review requested by branch policy.",
					"2026-10-20T11:00:00Z",
				),
			]),
			{ state: "requested", date: "2026-10-20T11:00:00Z" },
		);
	});

	test("ignores ordinary comments, deleted entries and system entries about other things", () => {
		const text = {
			id: 2,
			comments: [
				{
					id: 2,
					content: "Copilot review completed, please check",
					commentType: "text",
					publishedDate: "2026-10-22T10:00:00Z",
				},
			],
		};
		const deletedComment = system(
			"Copilot code review completed",
			"2026-10-22T11:00:00Z",
		);
		deletedComment.comments[0].isDeleted = true;
		const deletedThread = system(
			"Copilot code review completed",
			"2026-10-22T12:00:00Z",
			{ isDeleted: true },
		);
		const unrelated = system("Policy status updated", "2026-10-22T13:00:00Z");
		assert.deepEqual(
			latestCopilotActivity([text, deletedComment, deletedThread, unrelated]),
			{ state: "none" },
		);
	});

	test("keeps a dated entry over an undated one and tolerates comments without content", () => {
		const undated = system("Copilot code review completed", undefined);
		const dated = system(
			"Copilot balanced review requested by branch policy.",
			"2026-10-20T10:00:00Z",
		);
		const empty = { id: 3, comments: [{ id: 3, commentType: "system" }] };
		assert.deepEqual(latestCopilotActivity([dated, undated, empty]), {
			state: "requested",
			date: "2026-10-20T10:00:00Z",
		});
		assert.deepEqual(latestCopilotActivity([undated]), {
			state: "completed",
			date: undefined,
		});
	});
});
