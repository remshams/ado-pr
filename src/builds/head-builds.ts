import type { PullRequest } from "../pull-requests/pull-requests.ts";
import {
	type AzureBuild,
	assertListEnvelope,
	type BuildDependencies,
	type BuildRepository,
	display,
	equalsIdentifier,
	listUrl,
	MAX_BUILD_PAGES,
	MAX_JSON_RESPONSE_BYTES,
	nextBuildContinuationToken,
	normalized,
	READ_TIMEOUT_MS,
	type ValidatedPullRequest,
	validatePullRequest,
} from "./azure-builds.ts";
import type { BuildAssociation, HeadBuild } from "./builds.ts";

const MAX_BUILD_RESPONSES = 100_000;

export function assertActivePullRequest(
	pr: ValidatedPullRequest,
	operation: string,
): void {
	if (pr.status === undefined) {
		throw new Error(
			`Cannot ${operation}: PR #${pr.id} has no status in the Azure DevOps response.`,
		);
	}
	if (normalized(pr.status) !== "active") {
		throw new Error(
			`Cannot ${operation}: PR #${pr.id} is ${display(pr.status)}; only active pull requests are eligible. Use build history/show for completed or abandoned pull requests.`,
		);
	}
}

function buildAssociationMismatch(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): string | undefined {
	const repository = build.repository as BuildRepository;
	if (!equalsIdentifier(repository.id as string, pr.repositoryId))
		return "repository ID";
	if (!equalsIdentifier(repository.type as string, "TfsGit"))
		return "repository type";
	if (build.sourceBranch === pr.sourceBranch) return undefined;
	if (!equalsIdentifier(build.reason as string, "pullRequest")) return "reason";
	if (build.sourceBranch !== `refs/pull/${pr.id}/merge`) return "source branch";
	return undefined;
}

export function assertBuildAssociation(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): void {
	const mismatch = buildAssociationMismatch(build, pr);
	if (mismatch !== undefined) {
		throw new Error(
			`Build ${build.id as number} is not associated with PR #${pr.id}: ${mismatch} does not match.`,
		);
	}
}

export function buildAssociation(build: AzureBuild): BuildAssociation {
	return (build.sourceBranch as string).startsWith("refs/heads/")
		? "branch-head"
		: "pr-merge";
}

/** The PR commit a build must have run on to validate the head. */
export function headCommitFor(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): string | undefined {
	return buildAssociation(build) === "branch-head"
		? pr.headCommit
		: pr.mergeCommit;
}

/** Whether the build ran on the PR's current head, whatever the PR status. */
export function validatesHead(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): boolean {
	const commit = headCommitFor(build, pr);
	return (
		commit !== undefined &&
		equalsIdentifier(build.sourceVersion as string, commit)
	);
}

/** Queue time in milliseconds; a missing or invalid time sorts as the oldest. */
function queuedAt(build: AzureBuild): number {
	const time = Date.parse(build.queueTime ?? "");
	return Number.isNaN(time) ? 0 : time;
}

export function isCurrentBuild(
	build: AzureBuild,
	pr: ValidatedPullRequest,
): boolean {
	return (
		pr.status !== undefined &&
		normalized(pr.status) === "active" &&
		validatesHead(build, pr)
	);
}

function appendAssociatedBuilds(
	builds: AzureBuild[],
	page: AzureBuild[],
	pr: ValidatedPullRequest,
	seenBuildIds: Set<number>,
): void {
	for (const build of page) {
		if (buildAssociationMismatch(build, pr) !== undefined) continue;
		const buildId = build.id as number;
		if (seenBuildIds.has(buildId)) {
			throw new Error(
				`Azure DevOps build pagination returned duplicate build ID ${buildId}; refusing an ambiguous result.`,
			);
		}
		seenBuildIds.add(buildId);
		builds.push(build);
	}
}

async function listAssociatedBuilds(
	{ azure, ctx }: BuildDependencies,
	pr: ValidatedPullRequest,
	branchHead = false,
	signal?: AbortSignal,
): Promise<AzureBuild[]> {
	const builds: AzureBuild[] = [];
	const seenBuildIds = new Set<number>();
	const seenContinuationTokens = new Set<string>();
	let continuationToken: string | undefined;
	let pageCount = 0;
	let responseBuildCount = 0;
	do {
		pageCount += 1;
		if (pageCount > MAX_BUILD_PAGES) {
			throw new Error(
				`Azure DevOps build pagination exceeded the safety limit of ${MAX_BUILD_PAGES} pages.`,
			);
		}
		const response = await azure.requestWithMetadata<unknown>(
			listUrl(ctx, pr, continuationToken, branchHead),
			{
				signal,
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			},
		);
		const page = assertListEnvelope(response.data);
		responseBuildCount += page.length;
		if (responseBuildCount > MAX_BUILD_RESPONSES) {
			throw new Error(
				`Azure DevOps build pagination exceeded the safety limit of ${MAX_BUILD_RESPONSES} builds.`,
			);
		}
		appendAssociatedBuilds(
			builds,
			page.filter((build) =>
				branchHead
					? build.sourceBranch === pr.sourceBranch
					: build.sourceBranch === `refs/pull/${pr.id}/merge`,
			),
			pr,
			seenBuildIds,
		);

		continuationToken = nextBuildContinuationToken(
			response.metadata.headers,
			seenContinuationTokens,
		);
	} while (continuationToken !== undefined);
	return builds;
}

export async function listNewestBuilds(
	deps: BuildDependencies,
	pr: ValidatedPullRequest,
	signal?: AbortSignal,
): Promise<AzureBuild[]> {
	return [
		...(await listAssociatedBuilds(deps, pr, false, signal)),
		...(await listAssociatedBuilds(deps, pr, true, signal)),
	].sort((left, right) => queuedAt(right) - queuedAt(left));
}

export async function selectLatestBuild(
	deps: BuildDependencies,
	pr: ValidatedPullRequest,
): Promise<AzureBuild> {
	const builds = await listNewestBuilds(deps, pr);
	const current = builds.find((build) => isCurrentBuild(build, pr));
	if (current !== undefined) return current;
	if (builds.length === 0) {
		throw new Error(
			`No build validates PR #${pr.id} head commit ${pr.headCommit ?? "(unavailable)"}.`,
		);
	}
	return builds[0];
}

/** The newest build validating the head, else the newest associated one marked stale; null if none exists. */
export async function headBuild(
	deps: BuildDependencies,
	pr: PullRequest,
): Promise<HeadBuild | null> {
	const validated = validatePullRequest(pr, "pull request");
	const builds = await listNewestBuilds(deps, validated);
	const current = builds.find((build) => validatesHead(build, validated));
	const build = current ?? builds[0];
	if (build === undefined) return null;
	return {
		association: buildAssociation(build),
		current: current !== undefined,
		build,
	};
}
