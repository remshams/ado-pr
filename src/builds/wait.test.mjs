import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	branchBuild,
	build,
	buildBase,
	createPullRequestStub,
	ctx,
	headPr,
	pullRequest,
} from "../../tests/support/builds.mjs";
import { AzureRequestError } from "../shared/azure.ts";
import { createBuildService } from "./builds.ts";

function transientError(kind, status, retryAfterMs) {
	return new AzureRequestError(`safe ${kind} failure`, kind, {
		status,
		retryAfterMs,
	});
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createWaitHarness(
	responses,
	{ resolvedPr = pullRequest(), refreshedPr = resolvedPr, start = 0 } = {},
) {
	const clock = { value: start };
	const calls = [];
	const sleeps = [];
	const pullRequestCalls = [];
	let responseIndex = 0;
	const azure = {
		async request(url, options) {
			calls.push({ url, options, at: clock.value });
			if (responseIndex >= responses.length)
				throw new Error("Unexpected build poll");
			const response = responses[responseIndex++];
			if (typeof response === "function")
				return response({ clock, options, calls });
			if (response instanceof Error) throw response;
			return response;
		},
		async requestWithMetadata(url, options) {
			return {
				data: await azure.request(url, options),
				metadata: { headers: new Headers() },
			};
		},
	};
	const pullRequests = {
		async resolve(requestedPrId) {
			pullRequestCalls.push({ method: "resolve", requestedPrId });
			return resolvedPr;
		},
		async get(prId, options) {
			pullRequestCalls.push({ method: "get", prId });
			if (refreshedPr instanceof Error) throw refreshedPr;
			if (typeof refreshedPr === "function") return refreshedPr(options);
			return refreshedPr;
		},
	};
	const sleep = async (milliseconds, signal) => {
		if (signal?.aborted) throw new AzureRequestError("sleep aborted", "abort");
		sleeps.push({ at: clock.value, milliseconds });
		clock.value += milliseconds;
	};
	const service = createBuildService({
		azure,
		ctx,
		pullRequests,
		now: () => clock.value,
		sleep,
	});
	return { service, clock, calls, sleeps, pullRequestCalls };
}

describe("deterministic build wait", () => {
	const terminalCases = [
		["succeeded", "succeeded"],
		["failed", "failed"],
		["partiallySucceeded", "partiallySucceeded"],
		["canceled", "canceled"],
		["unknown Azure result", "abandoned", "unknown"],
		["missing Azure result", undefined, "unknown"],
	];
	for (const [name, azureResult, expectedOutcome = name] of terminalCases) {
		test(`maps immediate completed ${name}`, async () => {
			const observed = build({ status: "CoMpLeTeD", result: azureResult });
			const { service, calls, sleeps, pullRequestCalls } = createWaitHarness([
				observed,
			]);

			const result = await service.wait(undefined, 700);

			assert.equal(result.outcome, expectedOutcome);
			assert.equal(result.buildId, 700);
			assert.equal(result.timedOut, false);
			assert.equal(result.build, observed);
			assert.equal(result.pollCount, 1);
			assert.equal(result.transientFailureCount, 0);
			assert.equal(result.elapsedSeconds, 0);
			assert.deepEqual(sleeps, []);
			assert.equal(result.validatesHead, true);
			assert.deepEqual(pullRequestCalls, [
				{ method: "resolve", requestedPrId: undefined },
				{ method: "get", prId: 42 },
			]);
			assert.equal(calls[0].options.timeoutMs, 30_000);
			assert.equal(calls[0].options.maxResponseBytes, 16 * 1024 * 1024);
		});
	}

	test("allows a historical associated build on a completed PR", async () => {
		const historical = build({
			sourceVersion: "old-merge",
			result: "succeeded",
		});
		const { service, pullRequestCalls } = createWaitHarness([historical], {
			resolvedPr: pullRequest({
				status: "completed",
				lastMergeCommit: undefined,
			}),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.build, historical);
		assert.equal(result.validatesHead, null);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
			{ method: "get", prId: 42 },
		]);
	});

	test("reports a build as stale when the PR head moved during the wait", async () => {
		const { service } = createWaitHarness(
			[build({ status: "inProgress" }), build({ result: "succeeded" })],
			{
				refreshedPr: pullRequest({
					lastMergeCommit: { commitId: "new-merge" },
				}),
			},
		);
		const result = await service.wait(42, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, false);
		assert.match(
			service.formatWaitResult(result),
			/Validates head: no\nThis build doesn't validate the current head of the pull request; wait for the build that does with `pr\.sh build wait --latest --pr 42`\./,
		);
	});

	test("reports a branch build as stale when the source head moved", async () => {
		const { service } = createWaitHarness(
			[branchBuild({ result: "succeeded", sourceVersion: "head-1" })],
			{
				resolvedPr: headPr(),
				refreshedPr: pullRequest({
					...headPr(),
					lastMergeSourceCommit: { commitId: "head-2" },
				}),
			},
		);
		const result = await service.wait(42, 700);
		assert.equal(result.association, "branch-head");
		assert.equal(result.validatesHead, false);
	});

	test("reports the PR summary from the final read", async () => {
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: pullRequest({
				status: "completed",
				lastMergeCommit: { commitId: "new-merge" },
			}),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.validatesHead, false);
		assert.equal(result.pullRequest.status, "completed");
		assert.deepEqual(Object.keys(result).slice(0, 3), [
			"association",
			"pullRequest",
			"buildId",
		]);
		assert.equal(Object.keys(result).at(-1), "validatesHead");
		assert.equal(result.pullRequest.currentMergeCommit, "new-merge");
		assert.doesNotMatch(service.formatWaitResult(result), /--latest/);
	});

	test("reports an unknown head when the final read has no commit to compare", async () => {
		for (const [observed, refreshedPr] of [
			[
				build({ result: "succeeded" }),
				pullRequest({ lastMergeCommit: undefined }),
			],
			[
				branchBuild({ result: "succeeded" }),
				pullRequest({ lastMergeSourceCommit: undefined }),
			],
		]) {
			const { service } = createWaitHarness([observed], {
				resolvedPr: headPr(),
				refreshedPr,
			});
			const result = await service.wait(42, 700);
			assert.equal(result.validatesHead, null);
			assert.doesNotMatch(service.formatWaitResult(result), /--latest/);
		}
	});

	test("skips the final PR read when the deadline passed while reporting progress", async () => {
		const { service, clock, pullRequestCalls } = createWaitHarness([
			build({ result: "succeeded" }),
		]);
		const result = await service.wait(42, 700, {
			timeoutSeconds: 10,
			onProgress: () => {
				clock.value = 10_000;
			},
		});
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, null);
		assert.equal(result.pullRequest.id, 42);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
		]);
	});

	test("bounds the final PR read by the wait deadline", async () => {
		const readTimeouts = [];
		const { service } = createWaitHarness(
			[
				({ clock }) => {
					clock.value = 9_000;
					return build({ result: "succeeded" });
				},
			],
			{
				refreshedPr: (options) => {
					readTimeouts.push(options.timeoutMs);
					return pullRequest();
				},
			},
		);
		const result = await service.wait(42, 700, { timeoutSeconds: 10 });
		assert.equal(result.validatesHead, true);
		assert.deepEqual(readTimeouts, [1_000]);
	});

	test("still validates the head when auto-complete merged the PR as the build finished", async () => {
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: pullRequest({ status: "completed" }),
		});
		const result = await service.wait(42, 700);
		assert.equal(result.validatesHead, true);
		assert.match(service.formatWaitResult(result), /Validates head: yes$/);
	});

	test("reports an unknown head when the final PR read fails", async () => {
		const failedRead = new AzureRequestError("Bad Gateway", "http");
		for (const refreshedPr of [failedRead, { pullRequestId: "not a number" }]) {
			const { service } = createWaitHarness([build({ result: "failed" })], {
				refreshedPr,
			});
			const result = await service.wait(42, 700);
			assert.equal(result.outcome, "failed");
			assert.equal(result.validatesHead, null);
			assert.deepEqual(result.pullRequest, {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: false,
				currentMergeCommit: "ABCDEF123",
				currentHeadCommit: null,
			});
			assert.match(service.formatWaitResult(result), /Validates head: unknown/);
		}
	});

	test("cancels instead of reporting when aborted during the final PR read", async () => {
		const controller = new AbortController();
		const { service } = createWaitHarness([build({ result: "succeeded" })], {
			refreshedPr: () => {
				controller.abort();
				throw new AzureRequestError("request aborted", "abort");
			},
		});
		await assert.rejects(
			service.wait(42, 700, { signal: controller.signal }),
			(error) => error.kind === "abort",
		);
	});

	for (const status of [
		"notStarted",
		"inProgress",
		"cancelling",
		"postponed",
	]) {
		test(`accepts ${status} and transitions to terminal without timeline/log calls`, async () => {
			const first = build({ status: status.toUpperCase(), result: undefined });
			const completed = build({ status: "completed", result: "SUCCEEDED" });
			const events = [];
			const { service, calls, sleeps } = createWaitHarness([first, completed]);

			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				onProgress: (event) => events.push(event),
			});

			assert.equal(result.outcome, "succeeded");
			assert.equal(result.pollCount, 2);
			assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
			assert.deepEqual(
				events.map(({ type, change }) => [type, change]),
				[
					["state", "initial"],
					["state", "changed"],
				],
			);
			assert.deepEqual(
				calls.map(({ url }) => url),
				[
					`${buildBase}/700?api-version=7.1`,
					`${buildBase}/700?api-version=7.1`,
				],
			);
			assert.ok(calls.every(({ options }) => options.method === undefined));
		});
	}

	test("uses default interval/timeout and validates inclusive service boundaries", async () => {
		const defaults = createWaitHarness([
			build({ status: "inProgress", result: undefined }),
			build({ result: "succeeded" }),
		]);
		const defaultResult = await defaults.service.wait(42, 700);
		assert.equal(defaultResult.elapsedSeconds, 60);
		assert.deepEqual(defaults.sleeps, [{ at: 0, milliseconds: 60_000 }]);

		const defaultTimeout = createWaitHarness([
			({ clock }) => {
				clock.value += 3_600_000;
				return build({ result: "succeeded" });
			},
		]);
		assert.equal(
			(await defaultTimeout.service.wait(42, 700)).outcome,
			"timeout",
		);

		for (const [intervalSeconds, timeoutSeconds] of [
			[10, 10],
			[3_600, 86_400],
		]) {
			const boundary = createWaitHarness([build({ result: "succeeded" })]);
			assert.equal(
				(
					await boundary.service.wait(42, 700, {
						intervalSeconds,
						timeoutSeconds,
					})
				).outcome,
				"succeeded",
			);
		}

		const invalidId = createWaitHarness([]);
		await assert.rejects(
			invalidId.service.wait(42, 0),
			/positive safe integer/,
		);
		assert.deepEqual(invalidId.pullRequestCalls, []);

		for (const options of [
			{ intervalSeconds: 9 },
			{ intervalSeconds: 3_601 },
			{ intervalSeconds: 10.5 },
			{ timeoutSeconds: 9 },
			{ timeoutSeconds: 86_401 },
			{ timeoutSeconds: 10.5 },
		]) {
			const invalid = createWaitHarness([]);
			await assert.rejects(
				invalid.service.wait(42, 700, options),
				/whole number from/,
			);
			assert.deepEqual(invalid.pullRequestCalls, []);
			assert.deepEqual(invalid.calls, []);
		}
	});

	test("times out with the latest valid build and never polls at the deadline", async () => {
		const observed = build({ status: "inProgress", result: undefined });
		const { service, calls, sleeps } = createWaitHarness([observed]);

		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});

		assert.deepEqual(result, {
			pullRequest: {
				id: 42,
				title: "Validate widgets",
				status: "active",
				draft: false,
				currentMergeCommit: "ABCDEF123",
				currentHeadCommit: null,
			},
			buildId: 700,
			build: observed,
			association: "pr-merge",
			pollCount: 1,
			transientFailureCount: 0,
			elapsedSeconds: 10,
			timedOut: true,
			outcome: "timeout",
			validatesHead: null,
		});
		assert.equal(calls.length, 1);
		assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
	});

	test("times out with no observation before the third transient failure", async () => {
		const { service, calls } = createWaitHarness([transientError("network")]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});
		assert.equal(result.buildId, 700);
		assert.equal(result.build, null);
		assert.equal(result.association, null);
		assert.equal(result.outcome, "timeout");
		assert.equal(result.pollCount, 1);
		assert.equal(result.transientFailureCount, 1);
		assert.equal(calls.length, 1);
	});

	test("treats a completion response received after the deadline as timeout", async () => {
		const { service, calls } = createWaitHarness([
			({ clock }) => {
				clock.value += 10_001;
				return build({ result: "succeeded" });
			},
		]);
		const result = await service.wait(42, 700, { timeoutSeconds: 10 });
		assert.equal(result.outcome, "timeout");
		assert.equal(result.buildId, 700);
		assert.equal(result.build, null);
		assert.equal(result.pollCount, 1);
		assert.equal(result.transientFailureCount, 0);
		assert.equal(calls[0].options.timeoutMs, 10_000);
	});

	test("counts a transient completing exactly at the deadline and lets timeout win", async () => {
		for (const attemptCount of [1, 2, 3]) {
			const warnings = [];
			const responses = Array.from({ length: attemptCount }, (_value, index) =>
				index === attemptCount - 1
					? ({ clock }) => {
							clock.value += 10_000;
							throw transientError("network");
						}
					: transientError("network"),
			);
			const { service, calls } = createWaitHarness(responses);
			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: attemptCount * 10,
				onProgress(event) {
					if (event.type === "transient-warning") warnings.push(event);
				},
			});
			assert.equal(result.outcome, "timeout");
			assert.equal(result.pollCount, attemptCount);
			assert.equal(result.transientFailureCount, attemptCount);
			assert.equal(calls.length, attemptCount);
			assert.equal(warnings.length, attemptCount - 1);
		}
	});

	test("ceil-clamps a fractional remaining request budget to one millisecond", async () => {
		let nowCallCount = 0;
		let requestTimeoutMs;
		const azure = {
			async request(_url, options) {
				requestTimeoutMs = options.timeoutMs;
				return build({ result: "succeeded" });
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => (nowCallCount++ === 0 ? 0 : 9_999.5),
		});

		const result = await service.wait(42, 700, { timeoutSeconds: 10 });

		assert.equal(requestTimeoutMs, 1);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.elapsedSeconds, 9.9995);
	});

	test("counts attempts, keeps cumulative failures, and resets the consecutive count after an observation", async () => {
		const warningEvents = [];
		const errors = Array.from({ length: 4 }, () => transientError("network"));
		const { service } = createWaitHarness([
			errors[0],
			errors[1],
			build({ status: "inProgress", result: undefined }),
			errors[2],
			errors[3],
			build({ result: "succeeded" }),
		]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 100,
			onProgress(event) {
				if (event.type === "transient-warning") warningEvents.push(event);
			},
		});
		assert.equal(result.pollCount, 6);
		assert.equal(result.transientFailureCount, 4);
		assert.deepEqual(
			warningEvents.map(({ attempt, consecutiveFailureCount }) => [
				attempt,
				consecutiveFailureCount,
			]),
			[
				[1, 1],
				[2, 2],
				[4, 1],
				[5, 2],
			],
		);
	});

	test("throws a sanitized operational error on the third consecutive transient failure", async () => {
		const hostile = new AzureRequestError(
			"bad\u001b[31m\u202E detail",
			"network",
		);
		const warnings = [];
		const { service, calls } = createWaitHarness([hostile, hostile, hostile]);
		await assert.rejects(
			service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 100,
				onProgress: (event) => warnings.push(event),
			}),
			(error) => {
				assert.match(error.message, /stopped after 3 consecutive transient/);
				assert.doesNotMatch(error.message, /\u001b|\u202E/);
				return true;
			},
		);
		assert.equal(calls.length, 3);
		assert.deepEqual(
			warnings.map(({ attempt, consecutiveFailureCount }) => [
				attempt,
				consecutiveFailureCount,
			]),
			[
				[1, 1],
				[2, 2],
				[3, 3],
			],
		);
	});

	test("classifies network, timeout, 408, 429, and 5xx errors as transient", async () => {
		const cases = [
			transientError("network"),
			transientError("timeout"),
			transientError("http", 408),
			transientError("http", 429),
			transientError("http", 500),
			transientError("http", 503),
			transientError("http", 599),
		];
		for (const candidate of cases) {
			const { service } = createWaitHarness([
				candidate,
				build({ result: "succeeded" }),
			]);
			const result = await service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 30,
			});
			assert.equal(result.outcome, "succeeded");
			assert.equal(result.transientFailureCount, 1);
			assert.equal(result.pollCount, 2);
		}
	});

	test("fails immediately for non-transient HTTP and response errors", async () => {
		for (const candidate of [
			transientError("http", 401),
			transientError("http", 403),
			transientError("http", 404),
			transientError("response"),
		]) {
			const { service, calls, sleeps } = createWaitHarness([candidate]);
			await assert.rejects(
				service.wait(42, 700),
				(error) => error === candidate,
			);
			assert.equal(calls.length, 1);
			assert.deepEqual(sleeps, []);
		}
	});

	test("schedules from attempt completion and honors HTTP Retry-After with five-minute heartbeats", async () => {
		const events = [];
		const scheduling = createWaitHarness([
			({ clock }) => {
				clock.value += 2_000;
				return build({ status: "inProgress", result: undefined });
			},
			build({ result: "succeeded" }),
		]);
		await scheduling.service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 30,
		});
		assert.deepEqual(
			scheduling.calls.map(({ at }) => at),
			[0, 12_000],
		);

		const retryAfter = createWaitHarness([
			transientError("http", 429, 700_000),
			build({ result: "succeeded" }),
		]);
		const result = await retryAfter.service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 1_000,
			onProgress: (event) => events.push(event),
		});
		assert.equal(result.outcome, "succeeded");
		assert.deepEqual(
			retryAfter.calls.map(({ at }) => at),
			[0, 700_000],
		);
		assert.deepEqual(
			retryAfter.sleeps.map(({ milliseconds }) => milliseconds),
			[300_000, 300_000, 100_000],
		);
		assert.equal(events.filter(({ type }) => type === "heartbeat").length, 2);
		assert.equal(
			events.filter(({ type }) => type === "transient-warning")[0].retryAfterMs,
			700_000,
		);
	});

	test("clips a saturated Retry-After sleep and request timeout to the overall deadline", async () => {
		const { service, calls, sleeps } = createWaitHarness([
			transientError("http", 429, Number.MAX_SAFE_INTEGER),
		]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 10,
		});
		assert.equal(result.outcome, "timeout");
		assert.deepEqual(sleeps, [{ at: 0, milliseconds: 10_000 }]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.timeoutMs, 10_000);
	});

	test("cancels promptly during an injected sleep", async () => {
		const controller = new AbortController();
		const sleepStarted = deferred();
		const azure = {
			async request() {
				return build({ status: "inProgress", result: undefined });
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const sleep = () =>
			new Promise(() => {
				sleepStarted.resolve();
			});
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
			sleep,
		});
		const waiting = service.wait(42, 700, {
			intervalSeconds: 10,
			signal: controller.signal,
		});
		await sleepStarted.promise;
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
	});

	test("cancels the active request through the caller signal", async () => {
		const controller = new AbortController();
		const requestStarted = deferred();
		const azure = {
			request(_url, options) {
				requestStarted.resolve();
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => reject(new AzureRequestError("request aborted", "abort")),
						{ once: true },
					);
				});
			},
			async requestWithMetadata() {
				throw new Error("unexpected");
			},
		};
		const service = createBuildService({
			azure,
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
		});
		const waiting = service.wait(42, 700, { signal: controller.signal });
		await requestStarted.promise;
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
	});

	test("does not invoke an injected sleep when abort happens during listener installation", async () => {
		const controller = new AbortController();
		const originalAddEventListener = controller.signal.addEventListener.bind(
			controller.signal,
		);
		controller.signal.addEventListener = (...args) => {
			originalAddEventListener(...args);
			controller.abort();
		};
		let sleepCalls = 0;
		const service = createBuildService({
			azure: {
				async request() {
					return build({ status: "inProgress", result: undefined });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: createPullRequestStub().service,
			now: () => 0,
			sleep: async () => {
				sleepCalls += 1;
			},
		});

		await assert.rejects(
			service.wait(42, 700, { intervalSeconds: 10, signal: controller.signal }),
			(error) => error.kind === "abort",
		);
		assert.equal(sleepCalls, 0);
	});

	test("passes bounded read controls to PR resolution and cancels it promptly", async () => {
		const controller = new AbortController();
		const resolutionStarted = deferred();
		let controls;
		let buildPolls = 0;
		const service = createBuildService({
			azure: {
				async request() {
					buildPolls += 1;
					return build({ result: "succeeded" });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: {
				resolve(_requestedPrId, options) {
					controls = options;
					resolutionStarted.resolve();
					return new Promise((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() =>
								reject(new AzureRequestError("resolution aborted", "abort")),
							{ once: true },
						);
					});
				},
				async get() {
					throw new Error("unexpected");
				},
			},
		});

		const waiting = service.wait(42, 700, { signal: controller.signal });
		await resolutionStarted.promise;
		assert.equal(controls.signal, controller.signal);
		assert.equal(controls.timeoutMs, 30_000);
		assert.equal(controls.maxResponseBytes, 16 * 1024 * 1024);
		controller.abort();
		await assert.rejects(waiting, (error) => error.kind === "abort");
		assert.equal(buildPolls, 0);
	});

	test("snapshots signal and progress callback before resolving the PR", async () => {
		const resolution = deferred();
		const originalController = new AbortController();
		const replacementController = new AbortController();
		replacementController.abort();
		const originalEvents = [];
		const replacementEvents = [];
		const options = {
			signal: originalController.signal,
			onProgress: (event) => originalEvents.push(event),
		};
		const service = createBuildService({
			azure: {
				async request() {
					return build({ result: "succeeded" });
				},
				async requestWithMetadata() {
					throw new Error("unexpected");
				},
			},
			ctx,
			pullRequests: {
				async resolve() {
					await resolution.promise;
					return pullRequest();
				},
				async get() {
					throw new Error("unexpected");
				},
			},
			now: () => 0,
		});

		const waiting = service.wait(42, 700, options);
		options.signal = replacementController.signal;
		options.onProgress = (event) => replacementEvents.push(event);
		resolution.resolve();
		const result = await waiting;

		assert.equal(result.outcome, "succeeded");
		assert.equal(originalEvents.length, 1);
		assert.equal(replacementEvents.length, 0);
	});

	test("awaits async progress and propagates rejection without an unhandled promise", async () => {
		const callbackStarted = deferred();
		const callbackRelease = deferred();
		const { service } = createWaitHarness([build({ result: "succeeded" })]);
		let settled = false;
		const waiting = service.wait(42, 700, {
			async onProgress() {
				callbackStarted.resolve();
				await callbackRelease.promise;
			},
		});
		void waiting.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await callbackStarted.promise;
		assert.equal(settled, false);
		callbackRelease.resolve();
		assert.equal((await waiting).outcome, "succeeded");

		const rejection = new Error("progress failed");
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const rejected = createWaitHarness([build({ result: "succeeded" })]);
			await assert.rejects(
				rejected.service.wait(42, 700, {
					onProgress: async () => {
						throw rejection;
					},
				}),
				(error) => error === rejection,
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	test("caller abort wins when a progress callback aborts and rejects", async () => {
		const controller = new AbortController();
		const { service } = createWaitHarness([build({ result: "succeeded" })]);
		await assert.rejects(
			service.wait(42, 700, {
				signal: controller.signal,
				async onProgress() {
					controller.abort();
					throw new Error("callback rejection");
				},
			}),
			(error) => error.kind === "abort",
		);
	});

	test("caller abort cancels a pending async progress callback and consumes its late rejection", async () => {
		const controller = new AbortController();
		const callbackStarted = deferred();
		const callbackResult = deferred();
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { service } = createWaitHarness([build({ result: "succeeded" })]);
			const waiting = service.wait(42, 700, {
				signal: controller.signal,
				onProgress() {
					callbackStarted.resolve();
					return callbackResult.promise;
				},
			});
			await callbackStarted.promise;
			controller.abort();
			await assert.rejects(waiting, (error) => error.kind === "abort");
			callbackResult.reject(new Error("late callback rejection"));
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	test("progress receives deep snapshots that cannot mutate wait state or its result", async () => {
		const running = build({ status: "inProgress", result: undefined });
		const completed = build({ status: "completed", result: "succeeded" });
		const seen = [];
		const { service } = createWaitHarness([running, completed]);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			onProgress(event) {
				seen.push({
					prId: event.pullRequest.id,
					status: event.build?.status,
					repositoryId: event.build?.repository?.id,
				});
				event.pullRequest.id = 999;
				event.pullRequest.title = "mutated";
				if (event.build !== null) {
					event.build.id = 999;
					event.build.status = "completed";
					event.build.result = "failed";
					event.build.repository.id = "other";
					event.build._links.web.href = "mutated";
				}
			},
		});

		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 700);
		assert.equal(result.pullRequest.id, 42);
		assert.equal(result.pullRequest.title, "Validate widgets");
		assert.equal(result.build.id, 700);
		assert.equal(result.build.result, "succeeded");
		assert.equal(result.build.repository.id, "repo-id");
		assert.equal(
			result.build._links.web.href,
			"https://dev.azure.com/build/700",
		);
		assert.deepEqual(seen, [
			{ prId: 42, status: "inProgress", repositoryId: "repo-id" },
			{ prId: 42, status: "completed", repositoryId: "repo-id" },
		]);
		assert.equal(running.id, 700);
		assert.equal(completed.id, 700);
	});

	test("bounds sanitized transient error text in warnings and operational errors", async () => {
		const hostile = new AzureRequestError(
			`bad\u001b[31m\u202E${"x".repeat(20_000)}`,
			"network",
		);
		const warnings = [];
		const { service } = createWaitHarness([hostile, hostile, hostile]);
		await assert.rejects(
			service.wait(42, 700, {
				intervalSeconds: 10,
				timeoutSeconds: 100,
				onProgress(event) {
					if (event.type === "transient-warning") warnings.push(event);
				},
			}),
			(error) => {
				assert.doesNotMatch(error.message, /\u001b|\u202E/);
				assert.ok(error.message.length < 4_300);
				assert.match(error.message, /\[truncated\]$/);
				return true;
			},
		);
		assert.equal(warnings.length, 3);
		assert.ok(warnings.every(({ error }) => error.length <= 4_096));
		assert.ok(warnings.every(({ error }) => !/\u001b|\u202E/.test(error)));
	});

	test("rejects wrong IDs, association changes, and missing/none/unknown statuses immediately", async () => {
		const changedAssociation = createWaitHarness([
			build({ status: "inProgress", result: undefined }),
			build({ repository: { id: "other", type: "TfsGit" } }),
		]);
		await assert.rejects(
			changedAssociation.service.wait(42, 700, { intervalSeconds: 10 }),
			/repository ID/,
		);
		assert.equal(changedAssociation.calls.length, 2);

		const cases = [
			[build({ id: 701 }), /expected 700/],
			[build({ repository: { id: "other", type: "TfsGit" } }), /repository ID/],
			[
				build({ repository: { id: "repo-id", type: "GitHub" } }),
				/repository type/,
			],
			[build({ reason: "manual" }), /reason/],
			[build({ sourceBranch: "refs/pull/99/merge" }), /source branch/],
			[build({ status: undefined }), /no build status/],
			[build({ status: null }), /no build status/],
			[build({ status: "none" }), /unknown build status none/],
			[build({ status: "queued" }), /unknown build status queued/],
		];
		for (const [candidate, expected] of cases) {
			const { service, calls } = createWaitHarness([candidate]);
			await assert.rejects(service.wait(42, 700), expected);
			assert.equal(calls.length, 1);
		}
	});

	test("de-duplicates unchanged progress states and sanitizes all human wait text", async () => {
		const events = [];
		const hostilePr = pullRequest({ title: "widgets\u001b[31m\u202E" });
		const { service } = createWaitHarness(
			[
				build({ status: "inProgress", result: undefined }),
				build({ status: "INPROGRESS", result: undefined }),
				build({ status: "postponed", result: "odd\u001b[31m\u202E" }),
				build({ status: "completed", result: "failed\u202E" }),
			],
			{ resolvedPr: hostilePr },
		);
		const result = await service.wait(42, 700, {
			intervalSeconds: 10,
			timeoutSeconds: 40,
			onProgress: (event) => events.push(event),
		});
		const states = events.filter(({ type }) => type === "state");
		assert.deepEqual(
			states.map(({ change, status }) => [change, status]),
			[
				["initial", "inProgress"],
				["changed", "postponed"],
				["changed", "completed"],
			],
		);
		const formattedProgress = service.formatWaitProgress({
			...states[1],
			status: "bad\u001b[31m\u202E",
			result: "bad\u001b[0m",
			build: build({ status: "bad\u001b[31m\u202E", result: "bad\u001b[0m" }),
		});
		const formattedResult = service.formatWaitResult(result);
		assert.doesNotMatch(formattedProgress, /\u001b|\u202E/);
		assert.doesNotMatch(formattedResult, /\u001b|\u202E/);
		assert.match(
			formattedProgress,
			/PR #42, build 700.*status|PR #42, build 700.*state/,
		);
		assert.match(formattedResult, /outcome unknown/);

		for (const outcome of [
			"partiallySucceeded",
			"failed",
			"canceled",
			"unknown",
		]) {
			const failureText = service.formatWaitResult({
				...result,
				build: build({ result: outcome }),
				outcome,
			});
			assert.match(failureText, /pr\.sh build show --pr 42 --build 700/);
		}
		const timeoutText = service.formatWaitResult({
			...result,
			build: null,
			timedOut: true,
			outcome: "timeout",
		});
		assert.match(timeoutText, /build 700.*timed out/);
		assert.doesNotMatch(timeoutText, /requested build/);
	});
});

describe("build wait --latest follows the PR head", () => {
	const newHead = () =>
		pullRequest({
			...headPr(),
			lastMergeSourceCommit: { commitId: "HEAD-2" },
			lastMergeCommit: { commitId: "new-merge" },
		});
	const noBuilds = () => [{ value: [] }, { value: [] }];
	const listed = (candidate) => [{ value: [candidate] }, { value: [] }];

	function followHarness(responses, refreshed = [], options = {}) {
		let reads = 0;
		const harness = createWaitHarness(responses, {
			resolvedPr: headPr(),
			refreshedPr: () => {
				const next = refreshed[Math.min(reads++, refreshed.length - 1)];
				if (next instanceof Error) throw next;
				return next;
			},
			...options,
		});
		const events = [];
		const wait = (waitOptions = {}) =>
			harness.service.wait(42, "latest", {
				onProgress: (event) => events.push(event),
				...waitOptions,
			});
		return { ...harness, events, wait };
	}

	test("waits for a build to appear, then follows it to the end", async () => {
		const { service, events, pullRequestCalls, wait } = followHarness(
			[
				...noBuilds(),
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[headPr()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 700);
		assert.equal(result.validatesHead, true);
		assert.equal(result.pollCount, 3);
		assert.deepEqual(
			events.map(({ type }) => type),
			["waiting-for-build", "build-selected", "state", "state"],
		);
		assert.equal(
			service.formatWaitProgress(events[0]),
			"PR #42: no build validates head HEAD-1 yet; waiting for one.",
		);
		assert.equal(
			service.formatWaitProgress(events[1]),
			"PR #42, build 700: selected for head HEAD-1.",
		);
		assert.deepEqual(pullRequestCalls, [
			{ method: "resolve", requestedPrId: 42 },
			{ method: "get", prId: 42 },
			{ method: "get", prId: 42 },
		]);
	});

	test("ends with no-build when no build validates the head within 10 minutes", async () => {
		const { service, wait } = followHarness(
			[...noBuilds(), ...noBuilds(), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 300 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.buildId, null);
		assert.equal(result.build, null);
		assert.equal(result.timedOut, false);
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(
			service.formatWaitResult(result),
			"No build validated the head of PR #42 (commit HEAD-1) within 10 minutes; 600.0s elapsed; 3 poll(s); 0 transient failure(s).\n" +
				"Draft: yes. Check that the build policy runs for this pull request, or queue a build with `pr.sh build queue --pr 42`.",
		);
	});

	test("times out instead when the timeout is shorter than the wait for a build", async () => {
		const { service, wait } = followHarness(
			[...noBuilds(), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 30, timeoutSeconds: 60 });
		assert.equal(result.outcome, "timeout");
		assert.equal(result.buildId, null);
		assert.match(
			service.formatWaitResult(result),
			/^build wait for PR #42 timed out before a build validated head HEAD-1;/,
		);
	});

	test("switches to the build for the new head when the head moves", async () => {
		const next = build({ id: 701, sourceVersion: "new-merge" });
		const { service, events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...listed({ ...next, status: "inProgress" }),
				{ ...next, result: "succeeded" },
			],
			[newHead()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.buildId, 701);
		assert.equal(result.validatesHead, true);
		assert.equal(result.pullRequest.currentHeadCommit, "HEAD-2");
		const switched = events.filter(({ type }) => type === "build-selected");
		assert.deepEqual(
			switched.map(({ buildId, previousBuildId }) => [
				buildId,
				previousBuildId,
			]),
			[
				[700, null],
				[701, 700],
			],
		);
		assert.equal(
			service.formatWaitProgress(switched[1]),
			"PR #42, build 701: selected for head HEAD-2. The head moved, so build 700 no longer counts.",
		);
	});

	test("ends with no-build when the head moves and no build follows", async () => {
		const { events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...noBuilds(),
				...noBuilds(),
				...noBuilds(),
			],
			[newHead()],
		);
		const result = await wait({ intervalSeconds: 300 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 900);
		const waiting = events.filter(({ type }) => type === "waiting-for-build");
		assert.equal(waiting.length, 1);
		assert.equal(waiting[0].pullRequest.currentHeadCommit, "HEAD-2");
	});

	test("keeps the selected build when only the merge commit changes", async () => {
		const { wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[
				pullRequest({
					...headPr(),
					lastMergeCommit: { commitId: "new-merge" },
				}),
			],
		);
		const result = await wait();
		assert.equal(result.buildId, 700);
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.validatesHead, false);
	});

	test("ends with no-build after 10 minutes even with a longer interval", async () => {
		const { wait } = followHarness([...noBuilds(), ...noBuilds()], [headPr()]);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(result.pollCount, 2);
	});

	test("ends with no-build on time after a transient failure", async () => {
		const { wait } = followHarness(
			[...noBuilds(), transientError("http", 503), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.transientFailureCount, 1);
		assert.equal(result.elapsedSeconds, 600);
	});

	test("caps a retry after a transient failure at the end of the wait for a build", async () => {
		const { wait } = followHarness(
			[transientError("http", 503), ...noBuilds()],
			[headPr()],
		);
		const result = await wait({ intervalSeconds: 3600, timeoutSeconds: 7200 });
		assert.equal(result.outcome, "no-build");
		assert.equal(result.elapsedSeconds, 600);
		assert.equal(result.pollCount, 2);
	});

	test("follows the head through two moves", async () => {
		const third = pullRequest({
			...headPr(),
			lastMergeSourceCommit: { commitId: "HEAD-3" },
			lastMergeCommit: { commitId: "third-merge" },
		});
		const last = build({ id: 702, sourceVersion: "third-merge" });
		const { events, wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				...noBuilds(),
				...listed({ ...last, status: "inProgress" }),
				{ ...last, result: "succeeded" },
			],
			[newHead(), third],
		);
		const result = await wait();
		assert.equal(result.buildId, 702);
		assert.equal(result.outcome, "succeeded");
		assert.deepEqual(
			events
				.filter(({ type }) => type === "build-selected")
				.map(({ buildId, previousBuildId }) => [buildId, previousBuildId]),
			[
				[700, null],
				[702, 700],
			],
		);
	});

	test("retries a transient failure while rereading the PR", async () => {
		const { wait } = followHarness(
			[
				...listed(build({ status: "inProgress" })),
				build({ status: "inProgress" }),
				build({ result: "succeeded" }),
			],
			[transientError("http", 503), headPr()],
		);
		const result = await wait();
		assert.equal(result.outcome, "succeeded");
		assert.equal(result.transientFailureCount, 1);
	});

	test("stops with an error when the PR is not active and no build is selected", async () => {
		const completed = pullRequest({ ...headPr(), status: "completed" });
		const atStart = followHarness([], [completed], { resolvedPr: completed });
		await assert.rejects(atStart.wait(), /PR #42 is completed/);
		assert.equal(atStart.calls.length, 0);

		const whileWaiting = followHarness([...noBuilds()], [completed]);
		await assert.rejects(whileWaiting.wait(), /PR #42 is completed/);
	});

	test("keeps --build pinned when the head moves", async () => {
		const { service } = createWaitHarness(
			[build({ status: "inProgress" }), build({ result: "succeeded" })],
			{ resolvedPr: headPr(), refreshedPr: newHead() },
		);
		const result = await service.wait(42, 700, { intervalSeconds: 10 });
		assert.equal(result.buildId, 700);
		assert.equal(result.validatesHead, false);
	});
});
