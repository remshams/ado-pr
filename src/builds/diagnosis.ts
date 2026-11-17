import {
	type BuildLogMetadata,
	type BuildTimeline,
	display,
	normalized,
	type TimelineRecord,
} from "./azure-builds.ts";
import type { BuildLogRange } from "./builds.ts";

export const DEFAULT_LOG_LINE_COUNT = 200;

const PROBLEM_RESULTS = new Set([
	"failed",
	"succeededwithissues",
	"canceled",
	"abandoned",
]);

interface OrderedTimelineRecord {
	record: TimelineRecord;
	index: number;
	depth: number;
	orphanParent: string | undefined;
	cycle: boolean;
}

function recordSortKey(
	record: TimelineRecord,
	index: number,
): [number, number] {
	return [record.order ?? Number.MAX_SAFE_INTEGER, index];
}

function compareRecordIndexes(
	records: TimelineRecord[],
	left: number,
	right: number,
): number {
	const [leftOrder, leftIndex] = recordSortKey(records[left], left);
	const [rightOrder, rightIndex] = recordSortKey(records[right], right);
	return leftOrder - rightOrder || leftIndex - rightIndex;
}

function findTimelineCycles(
	parentByChild: ReadonlyMap<number, number>,
	recordCount: number,
): Set<number> {
	// Each record has at most one parent, so cycle membership can be found iteratively by following
	// parent links. This avoids recursion overflow on malformed/deep timelines.
	const fullyScanned = new Set<number>();
	const cycleMembers = new Set<number>();
	for (let start = 0; start < recordCount; start += 1) {
		if (fullyScanned.has(start)) continue;
		const path: number[] = [];
		const position = new Map<number, number>();
		let current: number | undefined = start;
		while (
			current !== undefined &&
			!fullyScanned.has(current) &&
			!position.has(current)
		) {
			position.set(current, path.length);
			path.push(current);
			current = parentByChild.get(current);
		}
		if (current !== undefined && position.has(current)) {
			for (const member of path.slice(position.get(current)))
				cycleMembers.add(member);
		}
		for (const member of path) fullyScanned.add(member);
	}

	return cycleMembers;
}

export interface RequestedBuildLog {
	metadata: BuildLogMetadata;
	mode: "tail" | "full";
	range: BuildLogRange | null;
}

export function selectProblemLogs(
	buildId: number,
	records: TimelineRecord[],
	logMetadata: BuildLogMetadata[],
	fullLogs: boolean,
): Map<number, RequestedBuildLog> {
	const metadataById = new Map(
		logMetadata.map((metadata) => [metadata.id as number, metadata]),
	);
	const requestedLogs = new Map<number, RequestedBuildLog>();

	for (const record of records) {
		if (record.log === undefined || record.log === null) continue;
		const logId = record.log.id as number;
		const metadata = metadataById.get(logId);
		if (metadata === undefined) {
			throw new Error(
				`Build ${buildId} timeline record ${display(record.id ?? record.name)} references log ${logId}, but the build-log metadata response did not contain it.`,
			);
		}
		if (requestedLogs.has(logId)) continue;
		if (fullLogs) {
			requestedLogs.set(logId, { metadata, mode: "full", range: null });
		} else {
			if (metadata.lineCount === undefined) {
				throw new Error(
					`Build log ${logId} has no lineCount metadata; refusing to download an unbounded log. Use --full-logs only when complete, potentially sensitive output is intended.`,
				);
			}
			requestedLogs.set(logId, {
				metadata,
				mode: "tail",
				range: {
					// Azure's log ranges are zero-based with an exclusive end line.
					startLine: Math.max(0, metadata.lineCount - DEFAULT_LOG_LINE_COUNT),
					endLine: metadata.lineCount,
				},
			});
		}
	}
	return requestedLogs;
}

export function orderTimelineRecords(
	timeline: BuildTimeline,
): OrderedTimelineRecord[] {
	const records = timeline.records as TimelineRecord[];
	const indexById = new Map<string, number>();
	records.forEach((record, index) => {
		if (record.id !== undefined) indexById.set(normalized(record.id), index);
	});

	const children = new Map<number, number[]>();
	const parentByChild = new Map<number, number>();
	const roots: number[] = [];
	const orphanParents = new Map<number, string>();
	records.forEach((record, index) => {
		if (record.parentId === undefined || record.parentId === null) {
			roots.push(index);
			return;
		}
		const parentIndex = indexById.get(normalized(record.parentId));
		if (parentIndex === undefined) {
			roots.push(index);
			orphanParents.set(index, record.parentId);
			return;
		}
		parentByChild.set(index, parentIndex);
		const entries = children.get(parentIndex) ?? [];
		entries.push(index);
		children.set(parentIndex, entries);
	});
	roots.sort((left, right) => compareRecordIndexes(records, left, right));
	for (const entries of children.values()) {
		entries.sort((left, right) => compareRecordIndexes(records, left, right));
	}

	const cycleMembers = findTimelineCycles(parentByChild, records.length);

	const output: OrderedTimelineRecord[] = [];
	const visited = new Set<number>();
	function appendFrom(start: number): void {
		const stack: Array<{ index: number; depth: number }> = [
			{ index: start, depth: 0 },
		];
		while (stack.length > 0) {
			const next = stack.pop() as { index: number; depth: number };
			if (visited.has(next.index)) continue;
			visited.add(next.index);
			output.push({
				record: records[next.index],
				index: next.index,
				depth: next.depth,
				orphanParent: orphanParents.get(next.index),
				cycle: cycleMembers.has(next.index),
			});
			const entries = children.get(next.index) ?? [];
			for (
				let childIndex = entries.length - 1;
				childIndex >= 0;
				childIndex -= 1
			) {
				stack.push({ index: entries[childIndex], depth: next.depth + 1 });
			}
		}
	}

	for (const root of roots) appendFrom(root);
	const remaining = records
		.map((_record, index) => index)
		.filter((index) => !visited.has(index))
		.sort((left, right) => compareRecordIndexes(records, left, right));
	for (const index of remaining) appendFrom(index);
	return output;
}

export function timelineProblemRecords(
	timeline: BuildTimeline,
): TimelineRecord[] {
	return orderTimelineRecords(timeline)
		.map(({ record }) => record)
		.filter(
			(record) =>
				typeof record.result === "string" &&
				PROBLEM_RESULTS.has(normalized(record.result)),
		);
}
