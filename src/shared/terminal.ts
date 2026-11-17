/**
 * Matches one escape sequence:
 * - OSC (`ESC ]`), DCS (`ESC P`), PM (`ESC ^`) and APC (`ESC _`) strings up to their BEL or ST
 *   (`ESC \`) terminator, skipping inner ESCs. An unterminated string ends at the line end.
 * - CSI sequences (`ESC [ ... final`).
 * - Other ESC sequences: intermediate bytes plus one final byte, such as `ESC c` or `ESC ( B`.
 */
const ESCAPE_SEQUENCE =
	/\x1B(?:[\]P^_](?:[^\x07\x1B\n]+|\x1B(?!\\))*(?:\x07|\x1B\\)?|\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])/g;
const CONTROL_CHARACTERS =
	/[\x00-\x08\x0B-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Removes terminal escape sequences, control characters and bidi marks from text before it
 * reaches a terminal. Tabs and newlines stay and every `\r` is removed, so `\r\n` becomes `\n`.
 */
export function stripTerminalControls(value: string): string {
	return value.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
}
