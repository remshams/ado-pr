export interface CommentLocation {
	file: string;
	line?: number;
	endLine?: number;
}

export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function buildWaitExitCode(result: {
	timedOut: boolean;
	outcome: string;
}): 0 | 1 | 124 {
	if (result.timedOut || result.outcome === "timeout") return 124;
	return result.outcome === "succeeded" ? 0 : 1;
}

/** Builds an optional file-anchor location from CLI options or a batch operation. */
export function toCommentLocation(source: {
	file?: string;
	line?: number;
	endLine?: number;
}): CommentLocation | undefined {
	return source.file
		? { file: source.file, line: source.line, endLine: source.endLine }
		: undefined;
}
