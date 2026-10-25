import type { CommentThread } from "./threads.ts";

type ThreadComment = CommentThread["comments"][number];

/**
 * Azure's vote entries read like "Ada voted 10" or "Ada approved the pull request". Best effort:
 * adjust after live testing.
 */
const VOTE_TEXT =
	/\bvoted\b|\b(?:approved|rejected)\b|\bwaiting for (?:the )?author\b/i;

function isVoteThread(thread: CommentThread): boolean {
	return thread.properties?.CodeReviewThreadType?.$value === "VoteUpdate";
}

/** The voter property holds the identity ID or, in some responses, a key into `identities`. */
function isVotedByUser(thread: CommentThread, userId: string): boolean {
	const voter = thread.properties?.CodeReviewVotedByIdentity?.$value;
	return voter === userId || thread.identities?.[String(voter)]?.id === userId;
}

function isVoteEntry(
	comment: ThreadComment,
	thread: CommentThread,
	userId: string,
): boolean {
	const byUser = comment.author?.id === userId || isVotedByUser(thread, userId);
	return (
		byUser && (isVoteThread(thread) || VOTE_TEXT.test(comment.content ?? ""))
	);
}

function isUsersReviewEntry(
	comment: ThreadComment,
	thread: CommentThread,
	userId: string,
): boolean {
	if (comment.isDeleted) return false;
	const type = comment.commentType ?? "text";
	if (type === "text") return comment.author?.id === userId;
	return type === "system" && isVoteEntry(comment, thread, userId);
}

/**
 * Finds when the user last reviewed a pull request: their newest text comment or vote entry. Azure
 * keeps no vote timestamp on reviewers, so votes come from the system entries it posts in the
 * threads. Deleted threads and comments don't count. Returns undefined when there is none.
 */
export function latestReviewActivity(
	threads: readonly CommentThread[],
	userId: string,
): Date | undefined {
	const times = threads
		.filter((thread) => !thread.isDeleted)
		.flatMap((thread) =>
			thread.comments.filter((comment) =>
				isUsersReviewEntry(comment, thread, userId),
			),
		)
		.map((comment) => Date.parse(String(comment.publishedDate)))
		.filter((time) => !Number.isNaN(time));
	return times.length === 0 ? undefined : new Date(Math.max(...times));
}
