import assert from "node:assert/strict";
import { test } from "node:test";
import { safeJson } from "./json.ts";

test("safeJson indents by two spaces and escapes unsafe characters", () => {
	assert.equal(
		safeJson({ text: "C1\u009b bidi\u202e line\u2028end\u007f", n: 1 }),
		'{\n  "text": "C1\\u009b bidi\\u202e line\\u2028end\\u007f",\n  "n": 1\n}',
	);
});
