/**
 * Creates, lists, inspects, and edits Azure DevOps pull requests, and manages their comment threads
 * from a git checkout whose origin remote points at Azure Repos.
 *
 * Auth: requires an AZURE_DEVOPS_PAT env var. Code (Read) is enough for PR/comment reads; Code
 * (Read & Write) is needed for PR/comment mutations. Build queries need Build (Read), also named
 * vso.build; build retries additionally need Build execute (vso.build_execute). Build commands cover
 * YAML/classic Build API validations only, never Releases, external checks, or individual retries.
 * Reviewer additions additionally need Identity (Read), while reviewer removal resolves the PR's
 * current reviewers using Code access only.
 * Run this via pr.sh, which accepts an exported PAT or loads one from .env.
 *
 * Images use a bidirectional placeholder contract: every upload needs a matching
 * {{image:<basename>}}, and every such placeholder needs an upload. Create/edit uploads replace
 * every exact match with marked image Markdown; edit removal strips only exact marked references.
 */
import { createAzureRequester, pullRequestWebUrl } from "./shared/azure.ts";
import { createBatchRunner } from "./comments/batch.ts";
import { createBuildService } from "./builds/builds.ts";
import { getPat, parseArgs } from "./cli/cli.ts";
import type { CliOptions } from "./cli/operation-types.ts";
import { createFileAnchorService } from "./comments/file-anchors.ts";
import { getRepoContext, type AzureDevOpsRepoContext } from "./shared/lib.ts";
import {
	buildWaitExitCode,
	toCommentLocation,
} from "./shared/operation-types.ts";
import { createPullRequestService } from "./pull-requests/pull-requests.ts";
import { createThreadService } from "./comments/threads.ts";

function assertNever(value: never): never {
	throw new Error(`Unhandled command: ${JSON.stringify(value)}`);
}

function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(
		/[\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

async function runBuildWait(
	options: Extract<CliOptions, { resource: "build"; command: "wait" }>,
	builds: ReturnType<typeof createBuildService>,
): Promise<void> {
	const controller = new AbortController();
	let signalNumber: number | undefined;
	let signalCount = 0;
	const onSignal = (number: number) => {
		signalCount += 1;
		if (signalCount > 1) {
			process.exit(number);
		}
		signalNumber = number;
		controller.abort();
	};
	const onInterrupt = () => onSignal(130);
	const onTerminate = () => onSignal(143);
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	try {
		const result = await builds.wait(options.pr, options.build, {
			intervalSeconds: options.intervalSeconds,
			timeoutSeconds: options.timeoutSeconds,
			signal: controller.signal,
			onProgress: (event) => console.error(builds.formatWaitProgress(event)),
		});
		if (signalNumber !== undefined) {
			process.exitCode = signalNumber;
			return;
		}
		console.log(
			options.json ? safeJson(result) : builds.formatWaitResult(result),
		);
		process.exitCode = buildWaitExitCode(result);
	} catch (error) {
		if (signalNumber !== undefined || controller.signal.aborted) {
			process.exitCode = signalNumber ?? 130;
			return;
		}
		throw error;
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onTerminate);
	}
}

async function runBuildCommand(
	options: Extract<CliOptions, { resource: "build" }>,
	builds: ReturnType<typeof createBuildService>,
): Promise<void> {
	switch (options.command) {
		case "list": {
			const result = await builds.list(options.pr, {
				history: options.history,
			});
			console.log(
				options.json
					? JSON.stringify(result, null, 2)
					: builds.formatList(result),
			);
			return;
		}
		case "show": {
			const result = await builds.show(options.pr, options.build, {
				fullLogs: options.fullLogs,
			});
			console.log(
				options.json
					? JSON.stringify(result, null, 2)
					: builds.formatShow(result),
			);
			if (builds.hasLogErrors(result)) process.exitCode = 1;
			return;
		}
		case "retry": {
			const result = await builds.retry(options.pr, options.build);
			console.log(builds.formatRetry(result));
			return;
		}
		case "wait": {
			await runBuildWait(options, builds);
			return;
		}
	}
	return assertNever(options);
}

async function runPullRequestCommand(
	options: Extract<CliOptions, { resource: "pr" }>,
	pullRequests: ReturnType<typeof createPullRequestService>,
	ctx: AzureDevOpsRepoContext,
): Promise<void> {
	switch (options.command) {
		case "list": {
			const prs = await pullRequests.list();
			if (options.json) {
				console.log(JSON.stringify(prs, null, 2));
				return;
			}
			if (prs.length === 0) {
				console.log(
					"No active pull requests created by you in this repository.",
				);
				return;
			}
			console.log("Active pull requests created by you:\n");
			console.log(
				prs.map((pr) => pullRequests.formatListItem(pr)).join("\n\n"),
			);
			return;
		}
		case "create": {
			const pr = await pullRequests.create(options);
			console.log(`Created PR #${pr.pullRequestId}: ${pr.title}`);
			console.log(pullRequestWebUrl(ctx, pr.pullRequestId));
			return;
		}
		case "show": {
			const pr = await pullRequests.resolve(options.pr);
			console.log(
				options.json ? JSON.stringify(pr, null, 2) : pullRequests.format(pr),
			);
			return;
		}
		case "edit": {
			const prId = await pullRequests.edit(options.pr, options);
			console.log(`Updated PR #${prId}.`);
			console.log(pullRequestWebUrl(ctx, prId));
			return;
		}
	}
	return assertNever(options);
}

async function runCommentCommand(
	options: Extract<CliOptions, { resource: "comment" }>,
	pullRequests: ReturnType<typeof createPullRequestService>,
	threads: ReturnType<typeof createThreadService>,
	batch: ReturnType<typeof createBatchRunner>,
): Promise<void> {
	const prId = await pullRequests.resolveId(options.pr);

	switch (options.command) {
		case "list": {
			const commentThreads = await threads.list(prId, options);

			if (options.json) {
				console.log(JSON.stringify(commentThreads, null, 2));
				return;
			}
			if (commentThreads.length === 0) {
				console.log(`No matching comment threads on PR #${prId}.`);
				return;
			}
			console.log(`Comment threads on PR #${prId}:\n`);
			console.log(
				commentThreads
					.map((thread) => threads.format(thread, prId))
					.join("\n\n"),
			);
			console.log("\n---\n\nSummary:\n");
			console.log(threads.formatSummary(commentThreads, prId));
			return;
		}
		case "create": {
			const location = toCommentLocation(options);
			const thread = await threads.comment(prId, options.message, location);
			console.log(`Posted new comment thread ${thread.id} on PR #${prId}.`);
			console.log(threads.webUrl(prId, thread.id));
			return;
		}
		case "reply": {
			await threads.reply(prId, options.thread, options.message);
			console.log(`Posted reply to thread ${options.thread} on PR #${prId}.`);
			return;
		}
		case "edit": {
			await threads.edit(
				prId,
				options.thread,
				options.comment,
				options.message,
			);
			console.log(
				`Edited comment ${options.comment} in thread ${options.thread} on PR #${prId}.`,
			);
			return;
		}
		case "delete": {
			await threads.delete(prId, options.thread, options.comment);
			console.log(
				`Deleted comment ${options.comment} from thread ${options.thread} on PR #${prId}.`,
			);
			return;
		}
		case "resolve": {
			await threads.resolve(prId, options.thread);
			console.log(
				`Marked thread ${options.thread} on PR #${prId} as resolved.`,
			);
			return;
		}
		case "batch": {
			await batch.run(prId);
			return;
		}
	}

	return assertNever(options);
}

async function main(): Promise<void> {
	const options = parseArgs();
	const pat = getPat();
	const ctx = await getRepoContext();

	const azure = createAzureRequester({ pat });
	const pullRequests = createPullRequestService({ azure, ctx });
	const fileAnchors = createFileAnchorService({ azure, ctx });
	const threads = createThreadService({ azure, ctx, fileAnchors });
	const batch = createBatchRunner({ threads });
	const builds = createBuildService({ azure, ctx, pullRequests });

	if (options.resource === "build") return runBuildCommand(options, builds);
	if (options.resource === "pr")
		return runPullRequestCommand(options, pullRequests, ctx);
	return runCommentCommand(options, pullRequests, threads, batch);
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
