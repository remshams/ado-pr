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

	test("removes a DCS string with inner escapes up to its ST", () => {
		assert.equal(
			stripTerminalControls("a\u001bPtmux;\u001b\u001b[31mred\u001b\\b"),
			"ab",
		);
	});

	test("ends an unterminated OSC, DCS, PM or APC string at the line end", () => {
		assert.equal(stripTerminalControls("a\u001b]0;title"), "a");
		assert.equal(
			stripTerminalControls("a\u001b_oops\nline2\u001bPx\nline3"),
			"a\nline2\nline3",
		);
	});

	test("removes ESC sequences with their intermediate and final bytes", () => {
		assert.equal(
			stripTerminalControls("a\u001bcb\u001b7c\u001b(B\u001b[md"),
			"abcd",
		);
	});

	test("removes a stray ESC without taking the next character", () => {
		assert.equal(stripTerminalControls("x\u001b\rfoo"), "xfoo");
		assert.equal(stripTerminalControls("x\u001b\u001b[31mred"), "xred");
	});

	test("stays fast on many unterminated introducers", () => {
		const started = performance.now();
		stripTerminalControls("\u001b]\u001bP\u001b_\n".repeat(50_000));
		stripTerminalControls("\u001b]\u001bP".repeat(50_000));
		assert.ok(performance.now() - started < 500);
	});
});
