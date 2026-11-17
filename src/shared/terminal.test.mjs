import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripTerminalControls } from "./terminal.ts";

describe("stripTerminalControls", () => {
	test("removes CSI sequences, control characters and bidi overrides but keeps tabs and newlines", () => {
		assert.equal(
			stripTerminalControls("a\u001b[2Jb\u0000c\rrewrite\r\nnext\t\nd\u202E"),
			"abcrewrite\nnext\t\nd",
		);
	});

	test("turns CRLF into LF and removes a lone CR", () => {
		assert.equal(stripTerminalControls("one\r\ntwo\rthree"), "one\ntwothree");
	});

	test("preserves text between ST-terminated and BEL-terminated OSC sequences", () => {
		assert.equal(
			stripTerminalControls(
				"before\u001b]0;first\u001b\\between\u001b]0;second\u0007after",
			),
			"beforebetweenafter",
		);
	});

	test("removes whole DCS, PM and APC strings", () => {
		assert.equal(
			stripTerminalControls(
				"a\u001bPdcs payload\u001b\\b\u001b^pm payload\u001b\\c\u001b_apc payload\u001b\\d",
			),
			"abcd",
		);
	});

	test("removes Arabic letter mark, left-to-right mark and right-to-left mark", () => {
		assert.equal(stripTerminalControls("a\u061Cb\u200Ec\u200Fd"), "abcd");
	});
});
