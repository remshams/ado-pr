import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { AzureRequestError } from "../shared/azure.ts";

export interface PullRequestAttachment {
	displayName: string;
	url: string;
}

export interface PreparedImage {
	filename: string;
	bytes: Uint8Array<ArrayBuffer>;
}

function assertUniqueValues(values: string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (value === "") {
			throw new Error(`${label} must not be empty.`);
		}
		if (seen.has(value)) {
			throw new Error(`Duplicate ${label} "${value}".`);
		}
		seen.add(value);
	}
}

export async function prepareImages(paths: string[]): Promise<PreparedImage[]> {
	const files = paths.map((path) => ({ path, filename: basename(path) }));
	assertUniqueValues(
		files.map((file) => file.filename),
		"image basename",
	);

	return Promise.all(
		files.map(async ({ path, filename }) => {
			try {
				return { filename, bytes: new Uint8Array(await readFile(path)) };
			} catch (error) {
				throw new Error(
					`Could not read image "${path}": ${(error as Error).message}`,
				);
			}
		}),
	);
}

function imagePlaceholders(description: string): string[] {
	return [...description.matchAll(/\{\{image:([^{}\r\n]+)\}\}/g)].map(
		(match) => match[1],
	);
}

/** Validates that an image operation and its effective description name the same attachments. */
export function validateImagePlaceholders(
	description: string,
	images: readonly Pick<PreparedImage, "filename">[],
): void {
	const filenames = new Set(images.map((image) => image.filename));
	const placeholders = new Set(imagePlaceholders(description));
	const missing = [...filenames].filter(
		(filename) => !placeholders.has(filename),
	);
	const unmatched = [...placeholders].filter(
		(filename) => !filenames.has(filename),
	);
	if (missing.length === 0 && unmatched.length === 0) return;

	const details = [
		...missing.map(
			(filename) => `missing {{image:${filename}}} for --image ${filename}`,
		),
		...unmatched.map(
			(filename) => `no --image was supplied for {{image:${filename}}}`,
		),
	];
	throw new Error(`Image placeholder mismatch: ${details.join("; ")}.`);
}

function escapeMarkdownAltText(value: string): string {
	return value.replace(/[\\[\]]/g, "\\$&");
}

// Renaming can't fix a missing scope, a wrong PR, a server error or a network failure.
export function isRenameableUploadRejection(
	error: unknown,
): error is AzureRequestError {
	if (!(error instanceof AzureRequestError) || error.kind !== "http")
		return false;
	const status = error.status ?? 0;
	return status >= 400 && status < 500 && ![401, 403, 404].includes(status);
}

export function attachmentMarkdownLink(
	attachment: PullRequestAttachment,
): string {
	return `[${escapeMarkdownAltText(attachment.displayName)}](<${attachment.url}>)`;
}

function encodeImageMarkerFilename(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*-]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function attachmentMarkdown(attachment: PullRequestAttachment): string {
	return (
		`![${escapeMarkdownAltText(attachment.displayName)}](<${attachment.url}>)` +
		`<!-- ado-pr-image:${encodeImageMarkerFilename(attachment.displayName)} -->`
	);
}

export function replaceImagePlaceholder(
	description: string,
	attachment: PullRequestAttachment,
): string {
	const placeholder = `{{image:${attachment.displayName}}}`;
	return description.replaceAll(placeholder, attachmentMarkdown(attachment));
}

/** Removes only exact image-and-ownership-marker sequences emitted for this attachment. */
export function removeAttachmentMarkdown(
	description: string,
	attachment: PullRequestAttachment,
): string {
	return description.replaceAll(attachmentMarkdown(attachment), "");
}

export function preflightAttachments(
	attachments: readonly PullRequestAttachment[],
	removeImageNames: readonly string[],
	images: readonly PreparedImage[],
	prId: number,
): PullRequestAttachment[] {
	// Azure exposes the filename as displayName; preserve its ordinal, case-sensitive spelling.
	const attachmentsByName = new Map<string, PullRequestAttachment[]>();
	for (const attachment of attachments) {
		const matches = attachmentsByName.get(attachment.displayName) ?? [];
		matches.push(attachment);
		attachmentsByName.set(attachment.displayName, matches);
	}

	const removals = removeImageNames.map((filename) => {
		const matches = attachmentsByName.get(filename) ?? [];
		if (matches.length === 0) {
			throw new Error(`Attachment "${filename}" was not found on PR #${prId}.`);
		}
		if (matches.length > 1) {
			throw new Error(`Attachment "${filename}" is ambiguous on PR #${prId}.`);
		}
		return matches[0];
	});
	const collisions = images
		.map((image) => image.filename)
		.filter((filename) => attachmentsByName.has(filename));
	if (collisions.length > 0) {
		throw new Error(
			`Cannot upload attachment filename${collisions.length === 1 ? "" : "s"} ${collisions
				.map((filename) => `"${filename}"`)
				.join(
					", ",
				)} because ${collisions.length === 1 ? "it already exists" : "they already exist"} on PR #${prId}. Attachment filename collisions are case-sensitive; remove existing attachments in a separate command because replacement is not supported.`,
		);
	}
	return removals;
}

export async function prepareEditImages(options: {
	images?: string[];
	removeImages?: string[];
	description?: string;
}): Promise<{ images: PreparedImage[]; removeImageNames: string[] }> {
	const removeImageNames = options.removeImages ?? [];
	assertUniqueValues(removeImageNames, "attachment filename");
	for (const filename of removeImageNames) {
		if (
			basename(filename) !== filename ||
			filename === "." ||
			filename === ".."
		) {
			throw new Error(
				`--remove-image requires a filename, not a path: "${filename}".`,
			);
		}
	}

	const images = await prepareImages(options.images ?? []);
	const removeImageSet = new Set(removeImageNames);
	const imageConflict = images.find((image) =>
		removeImageSet.has(image.filename),
	);
	if (imageConflict) {
		throw new Error(
			`Cannot add and remove image "${imageConflict.filename}" in the same command.`,
		);
	}
	if (options.description !== undefined) {
		validateImagePlaceholders(options.description, images);
	}

	return { images, removeImageNames };
}
