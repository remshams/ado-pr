import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { latestReviewActivity } from "./review-activity.ts";

function latest(threads, userId) {
	return latestReviewActivity(threads, userId)?.toISOString();
}

const me = "user-1";

function comment(publishedDate, extra = {}) {
	return {
		id: 1,
		author: { id: me, displayName: "Ada" },
		content: "Looks good",
		commentType: "text",
		publishedDate,
		...extra,
	};
}

function thread(comments, extra = {}) {
	return { id: 1, status: "active", comments, ...extra };
}

// Azure records votes as system comments, for example in a thread with
// properties.CodeReviewThreadType "VoteUpdate" and content "Ada voted 10".
function voteThread(publishedDate, content = "Ada voted 10") {
	return thread([comment(publishedDate, { commentType: "system", content })], {
		properties: {
			CodeReviewThreadType: { $type: "System.String", $value: "VoteUpdate" },
		},
	});
}

describe("latest review activity", () => {
	test("returns the newest of the user's comments and replies", () => {
		assert.equal(
			latest(
				[
					thread([
						comment("2026-10-20T10:00:00Z"),
						comment("2026-10-22T10:00:00Z", { author: { id: "other" } }),
					]),
					thread([
						comment("2026-10-19T10:00:00Z", { author: { id: "other" } }),
						comment("2026-10-21T09:00:00.123Z", { commentType: undefined }),
					]),
				],
				me,
			),
			"2026-10-21T09:00:00.123Z",
		);
	});

	test("counts a vote entry newer than the user's comments", () => {
		assert.equal(
			latest(
				[thread([comment("2026-10-20T10:00:00Z")]), voteThread("2026-10-23")],
				me,
			),
			"2026-10-23T00:00:00.000Z",
		);
	});

	test("counts any system entry in a vote thread", () => {
		assert.equal(
			latest(
				[
					thread([comment("2026-10-20T10:00:00Z")]),
					voteThread("2026-10-23T10:00:00Z", "Ada reset their vote"),
				],
				me,
			),
			"2026-10-23T10:00:00.000Z",
		);
	});

	test("matches vote wording when the thread has no vote property", () => {
		for (const content of [
			"Ada voted -5",
			"Ada approved the pull request",
			"Ada approved with suggestions",
			"Ada rejected the pull request",
			"Ada is waiting for the author",
		]) {
			const entry = comment("2026-10-23T10:00:00Z", {
				commentType: "system",
				content,
			});
			assert.equal(
				latest([thread([entry])], me),
				"2026-10-23T10:00:00.000Z",
				content,
			);
		}
	});

	test("ignores other system entries, other voters and deleted activity", () => {
		assert.equal(
			latest(
				[
					thread([
						comment("2026-10-24T10:00:00Z", {
							commentType: "system",
							content: "Ada updated the source branch",
						}),
						comment("2026-10-24T11:00:00Z", { isDeleted: true }),
						comment("2026-10-24T12:00:00Z", { commentType: "codeChange" }),
						comment("not a date"),
						comment(undefined),
					]),
					thread([comment("2026-10-25T10:00:00Z")], { isDeleted: true }),
					thread([
						comment("2026-10-25T11:00:00Z", {
							commentType: "system",
							content: "Bob voted 10",
							author: { id: "other" },
						}),
					]),
					thread([comment("2026-10-20T10:00:00Z")]),
					thread(
						[
							comment("2026-10-26T10:00:00Z", {
								commentType: "system",
								content: undefined,
							}),
							comment("2026-10-26T11:00:00Z", { author: undefined }),
						],
						{ properties: { CodeReviewVoteResult: { $value: "10" } } },
					),
					thread([]),
				],
				me,
			),
			"2026-10-20T10:00:00.000Z",
		);
	});

	test("returns undefined without activity by the user", () => {
		assert.equal(
			latest(
				[thread([comment("2026-10-20", { author: { id: "other" } })])],
				me,
			),
			undefined,
		);
		assert.equal(latest([], me), undefined);
	});

	test("normalises the cutoff to a date", () => {
		const cutoff = latestReviewActivity(
			[thread([comment("2026-10-20T12:00:00+02:00")])],
			me,
		);
		assert.ok(cutoff instanceof Date);
		assert.equal(cutoff.toISOString(), "2026-10-20T10:00:00.000Z");
	});

	test("counts a vote thread whose voter property names the user", () => {
		const byOther = { author: { id: "service" } };
		const vote = (date, voter, extra = {}) =>
			thread(
				[comment(date, { ...byOther, commentType: "system", content: "x" })],
				{
					properties: {
						CodeReviewThreadType: { $value: "VoteUpdate" },
						CodeReviewVotedByIdentity: { $value: voter },
					},
					...extra,
				},
			);
		assert.equal(
			latest([vote("2026-10-21T10:00:00Z", me)], me),
			"2026-10-21T10:00:00.000Z",
		);
		const unauthored = vote("2026-10-21T11:00:00Z", me);
		delete unauthored.comments[0].author;
		assert.equal(latest([unauthored], me), "2026-10-21T11:00:00.000Z");
		assert.equal(
			latest(
				[vote("2026-10-22T10:00:00Z", "1", { identities: { 1: { id: me } } })],
				me,
			),
			"2026-10-22T10:00:00.000Z",
		);
		assert.equal(
			latest(
				[
					vote("2026-10-23T10:00:00Z", "1", {
						identities: { 1: { id: "other" } },
					}),
					vote("2026-10-24T10:00:00Z", "other"),
					vote("2026-10-24T11:00:00Z", "2", {
						identities: { 1: { id: me } },
					}),
					thread(
						[
							comment("2026-10-25T10:00:00Z", {
								...byOther,
								commentType: "system",
							}),
						],
						{ properties: { CodeReviewThreadType: { $value: "VoteUpdate" } } },
					),
				],
				me,
			),
			undefined,
		);
	});

	test("ignores a text comment by someone else in the user's vote thread", () => {
		assert.equal(
			latest(
				[
					thread(
						[comment("2026-10-21T10:00:00Z", { author: { id: "other" } })],
						{
							properties: { CodeReviewVotedByIdentity: { $value: me } },
						},
					),
				],
				me,
			),
			undefined,
		);
	});
});
