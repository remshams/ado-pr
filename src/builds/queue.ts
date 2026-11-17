import type { PullRequest } from "../pull-requests/pull-requests.ts";
import {
	API_VERSION,
	buildApiUrl,
	orgProjectUrl,
	policyConfigurationsUrl,
	policyEvaluationsUrl,
	reposBaseUrl,
} from "../shared/azure.ts";
import {
	type AzureBuild,
	type AzureObject,
	assertFetchedBuild,
	assertRequestedPullRequestId,
	type BuildDependencies,
	buildMutationError,
	display,
	equalsIdentifier,
	isObject,
	MAX_BUILD_PAGES,
	MAX_JSON_RESPONSE_BYTES,
	nextBuildContinuationToken,
	READ_TIMEOUT_MS,
	RETRY_TIMEOUT_MS,
	requireArray,
	requireObject,
	requirePositiveInteger,
	requireString,
	resolvePullRequest,
	sanitizeError,
	type ValidatedPullRequest,
	validateBuild,
	validatePullRequest,
} from "./azure-builds.ts";
import type { PolicyEvaluation, QueuedBuild } from "./builds.ts";

const SATISFIED_POLICY_STATUSES = new Set(["approved", "notapplicable"]);
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";

function policyEvaluationLabel(evaluation: AzureObject): string {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const name = configuration?.name ?? evaluation.configurationName;
	const definitionId = evaluationDefinitionId(evaluation);
	return `evaluation ${display(evaluation.evaluationId)}${typeof name === "string" ? ` (${display(name)})` : ""}${definitionId === undefined ? "" : `, build pipeline ${definitionId}`}`;
}

function evaluationDefinitionId(evaluation: AzureObject): number | undefined {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const settings = isObject(configuration?.settings)
		? configuration.settings
		: undefined;
	return typeof settings?.buildDefinitionId === "number"
		? settings.buildDefinitionId
		: undefined;
}

function isBuildPolicyEvaluation(evaluation: AzureObject): boolean {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const type =
		configuration && isObject(configuration.type)
			? configuration.type
			: undefined;
	return (
		typeof type?.id === "string" &&
		equalsIdentifier(type.id, BUILD_POLICY_TYPE_ID)
	);
}

function toPolicyEvaluation(evaluation: AzureObject): PolicyEvaluation {
	const configuration = isObject(evaluation.configuration)
		? evaluation.configuration
		: undefined;
	const type =
		configuration && isObject(configuration.type)
			? configuration.type
			: undefined;
	const status =
		typeof evaluation.status === "string" && evaluation.status.length > 0
			? evaluation.status
			: "unknown";
	return {
		name:
			typeof type?.displayName === "string" && type.displayName.length > 0
				? type.displayName
				: "unknown policy",
		blocking: configuration?.isBlocking === true,
		satisfied: SATISFIED_POLICY_STATUSES.has(status.toLowerCase()),
		status,
	};
}

function policyConfigurationLabel(policy: AzureObject): string {
	const id = typeof policy.id === "number" ? policy.id : "unknown";
	const settings = isObject(policy.settings) ? policy.settings : undefined;
	const name = settings?.displayName ?? policy.displayName;
	return `policy ${id}${typeof name === "string" ? ` (${display(name)})` : ""}`;
}

function isBuildPolicyForRepository(
	policy: AzureObject,
	repositoryId: string,
): boolean {
	if (policy.isEnabled === false) return false;
	if (
		!isObject(policy.type) ||
		typeof policy.type.id !== "string" ||
		!equalsIdentifier(policy.type.id, BUILD_POLICY_TYPE_ID)
	)
		return false;
	if (!isObject(policy.settings) || !Array.isArray(policy.settings.scope))
		return false;
	return policy.settings.scope.some(
		(scope) =>
			isObject(scope) &&
			(scope.repositoryId == null ||
				(typeof scope.repositoryId === "string" &&
					equalsIdentifier(scope.repositoryId, repositoryId))),
	);
}

const REQUEUE_SCOPE_HINT =
	" Requeueing a policy evaluation may need more than that; this is unverified.";

async function fetchPolicyEvaluations(
	{ azure, ctx }: BuildDependencies,
	pr: ValidatedPullRequest,
	purpose: string,
): Promise<AzureObject[]> {
	const projectId = pr.projectId;
	if (typeof projectId !== "string" || projectId.length === 0) {
		throw new Error(
			`Cannot ${purpose} for PR #${pr.id}: Azure DevOps did not return its project ID.`,
		);
	}
	const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.id}`;
	const evaluationResponse = requireObject(
		await azure.request<unknown>(policyEvaluationsUrl(ctx, artifactId), {
			timeoutMs: READ_TIMEOUT_MS,
			maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
		}),
		"policy evaluations response",
	);
	return requireArray(
		evaluationResponse.value,
		"policy evaluations response.value",
	).map((value, index) =>
		requireObject(value, `policy evaluation ${index + 1}`),
	);
}

export async function policyEvaluations(
	deps: BuildDependencies,
	pr: PullRequest,
): Promise<PolicyEvaluation[]> {
	const validated = validatePullRequest(pr, "pull request");
	return (
		await fetchPolicyEvaluations(deps, validated, "read policy evaluations")
	).map(toPolicyEvaluation);
}

export async function queuePr(
	deps: BuildDependencies,
	prId: number,
	definitionId?: number,
): Promise<QueuedBuild> {
	const { azure, ctx, pullRequests } = deps;
	assertRequestedPullRequestId(prId);
	const pr = await resolvePullRequest(pullRequests, prId);
	const evaluations = await fetchPolicyEvaluations(deps, pr, "queue a build");
	const candidates = evaluations
		.filter((evaluation) => isBuildPolicyEvaluation(evaluation))
		.map((evaluation, index) => {
			const id = requireString(
				evaluation.evaluationId,
				`build policy evaluation ${index + 1}.evaluationId`,
			);
			return {
				id,
				definitionId: evaluationDefinitionId(evaluation),
				label: policyEvaluationLabel(evaluation),
			};
		});
	if (candidates.length === 0) {
		throw new Error(`No build policy evaluation was found for PR #${pr.id}.`);
	}
	const matches =
		definitionId === undefined
			? candidates
			: candidates.filter(
					(candidate) => candidate.definitionId === definitionId,
				);
	if (matches.length === 0) {
		throw new Error(
			`No build policy evaluation for build pipeline (definition) ${definitionId} was found for PR #${pr.id}. Candidates: ${candidates.map((candidate) => candidate.label).join("; ")}.`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`More than one build policy evaluation was found for PR #${pr.id}${definitionId === undefined ? ". Choose one with --definition <id>" : ` for build pipeline ${definitionId}`}: ${matches.map((candidate) => candidate.label).join("; ")}.`,
		);
	}

	const candidate = matches[0];
	let response: unknown;
	try {
		response = await requeueEvaluation(deps, candidate.id);
	} catch (error) {
		throw buildMutationError(
			error,
			`Requeue request for build policy evaluation ${candidate.id} on PR #${pr.id}`,
			`Inspect it with \`pr.sh build show --latest --pr ${pr.id}\` or \`pr.sh build list --pr ${pr.id} --history\` before trying again.`,
			REQUEUE_SCOPE_HINT,
		);
	}
	let buildId: number | undefined;
	try {
		buildId = requeuedBuildId(response);
	} catch (error) {
		throw new Error(
			`Requeue request for build policy evaluation ${candidate.id} on PR #${pr.id} was accepted, but Azure DevOps sent an invalid build ID or response. Find the new build with \`pr.sh build list --pr ${pr.id} --history\`.\n${sanitizeError(error)}`,
		);
	}
	if (buildId === undefined) return { evaluationId: candidate.id };
	try {
		return {
			build: assertFetchedBuild(
				await azure.request<unknown>(
					`${buildApiUrl(ctx)}/${buildId}?api-version=${API_VERSION}`,
					{
						timeoutMs: READ_TIMEOUT_MS,
						maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
					},
				),
				buildId,
				"requeued build response",
			),
		};
	} catch (error) {
		throw new Error(
			`Requeued build policy evaluation ${candidate.id} on PR #${pr.id}; reading build ${buildId} failed. Check it with \`pr.sh build show --build ${buildId} --pr ${pr.id}\`.\n${sanitizeError(error)}`,
		);
	}
}

/** Sends the requeue request and returns the response body. */
async function requeueEvaluation(
	{ azure, ctx }: BuildDependencies,
	evaluationId: string,
): Promise<unknown> {
	const evaluationUrl = `${orgProjectUrl(ctx)}/_apis/policy/evaluations/${evaluationId}?api-version=7.1-preview.1`;
	return azure.request<unknown>(evaluationUrl, {
		method: "PATCH",
		body: { status: "queued" },
		timeoutMs: RETRY_TIMEOUT_MS,
		maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
	});
}

/** Azure sends no build ID, or null, until the requeued build exists. */
function requeuedBuildId(response: unknown): number | undefined {
	const body = requireObject(response, "requeued policy evaluation response");
	const context =
		body.context === undefined || body.context === null
			? undefined
			: requireObject(body.context, "requeued policy evaluation context");
	const buildId = context?.buildId;
	if (buildId === undefined || buildId === null) return undefined;
	return requirePositiveInteger(
		buildId,
		"requeued policy evaluation context.buildId",
	);
}

async function listBuildPolicies({
	azure,
	ctx,
}: BuildDependencies): Promise<AzureObject[]> {
	const policies: AzureObject[] = [];
	const seenContinuationTokens = new Set<string>();
	let continuationToken: string | undefined;
	let pageCount = 0;
	do {
		pageCount += 1;
		if (pageCount > MAX_BUILD_PAGES) {
			throw new Error(
				`Azure DevOps policy pagination exceeded the safety limit of ${MAX_BUILD_PAGES} pages.`,
			);
		}
		const query =
			`&policyType=${BUILD_POLICY_TYPE_ID}` +
			(continuationToken === undefined
				? ""
				: `&continuationToken=${encodeURIComponent(continuationToken)}`);
		const response = await azure.requestWithMetadata<unknown>(
			`${policyConfigurationsUrl(ctx)}${query}`,
			{
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			},
		);
		const page = requireArray(
			requireObject(response.data, "policy configurations response").value,
			"policy configurations response.value",
		);
		for (const value of page)
			policies.push(
				requireObject(value, `policy configuration ${policies.length + 1}`),
			);
		continuationToken = nextBuildContinuationToken(
			response.metadata.headers,
			seenContinuationTokens,
			"policy",
		);
	} while (continuationToken !== undefined);
	return policies;
}

async function resolveBranchDefinition(
	deps: BuildDependencies,
): Promise<number> {
	const { azure, ctx } = deps;
	const repository = requireObject(
		await azure.request<unknown>(
			`${reposBaseUrl(ctx)}?api-version=${API_VERSION}`,
			{
				timeoutMs: READ_TIMEOUT_MS,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
			},
		),
		"repository response",
	);
	const repositoryId = requireString(repository.id, "repository response.id");
	const repositoryPolicies = (await listBuildPolicies(deps)).filter((policy) =>
		isBuildPolicyForRepository(policy, repositoryId),
	);
	if (repositoryPolicies.length === 0) {
		throw new Error(
			`No build policy was found for repository ${ctx.repository}. Pass --definition <id> to queue a build pipeline directly.`,
		);
	}
	const definitions = new Map<number, AzureObject[]>();
	for (const policy of repositoryPolicies) {
		const settings = requireObject(policy.settings, "build policy settings");
		const definitionId = requirePositiveInteger(
			settings.buildDefinitionId,
			"build policy settings.buildDefinitionId",
		);
		const matchingPolicies = definitions.get(definitionId) ?? [];
		matchingPolicies.push(policy);
		definitions.set(definitionId, matchingPolicies);
	}
	if (definitions.size > 1) {
		const candidates = [...definitions.entries()]
			.map(
				([definitionId, policies]) =>
					`build pipeline ${definitionId}: ${policies.map(policyConfigurationLabel).join(", ")}`,
			)
			.join("; ");
		throw new Error(
			`More than one build pipeline was found for repository ${ctx.repository}. Choose one with --definition <id>: ${candidates}.`,
		);
	}
	return definitions.keys().next().value as number;
}

export async function queueBranch(
	deps: BuildDependencies,
	branch: string,
	requestedDefinitionId?: number,
): Promise<AzureBuild> {
	const { azure, ctx } = deps;
	const sourceBranch = branch.startsWith("refs/")
		? branch
		: `refs/heads/${branch}`;
	const definitionId =
		requestedDefinitionId ?? (await resolveBranchDefinition(deps));
	try {
		return validateBuild(
			await azure.request<unknown>(
				`${buildApiUrl(ctx)}?api-version=${API_VERSION}`,
				{
					method: "POST",
					body: { definition: { id: definitionId }, sourceBranch },
					timeoutMs: RETRY_TIMEOUT_MS,
					maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				},
			),
			"queued branch build",
		);
	} catch (error) {
		throw buildMutationError(
			error,
			`Queue request for build pipeline ${definitionId} on ${sourceBranch}`,
			`Check that build pipeline's runs for ${sourceBranch} in Azure DevOps before trying again.`,
		);
	}
}

/** The one active pull request that has the branch as its source, if any. */
export async function branchPullRequestId(
	{ pullRequests }: BuildDependencies,
	branch: string,
): Promise<number | undefined> {
	const found = await pullRequests.findActiveForBranch(branch);
	if (found.length > 1) {
		throw new Error(
			`Multiple active pull requests have ${branch} as their source: ${found.map((pr) => `#${pr.pullRequestId}`).join(", ")}. Run \`pr.sh build wait --build <id> --pr <id>\` with the one you want.`,
		);
	}
	return found[0]?.pullRequestId;
}
