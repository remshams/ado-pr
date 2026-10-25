import type { AzureRequester } from "../shared/azure.ts";
import {
	API_VERSION,
	getAuthenticatedUserId,
	pullRequestApiUrl,
} from "../shared/azure.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";
import type { PullRequestService } from "./pull-requests.ts";

/** Reviewer votes a user can cast, with the values Azure DevOps stores. */
export const VOTES = {
	approve: 10,
	"approve-with-suggestions": 5,
	wait: -5,
	reject: -10,
	reset: 0,
} as const;
export type VoteName = keyof typeof VOTES;
export const VOTE_NAMES = Object.keys(VOTES) as VoteName[];

/** Matches a vote name case-insensitively and returns its canonical spelling. */
export function findVoteName(raw: string): VoteName | undefined {
	return VOTE_NAMES.find((name) => name === raw.toLowerCase());
}

export interface PullRequestStateChangeService {
	vote(requestedPrId: number | undefined, vote: VoteName): Promise<number>;
	abandon(requestedPrId: number | undefined): Promise<number>;
	reactivate(requestedPrId: number): Promise<number>;
}

/** Changes the authenticated user's vote on a pull request and abandons or reactivates it. */
export function createPullRequestStateChangeService({
	azure,
	ctx,
	pullRequests,
}: {
	azure: AzureRequester;
	ctx: AzureDevOpsRepoContext;
	pullRequests: Pick<PullRequestService, "resolveId">;
}): PullRequestStateChangeService {
	async function setStatus(
		prId: number,
		status: "abandoned" | "active",
	): Promise<number> {
		const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
		await azure.request(url, {
			method: "PATCH",
			body: { status },
			responseType: "none",
		});
		return prId;
	}

	/** Azure adds the user as a reviewer if needed, as its web UI does. */
	async function vote(
		requestedPrId: number | undefined,
		name: VoteName,
	): Promise<number> {
		const prId = await pullRequests.resolveId(requestedPrId);
		const userId = await getAuthenticatedUserId(azure, ctx.organization);
		const url = `${pullRequestApiUrl(ctx, prId, `/reviewers/${encodeURIComponent(userId)}`)}?api-version=${API_VERSION}`;
		await azure.request(url, {
			method: "PUT",
			body: { vote: VOTES[name] },
			responseType: "none",
		});
		return prId;
	}

	async function abandon(requestedPrId: number | undefined): Promise<number> {
		return setStatus(await pullRequests.resolveId(requestedPrId), "abandoned");
	}

	/** Takes a required ID: the branch lookup only finds active pull requests. */
	function reactivate(requestedPrId: number): Promise<number> {
		return setStatus(requestedPrId, "active");
	}

	return { vote, abandon, reactivate };
}
