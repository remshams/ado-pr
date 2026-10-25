import type { CommentThread } from "../comments/threads.ts";

export interface CopilotActivity {
	state: "completed" | "requested" | "none";
	date?: string;
}

/** Azure's wording, for example "Copilot code review completed". Best effort: adjust after live testing. */
const COPILOT_REVIEW = /\bcopilot\b[\s\S]*\breview\b/i;
const COMPLETED = /\bcompleted\b/i;
const REQUESTED = /\brequested\b/i;

interface CopilotEntry {
	state: "completed" | "requested";
	date: string | undefined;
	time: number;
}

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

function copilotEntries(threads: CommentThread[]): CopilotEntry[] {
	return threads
		.filter((thread) => !thread.isDeleted)
		.flatMap((thread) => thread.comments)
		.flatMap((comment) => {
			const state =
				comment.isDeleted || comment.commentType !== "system"
					? undefined
					: copilotState(comment.content ?? "");
			if (state === undefined) return [];
			return [
				{
					state,
					date: comment.publishedDate,
					time: timestamp(comment.publishedDate),
				},
			];
		});
}

/**
 * Finds the newest system comment that mentions a Copilot review, as Azure records it in the PR
 * timeline. Copilot never votes, so the timeline is the only signal. The date is omitted when Azure
 * sent none.
 */
export function latestCopilotActivity(
	threads: CommentThread[],
): CopilotActivity {
	let latest: CopilotEntry | undefined;
	for (const entry of copilotEntries(threads)) {
		if (latest === undefined || entry.time >= latest.time) latest = entry;
	}
	return latest === undefined
		? { state: "none" }
		: { state: latest.state, date: latest.date };
}
