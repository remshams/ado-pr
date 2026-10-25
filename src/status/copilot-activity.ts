import type { CommentThread } from "../comments/threads.ts";

export interface CopilotActivity {
	state: "completed" | "requested" | "none";
	date?: string;
}

/** Azure's wording, for example "Copilot code review completed". Best effort: adjust after live testing. */
const COPILOT_REVIEW = /\bcopilot\b[\s\S]*\breview\b/i;
const COMPLETED = /\bcompleted\b/i;
const REQUESTED = /\brequested\b/i;

function copilotState(content: string): "completed" | "requested" | undefined {
	if (!COPILOT_REVIEW.test(content)) return undefined;
	if (COMPLETED.test(content)) return "completed";
	if (REQUESTED.test(content)) return "requested";
	return undefined;
}

function timestamp(date: string | undefined): number {
	const parsed = Date.parse(date ?? "");
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Finds the newest system comment that mentions a Copilot review, as Azure records it in the PR
 * timeline. Copilot never votes, so the timeline is the only signal. The date is omitted when Azure
 * sent none.
 */
export function latestCopilotActivity(
	threads: CommentThread[],
): CopilotActivity {
	let latest: CopilotActivity = { state: "none" };
	let latestTime = Number.NEGATIVE_INFINITY;
	for (const thread of threads) {
		if (thread.isDeleted) continue;
		for (const comment of thread.comments) {
			if (comment.isDeleted || comment.commentType !== "system") continue;
			const state = copilotState(comment.content ?? "");
			if (state === undefined) continue;
			const time = timestamp(comment.publishedDate);
			if (latest.state !== "none" && time < latestTime) continue;
			latest = { state, date: comment.publishedDate };
			latestTime = time;
		}
	}
	return latest;
}
