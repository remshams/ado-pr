import {
	API_VERSION,
	AzureRequestError,
	isAzureRequestError,
} from "../shared/azure.ts";
import {
	type AzureBuild,
	assertFetchedBuild,
	assertRequestedBuildId,
	type BuildDependencies,
	buildBaseUrl,
	display,
	equalsIdentifier,
	MAX_JSON_RESPONSE_BYTES,
	normalized,
	READ_TIMEOUT_MS,
	resolvePullRequest,
	sanitizeError,
	type ValidatedPullRequest,
	validatePullRequest,
} from "./azure-builds.ts";
import type {
	BuildWaitEnvelope,
	BuildWaitOutcome,
	BuildWaitProgress,
	BuildWaitProgressBase,
	WaitBuildOptions,
} from "./builds.ts";
import {
	assertActivePullRequest,
	assertBuildAssociation,
	buildAssociation,
	headCommitFor,
	isCurrentBuild,
	listNewestBuilds,
	validatesHead,
} from "./head-builds.ts";

const DEFAULT_WAIT_INTERVAL_SECONDS = 60;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 3_600;
const MIN_WAIT_INTERVAL_SECONDS = 10;
const MAX_WAIT_INTERVAL_SECONDS = 3_600;
const MIN_WAIT_TIMEOUT_SECONDS = 10;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_HEARTBEAT_MS = 5 * 60_000;
export const WAIT_FOR_BUILD_MINUTES = 10;
const WAIT_FOR_BUILD_MS = WAIT_FOR_BUILD_MINUTES * 60_000;
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 3;
const MAX_WAIT_ERROR_LENGTH = 4_096;

const WAITING_BUILD_STATUSES = new Set([
	"notstarted",
	"inprogress",
	"cancelling",
	"postponed",
]);
const WAIT_OUTCOMES = new Map<
	string,
	Exclude<BuildWaitOutcome, "timeout" | "unknown">
>([
	["succeeded", "succeeded"],
	["partiallysucceeded", "partiallySucceeded"],
	["failed", "failed"],
	["canceled", "canceled"],
]);

interface WaitDependencies extends BuildDependencies {
	now: () => number;
	sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function validateWaitBuild(
	rawBuild: unknown,
	buildId: number,
	pr: ValidatedPullRequest,
): AzureBuild & { status: string } {
	const observedBuild = assertFetchedBuild(rawBuild, buildId, "wait build");
	assertBuildAssociation(observedBuild, pr);
	if (typeof observedBuild.status !== "string") {
		throw new Error(
			`Cannot wait for build ${buildId}: Azure returned no build status.`,
		);
	}
	const observedStatus = normalized(observedBuild.status);
	if (
		observedStatus === "none" ||
		(observedStatus !== "completed" &&
			!WAITING_BUILD_STATUSES.has(observedStatus))
	) {
		throw new Error(
			`Cannot wait for build ${buildId}: Azure returned unknown build status ${display(observedBuild.status)}.`,
		);
	}
	return observedBuild as AzureBuild & { status: string };
}

function createWaitProgressEmitter(
	onProgress: WaitBuildOptions["onProgress"],
	signal: AbortSignal | undefined,
): (event: BuildWaitProgress) => Promise<void> {
	return async (event: BuildWaitProgress): Promise<void> => {
		if (onProgress !== undefined) {
			try {
				const callbackResult = onProgress(structuredClone(event));
				const callbackOutcome = Promise.resolve(callbackResult).then(
					() => ({ ok: true as const }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				let outcome: Awaited<typeof callbackOutcome> | undefined;
				await cancellableSleep(
					async () => {
						outcome = await callbackOutcome;
					},
					0,
					signal,
				);
				if (outcome?.ok === false) throw outcome.error;
			} catch (error) {
				throwIfWaitAborted(signal);
				throw error;
			}
		}
		throwIfWaitAborted(signal);
	};
}

function sanitizeWaitError(error: unknown): string {
	const sanitized = sanitizeError(error);
	if (sanitized.length <= MAX_WAIT_ERROR_LENGTH) return sanitized;
	const suffix = "… [truncated]";
	return `${sanitized.slice(0, MAX_WAIT_ERROR_LENGTH - suffix.length)}${suffix}`;
}

function validateWaitSeconds(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const seconds = value ?? fallback;
	if (
		!Number.isSafeInteger(seconds) ||
		seconds < minimum ||
		seconds > maximum
	) {
		throw new Error(
			`${name} must be a whole number from ${minimum} to ${maximum} seconds.`,
		);
	}
	return seconds;
}

function buildWaitAbortError(): AzureRequestError {
	return new AzureRequestError(
		"Build wait was aborted by the caller.",
		"abort",
	);
}

function throwIfWaitAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw buildWaitAbortError();
}

export function productionSleep(
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(buildWaitAbortError());
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(buildWaitAbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function cancellableSleep(
	sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
	milliseconds: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfWaitAborted(signal);
	if (signal === undefined) {
		await sleep(milliseconds);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = (): void => finish(() => reject(buildWaitAbortError()));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted || settled) {
			onAbort();
			return;
		}

		let sleeping: Promise<void>;
		try {
			// Invoke immediately after installing the listener. Deferring this call would let an abort
			// settle the wrapper while still allowing an injected sleep's side effects to run later.
			sleeping = sleep(milliseconds, signal);
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		void Promise.resolve(sleeping).then(
			() => finish(resolve),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function isTransientWaitError(error: unknown): boolean {
	if (!isAzureRequestError(error)) return false;
	if (error.kind === "network" || error.kind === "timeout") return true;
	return (
		error.kind === "http" &&
		error.status !== undefined &&
		(error.status === 408 ||
			error.status === 429 ||
			(error.status >= 500 && error.status <= 599))
	);
}

function waitResultOutcome(
	build: AzureBuild,
): Exclude<BuildWaitOutcome, "timeout"> {
	if (typeof build.result !== "string") return "unknown";
	return WAIT_OUTCOMES.get(normalized(build.result)) ?? "unknown";
}

/** The Retry-After delay of an HTTP error, if Azure sent one. */
function retryAfterOf(error: unknown): number | undefined {
	return isAzureRequestError(error) && error.kind === "http"
		? error.retryAfterMs
		: undefined;
}

function waitStateKey(build: AzureBuild): string {
	return `${normalized(build.status as string)}\u0000${
		typeof build.result === "string" ? normalized(build.result) : "<missing>"
	}`;
}

export async function wait(
	deps: WaitDependencies,
	requestedPrId: number | undefined,
	requestedBuild: number | "latest",
	options: WaitBuildOptions = {},
): Promise<BuildWaitEnvelope> {
	const { azure, ctx, pullRequests, now, sleep } = deps;
	const signal = options.signal;
	const onProgress = options.onProgress;
	if (requestedBuild !== "latest") assertRequestedBuildId(requestedBuild);
	const intervalSeconds = validateWaitSeconds(
		options.intervalSeconds,
		DEFAULT_WAIT_INTERVAL_SECONDS,
		MIN_WAIT_INTERVAL_SECONDS,
		MAX_WAIT_INTERVAL_SECONDS,
		"Build wait interval",
	);
	const timeoutSeconds = validateWaitSeconds(
		options.timeoutSeconds,
		DEFAULT_WAIT_TIMEOUT_SECONDS,
		MIN_WAIT_TIMEOUT_SECONDS,
		MAX_WAIT_TIMEOUT_SECONDS,
		"Build wait timeout",
	);
	throwIfWaitAborted(signal);
	const prReadOptions = {
		signal,
		timeoutMs: READ_TIMEOUT_MS,
		maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
	};
	let pr = await resolvePullRequest(pullRequests, requestedPrId, prReadOptions);
	throwIfWaitAborted(signal);

	const followsHead = requestedBuild === "latest";
	let buildId: number | null = followsHead ? null : requestedBuild;
	let previousBuildId: number | null = null;

	const startedAt = now();
	let waitingForBuildSince = startedAt;
	let announcedWaitForHead: string | undefined;
	const deadline = startedAt + timeoutSeconds * 1_000;
	const intervalMs = intervalSeconds * 1_000;
	let nextPollAt = startedAt;
	let nextHeartbeatAt = startedAt + WAIT_HEARTBEAT_MS;
	let latestBuild: AzureBuild | null = null;
	let pollCount = 0;
	let transientFailureCount = 0;
	let consecutiveTransientFailures = 0;
	let previousStateKey: string | undefined;

	const elapsedSeconds = (at = now()): number =>
		Math.max(0, at - startedAt) / 1_000;
	/** The result when no build reached a final state. */
	const unfinishedEnvelope = (
		outcome: "timeout" | "no-build",
		at = now(),
	): BuildWaitEnvelope => ({
		association: latestBuild === null ? null : buildAssociation(latestBuild),
		pullRequest: pr.summary,
		buildId,
		build: latestBuild,
		pollCount,
		transientFailureCount,
		elapsedSeconds: elapsedSeconds(at),
		timedOut: outcome === "timeout",
		outcome,
		validatesHead: null,
	});
	const progressBase = (at = now()): BuildWaitProgressBase => ({
		pullRequest: pr.summary,
		buildId,
		build: latestBuild,
		pollCount,
		transientFailureCount,
		elapsedSeconds: elapsedSeconds(at),
	});
	const emit = createWaitProgressEmitter(onProgress, signal);

	/** Polls at `at`, but no later than the deadline or, while no build is selected, the end of the wait for one. */
	const scheduleNextPoll = (at: number): void => {
		nextPollAt = Math.min(
			deadline,
			buildId === null ? waitingForBuildSince + WAIT_FOR_BUILD_MS : at,
			at,
		);
	};

	const waitForBuildEnded = (at: number): boolean =>
		buildId === null && at - waitingForBuildSince >= WAIT_FOR_BUILD_MS;

	const waitLabel = (): string =>
		buildId === null ? `Build wait for PR #${pr.id}` : `Build ${buildId} wait`;

	async function handlePollError(
		error: unknown,
		completedAt: number,
	): Promise<BuildWaitEnvelope | undefined> {
		throwIfWaitAborted(signal);
		if (isAzureRequestError(error) && error.kind === "abort") throw error;

		const transient = isTransientWaitError(error);
		if (transient) {
			transientFailureCount += 1;
			consecutiveTransientFailures += 1;
		}
		if (completedAt >= deadline)
			return unfinishedEnvelope("timeout", completedAt);
		if (!transient) throw error;
		if (waitForBuildEnded(completedAt))
			return unfinishedEnvelope("no-build", completedAt);

		const retryAfterMs = retryAfterOf(error);
		const errorText = sanitizeWaitError(error);
		await emit({
			type: "transient-warning",
			...progressBase(completedAt),
			attempt: pollCount,
			consecutiveFailureCount: consecutiveTransientFailures,
			error: errorText,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		});
		if (consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
			throw new Error(
				`${waitLabel()} stopped after ${consecutiveTransientFailures} consecutive transient Azure DevOps failures: ${errorText}`,
			);
		}
		scheduleNextPoll(completedAt + Math.max(intervalMs, retryAfterMs ?? 0));
		return undefined;
	}

	async function rereadPullRequest(
		timeoutMs: number,
	): Promise<ValidatedPullRequest> {
		return validatePullRequest(
			await pullRequests.get(pr.id, { ...prReadOptions, timeoutMs }),
			"refreshed pull request",
		);
	}

	function headValidity(
		observedBuild: AzureBuild,
		current: ValidatedPullRequest,
	): Pick<BuildWaitEnvelope, "pullRequest" | "validatesHead"> {
		const headKnown = headCommitFor(observedBuild, current) !== undefined;
		return {
			pullRequest: current.summary,
			validatesHead: headKnown ? validatesHead(observedBuild, current) : null,
		};
	}

	/** Rereads the PR once the build finished; validatesHead is null if that isn't possible. */
	async function refreshedHead(
		observedBuild: AzureBuild,
	): Promise<Pick<BuildWaitEnvelope, "pullRequest" | "validatesHead">> {
		const remainingMs = Math.ceil(deadline - now());
		if (remainingMs <= 0)
			return { pullRequest: pr.summary, validatesHead: null };
		try {
			return headValidity(
				observedBuild,
				await rereadPullRequest(Math.min(READ_TIMEOUT_MS, remainingMs)),
			);
		} catch (error) {
			throwIfWaitAborted(signal);
			if (isAzureRequestError(error) && error.kind === "abort") throw error;
			return { pullRequest: pr.summary, validatesHead: null };
		}
	}

	async function observeBuild(
		rawBuild: unknown,
		selectedBuildId: number,
		completedAt: number,
	): Promise<BuildWaitEnvelope | undefined> {
		const observedBuild = validateWaitBuild(rawBuild, selectedBuildId, pr);
		const observedStatus = normalized(observedBuild.status);

		latestBuild = observedBuild;
		consecutiveTransientFailures = 0;
		const stateKey = waitStateKey(observedBuild);
		if (stateKey !== previousStateKey) {
			await emit({
				type: "state",
				...progressBase(completedAt),
				change: previousStateKey === undefined ? "initial" : "changed",
				status: observedBuild.status,
				result:
					typeof observedBuild.result === "string"
						? observedBuild.result
						: null,
			});
			previousStateKey = stateKey;
		}
		if (observedStatus !== "completed") return undefined;
		const { pullRequest, validatesHead } = followsHead
			? headValidity(observedBuild, pr)
			: await refreshedHead(observedBuild);
		return {
			association: buildAssociation(observedBuild),
			pullRequest,
			buildId,
			build: observedBuild,
			pollCount,
			transientFailureCount,
			elapsedSeconds: elapsedSeconds(completedAt),
			timedOut: false,
			outcome: waitResultOutcome(observedBuild),
			validatesHead,
		};
	}

	async function emitHeartbeat(current: number): Promise<void> {
		await emit({ type: "heartbeat", ...progressBase(current) });
		do nextHeartbeatAt += WAIT_HEARTBEAT_MS;
		while (nextHeartbeatAt <= current);
	}

	/** Rereads the PR and drops the selected build when the source head moved. */
	async function followHead(requestTimeoutMs: number): Promise<void> {
		const refreshed = await rereadPullRequest(requestTimeoutMs);
		if (!equalsIdentifier(refreshed.headCommit ?? "", pr.headCommit ?? "")) {
			if (buildId !== null) previousBuildId = buildId;
			buildId = null;
			latestBuild = null;
			previousStateKey = undefined;
			waitingForBuildSince = now();
		}
		pr = refreshed;
	}

	/** Follows the head if asked, selects its build if none is selected, and reads that build. */
	async function requestPoll(requestTimeoutMs: number): Promise<unknown> {
		if (followsHead && pollCount > 1) await followHead(requestTimeoutMs);
		if (buildId === null) {
			assertActivePullRequest(pr, "wait for a build of the PR head");
			const selected = (await listNewestBuilds(deps, pr, signal)).find(
				(candidate) => isCurrentBuild(candidate, pr),
			);
			if (selected === undefined) return undefined;
			buildId = selected.id as number;
			await emit({
				type: "build-selected",
				...progressBase(),
				previousBuildId,
			});
		}
		return azure.request<unknown>(
			`${buildBaseUrl(ctx)}/${buildId}?api-version=${API_VERSION}`,
			{
				timeoutMs: requestTimeoutMs,
				maxResponseBytes: MAX_JSON_RESPONSE_BYTES,
				signal,
			},
		);
	}

	async function awaitHeadBuild(
		completedAt: number,
	): Promise<BuildWaitEnvelope | undefined> {
		consecutiveTransientFailures = 0;
		if (waitForBuildEnded(completedAt))
			return unfinishedEnvelope("no-build", completedAt);
		const head = pr.headCommit ?? "";
		if (announcedWaitForHead !== head) {
			announcedWaitForHead = head;
			await emit({ type: "waiting-for-build", ...progressBase(completedAt) });
		}
		scheduleNextPoll(completedAt + intervalMs);
		return undefined;
	}

	async function pollBuild(
		current: number,
	): Promise<BuildWaitEnvelope | undefined> {
		const remainingMs = Math.max(1, Math.ceil(deadline - current));
		pollCount += 1;
		const requestTimeoutMs = Math.min(READ_TIMEOUT_MS, remainingMs);
		let rawBuild: unknown;
		let completedAt: number;
		try {
			rawBuild = await requestPoll(requestTimeoutMs);
			completedAt = now();
		} catch (error) {
			completedAt = now();
			return handlePollError(error, completedAt);
		}

		throwIfWaitAborted(signal);
		if (completedAt >= deadline)
			return unfinishedEnvelope("timeout", completedAt);
		if (buildId === null) return awaitHeadBuild(completedAt);
		const result = await observeBuild(rawBuild, buildId, completedAt);
		if (!result) nextPollAt = Math.min(deadline, completedAt + intervalMs);
		return result;
	}

	while (true) {
		throwIfWaitAborted(signal);
		const current = now();
		if (current >= deadline) return unfinishedEnvelope("timeout", current);
		if (current >= nextHeartbeatAt) {
			await emitHeartbeat(current);
			continue;
		}

		if (current < nextPollAt) {
			const wakeAt = Math.min(nextPollAt, nextHeartbeatAt, deadline);
			await cancellableSleep(sleep, Math.max(0, wakeAt - current), signal);
			throwIfWaitAborted(signal);
			continue;
		}

		const result = await pollBuild(current);
		if (result) return result;
	}
}
