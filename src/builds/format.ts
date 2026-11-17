import { stripTerminalControls } from "../shared/terminal.ts";
import {
	type AzureBuild,
	display,
	normalized,
	validateBuild,
} from "./azure-builds.ts";
import type {
	BuildListEnvelope,
	BuildShowEnvelope,
	BuildWaitEnvelope,
	BuildWaitProgress,
	ListedBuild,
	ProblemRecord,
} from "./builds.ts";
import { orderTimelineRecords } from "./diagnosis.ts";
import { buildAssociation } from "./head-builds.ts";
import { WAIT_FOR_BUILD_MINUTES } from "./wait.ts";

const MAX_DISPLAY_DEPTH = 20;

const DISPLAY_RECORD_TYPES = new Set(["stage", "job", "task"]);

function buildWebLink(build: AzureBuild): string | undefined {
	const web = build._links?.web;
	return typeof web?.href === "string" && web.href.length > 0
		? web.href
		: undefined;
}

function buildDefinitionName(build: AzureBuild): string {
	return build.definition?.name ?? "unknown";
}

function yesNoUnknown(value: boolean | null): string {
	if (value === null) return "unknown";
	return value ? "yes" : "no";
}

function formatBuildRow(build: ListedBuild): string {
	return [
		`- Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
		`  Association: ${build.association}`,
		`  Status/result: ${display(build.status)}/${display(build.result)} [${build.current ? "current" : "history"}]`,
		`  Queue/start/finish: ${display(build.queueTime)} / ${display(build.startTime)} / ${display(build.finishTime)}`,
		`  ${display(buildWebLink(build))}`,
	].join("\n");
}

function formatTimeline(result: BuildShowEnvelope): string[] {
	const rows = orderTimelineRecords(result.timeline).filter(({ record }) =>
		DISPLAY_RECORD_TYPES.has(normalized(record.type ?? "")),
	);
	if (rows.length === 0) return ["(no stage/job/task records)"];
	return rows.map(({ record, depth, orphanParent, cycle }) => {
		const anomaly = [
			...(orphanParent === undefined
				? []
				: [`orphan parent ${display(orphanParent)}`]),
			...(cycle ? ["cycle"] : []),
			...(depth > MAX_DISPLAY_DEPTH ? [`depth ${depth}`] : []),
		];
		return (
			`${"  ".repeat(Math.min(depth, MAX_DISPLAY_DEPTH))}- ${display(record.type)}/${display(record.name)}: ` +
			`state=${display(record.state)}, result=${display(record.result)}, attempt=${display(record.attempt)}` +
			(anomaly.length === 0 ? "" : ` [${anomaly.join(", ")}]`)
		);
	});
}

function formatProblemRecord(problem: ProblemRecord, index: number): string {
	const record = problem.record;
	const header =
		`Problem ${index + 1}: ${display(record.type)}/${display(record.name)} ` +
		`[${display(record.result)}]`;
	const issues =
		problem.issues.length === 0
			? ["Issues: (none)"]
			: [
					"Issues:",
					...problem.issues.map(
						(issue) =>
							`- ${display(issue.type)}/${display(issue.category)}: ${display(issue.message)}`,
					),
				];
	if ("noLog" in problem) {
		return [header, ...issues, "Log: (no log reference)"].join("\n");
	}
	const mode =
		problem.logMode === "full"
			? "full log (potentially sensitive)"
			: `tail log (lines ${problem.logRange?.startLine}-${problem.logRange?.endLine})`;
	if ("logError" in problem) {
		return [
			header,
			...issues,
			`Log (${mode}): ERROR: ${display(problem.logError)}`,
		].join("\n");
	}
	return [
		header,
		...issues,
		`Log (${mode}):`,
		stripTerminalControls(problem.logText),
	].join("\n");
}

export function formatList(result: BuildListEnvelope): string {
	const scope = result.history ? "history" : "current head";
	if (result.builds.length === 0) {
		const hint =
			result.hiddenBuilds === 0
				? ""
				: ` ${result.hiddenBuilds} stale ${result.hiddenBuilds === 1 ? "build exists" : "builds exist"}; use build list --history or build show --latest.`;
		return `No associated ${scope} builds found for PR #${result.pullRequest.id}.${hint}`;
	}
	return [
		`Builds for PR #${result.pullRequest.id}: ${display(result.pullRequest.title)} (${scope})`,
		"",
		...result.builds.flatMap((build, index) => [
			formatBuildRow(build),
			...(index === result.builds.length - 1 ? [] : [""]),
		]),
	].join("\n");
}

export function formatShow(result: BuildShowEnvelope): string {
	const build = result.build;
	const problemSections =
		result.problemRecords.length === 0
			? ["(no problem records)"]
			: result.problemRecords.map(formatProblemRecord);
	return [
		`Build ${build.id as number}/${display(build.buildNumber)} — ${display(buildDefinitionName(build))}`,
		`PR: #${result.pullRequest.id} (${result.current ? "current" : "history; stale"})`,
		`Association: ${result.association}; commit: ${display(build.sourceVersion)}`,
		`Status/result: ${display(build.status)}/${display(build.result)}`,
		`Queue/start/finish: ${display(build.queueTime)} / ${display(build.startTime)} / ${display(build.finishTime)}`,
		`URL: ${display(buildWebLink(build))}`,
		"",
		"Timeline:",
		...formatTimeline(result),
		"",
		result.problemRecords.some(
			(problem) => "logMode" in problem && problem.logMode === "full",
		)
			? "Problem diagnostics (FULL LOGS; potentially sensitive):"
			: "Problem diagnostics (final 200 lines per log):",
		...problemSections.flatMap((section, index) => [
			...(index === 0 ? [] : [""]),
			section,
		]),
	].join("\n");
}

export function formatRetry(build: AzureBuild): string {
	validateBuild(build, "retry result build");
	return [
		`Azure DevOps accepted the retry request for build ${build.id as number}/${display(build.buildNumber)}.`,
		`Association: ${buildAssociation(build)}`,
		`Returned status/result: ${display(build.status)}/${display(build.result)}`,
		`URL: ${display(buildWebLink(build))}`,
	].join("\n");
}

export function formatQueue(build: AzureBuild, prId?: number): string {
	const definition = build.definition;
	return [
		`Azure DevOps queued build ${build.id as number}/${display(build.buildNumber)}.`,
		...(typeof definition?.name === "string"
			? [
					`Build pipeline: ${display(definition.name)}${typeof definition.id === "number" ? ` (${definition.id})` : ""}`,
				]
			: []),
		`URL: ${display(buildWebLink(build))}`,
		...(prId === undefined
			? []
			: [
					`Wait with: pr.sh build wait --build ${build.id as number} --pr ${prId}`,
				]),
	].join("\n");
}

export function formatRequeue(evaluationId: string, prId: number): string {
	return [
		`Requeued build policy evaluation ${display(evaluationId)} for PR #${prId}.`,
		`Azure DevOps did not return the build ID yet. When \`pr.sh build show --latest --pr ${prId}\` shows a new build ID, run \`pr.sh build wait --build <id> --pr ${prId}\`.`,
	].join("\n");
}

export function formatWaitProgress(event: BuildWaitProgress): string {
	const state = `${display(event.build?.status)}/${display(event.build?.result)}`;
	const counters =
		`${event.elapsedSeconds.toFixed(1)}s elapsed; ${event.pollCount} poll(s); ` +
		`${event.transientFailureCount} transient failure(s)`;
	const prefix =
		event.buildId === null
			? `PR #${event.pullRequest.id}`
			: `PR #${event.pullRequest.id}, build ${event.buildId}`;
	const head = display(event.pullRequest.currentHeadCommit);
	if (event.type === "build-selected") {
		const replaced =
			event.previousBuildId === null
				? ""
				: ` The head moved, so build ${event.previousBuildId} no longer counts.`;
		return `${prefix}: selected for head ${head}.${replaced}`;
	}
	if (event.type === "waiting-for-build") {
		return `${prefix}: no build validates head ${head} yet; waiting for one.`;
	}
	if (event.type === "state") {
		return `${prefix}: ${event.change} state ${state}; ${counters}.`;
	}
	if (event.type === "heartbeat") {
		return `${prefix}: still waiting at ${state}; ${counters}.`;
	}
	return (
		`${prefix}: transient warning on attempt ${event.attempt} ` +
		`(consecutive ${event.consecutiveFailureCount}): ${display(event.error)}; ` +
		`${state}; ${counters}.`
	);
}

function formatNoBuild(result: BuildWaitEnvelope, counters: string): string {
	const pr = result.pullRequest;
	return (
		`No build validated the head of PR #${pr.id} (commit ${display(pr.currentHeadCommit)}) within ${WAIT_FOR_BUILD_MINUTES} minutes; ${counters}.\n` +
		`Draft: ${yesNoUnknown(pr.draft)}. Check that the build policy runs for this pull request, or queue a build with \`pr.sh build queue --pr ${pr.id}\`.`
	);
}

function formatTimeout(
	result: BuildWaitEnvelope,
	statusResult: string,
	counters: string,
): string {
	const pr = result.pullRequest;
	if (result.buildId === null) {
		return `build wait for PR #${pr.id} timed out before a build validated head ${display(pr.currentHeadCommit)}; ${counters}.`;
	}
	return (
		`build ${result.buildId} for PR #${pr.id} timed out. ` +
		`Latest status/result: ${statusResult}; ${counters}.\nAssociation: ${display(result.association)}`
	);
}

export function formatWaitResult(result: BuildWaitEnvelope): string {
	const buildId = result.buildId;
	const identifier = buildId === null ? "build wait" : `build ${buildId}`;
	const statusResult = `${display(result.build?.status)}/${display(result.build?.result)}`;
	const counters =
		`${result.elapsedSeconds.toFixed(1)}s elapsed; ${result.pollCount} poll(s); ` +
		`${result.transientFailureCount} transient failure(s)`;
	if (result.outcome === "no-build") return formatNoBuild(result, counters);
	if (result.timedOut) return formatTimeout(result, statusResult, counters);
	const lines = [
		`${identifier} for PR #${result.pullRequest.id} finished with outcome ${display(result.outcome)}.`,
		`Status/result: ${statusResult}; ${counters}.`,
		`Association: ${display(result.association)}`,
		`Validates head: ${yesNoUnknown(result.validatesHead)}`,
	];
	if (
		result.validatesHead === false &&
		result.pullRequest.status?.toLowerCase() === "active"
	) {
		lines.push(
			`This build doesn't validate the current head of the pull request; wait for the build that does with \`pr.sh build wait --latest --pr ${result.pullRequest.id}\`.`,
		);
	}
	if (result.outcome !== "succeeded" && buildId !== null) {
		lines.push(
			`Inspect failure details with \`pr.sh build show --pr ${result.pullRequest.id} --build ${buildId}\`.`,
		);
	}
	return lines.join("\n");
}
