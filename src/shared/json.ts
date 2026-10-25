const UNSAFE_CHARACTERS =
	/[\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/**
 * Pretty-prints a value as JSON for stdout. C1 controls, line separators and bidi marks are
 * escaped so a terminal shows them as text.
 */
export function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(
		UNSAFE_CHARACTERS,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
