/**
 * Removes terminal control sequences, control characters and bidi marks from text before it
 * reaches a terminal. Tabs and newlines stay; `\r\n` becomes `\n` and a lone `\r` is removed.
 */
export function stripTerminalControls(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(/\x1B\][^\x07]*?(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-_]/g, "")
		.replace(
			/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
			"",
		);
}
