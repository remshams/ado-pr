import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	attachmentMarkdownLink,
	removeAttachmentMarkdown,
	validateImagePlaceholders,
} from "./attachments.ts";

describe("pull request attachments", () => {
	test("escapes brackets and backslashes in attachment Markdown links", () => {
		assert.equal(
			attachmentMarkdownLink({
				displayName: "a\\b]c[.patch",
				url: "https://files.test/x",
			}),
			"[a\\\\b\\]c\\[.patch](<https://files.test/x>)",
		);
	});

	test("validates exact image placeholder sets while allowing repeated matching instances", () => {
		assert.doesNotThrow(() =>
			validateImagePlaceholders(
				"First {{image:flow.png}} and again {{image:flow.png}} plus {{image:arch.png}}",
				[{ filename: "flow.png" }, { filename: "arch.png" }],
			),
		);
		assert.throws(
			() =>
				validateImagePlaceholders("Only {{image:other.png}}", [
					{ filename: "flow.png" },
				]),
			{
				message:
					"Image placeholder mismatch: missing {{image:flow.png}} for --image flow.png; no --image was supplied for {{image:other.png}}.",
			},
		);
		assert.throws(() => validateImagePlaceholders("{{image:orphan.png}}", []), {
			message:
				"Image placeholder mismatch: no --image was supplied for {{image:orphan.png}}.",
		});
	});

	test("removes repeated marked references and preserves unmarked text inside and outside code", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/flow.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const marked = `${image}<!-- ado-pr-image:flow.png -->`;

		assert.equal(
			removeAttachmentMarkdown(
				`Remove ${marked} keep ${image} and \`${image}\`; remove ${marked}`,
				attachment,
			),
			`Remove  keep ${image} and \`${image}\`; remove `,
		);
	});

	test("preserves custom, malformed, nested, and edited-marker references", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/actual.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const description =
			`${image} ` +
			`${image}<!-- ado-pr-image:edited.png --> ` +
			`![custom](<${attachment.url}>)<!-- ado-pr-image:flow.png --> ` +
			`![outer [flow.png]](<${attachment.url}>) ` +
			`![flow.png](${attachment.url}) ` +
			`![flow.png](<${attachment.url}>`;

		assert.equal(
			removeAttachmentMarkdown(description, attachment),
			description,
		);
	});

	test("strictly encodes escaped filenames in ownership markers", () => {
		const attachment = {
			displayName: "flow[1]-->.png",
			url: "https://example.test/a_(1).png?x=1&y=2",
		};
		const marked =
			`![flow\\[1\\]-->.png](<${attachment.url}>)` +
			"<!-- ado-pr-image:flow%5B1%5D%2D%2D%3E.png -->";

		assert.equal(
			removeAttachmentMarkdown(`Before ${marked} after`, attachment),
			"Before  after",
		);
		assert.equal(
			marked.slice(marked.indexOf("<!--")),
			"<!-- ado-pr-image:flow%5B1%5D%2D%2D%3E.png -->",
		);
	});

	test("handles long marked and unmarked input in linear work", () => {
		const attachment = {
			displayName: "flow.png",
			url: "https://attachments.test/long.png",
		};
		const image = `![flow.png](<${attachment.url}>)`;
		const marked = `${image}<!-- ado-pr-image:flow.png -->`;
		const unmarked = image.repeat(5_000);
		const malformed = `![${"\\".repeat(200_000)} without a closing bracket`;

		assert.equal(
			removeAttachmentMarkdown(
				`${unmarked} ${malformed} ${marked.repeat(5_000)}`,
				attachment,
			),
			`${unmarked} ${malformed} `,
		);
	});
});
