import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  API_VERSION,
  AzureRequestError,
  getAuthenticatedUserId,
  pullRequestApiUrl,
  pullRequestWebUrl,
  reposBaseUrl,
} from "../shared/azure.ts";
import type { AzureRequester } from "../shared/azure.ts";
import { getCurrentBranch as defaultGetCurrentBranch } from "../shared/lib.ts";
import type { AzureDevOpsRepoContext } from "../shared/lib.ts";

export interface PullRequestRepository {
  id: string;
  name: string;
}

export interface PullRequestCommit {
  commitId: string;
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName?: string;
  repository?: PullRequestRepository;
  lastMergeCommit?: PullRequestCommit;
}

export interface CreatePullRequestOptions {
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft: boolean;
  images?: string[];
  reviewers?: string[];
}

export interface UpdatePullRequestOptions {
  description?: string;
  draft?: boolean;
}

export interface EditPullRequestOptions extends UpdatePullRequestOptions {
  images?: string[];
  removeImages?: string[];
  reviewers?: string[];
  removeReviewers?: string[];
}

export interface PullRequestReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface PullRequestAttachment {
  displayName: string;
  url: string;
}

interface AzureIdentity {
  id: string;
  customDisplayName?: string;
  providerDisplayName?: string;
  isActive?: boolean;
  properties?: Record<string, unknown>;
}

interface PullRequestReviewer {
  id: string;
  displayName?: string;
  uniqueName?: string;
  vote?: number;
}

interface PreparedImage {
  filename: string;
  bytes: Uint8Array<ArrayBuffer>;
}

const MAX_DESCRIPTION_LENGTH = 4_000;

export interface PullRequestService {
  list(): Promise<PullRequest[]>;
  create(options: CreatePullRequestOptions): Promise<PullRequest>;
  edit(requestedPrId: number | undefined, options: EditPullRequestOptions): Promise<number>;
  update(prId: number, options: UpdatePullRequestOptions): Promise<PullRequest>;
  get(prId: number, options?: PullRequestReadOptions): Promise<PullRequest>;
  findForCurrentBranch(options?: PullRequestReadOptions): Promise<PullRequest>;
  resolve(
    requestedPrId: number | undefined,
    options?: PullRequestReadOptions,
  ): Promise<PullRequest>;
  resolveId(requestedPrId: number | undefined): Promise<number>;
  format(pr: PullRequest): string;
  formatListItem(pr: PullRequest): string;
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

function assertPullRequestId(value: unknown, context: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Malformed Azure DevOps response: ${context} must be a positive safe integer.`);
  }
}

function assertDescriptionLength(description: string, generated = false): void {
  if (description.length <= MAX_DESCRIPTION_LENGTH) return;
  throw new Error(
    `${generated ? "Generated pull request description" : "Pull request description"} exceeds Azure DevOps' 4,000-character limit (received ${description.length} characters).`,
  );
}

async function prepareImages(paths: string[]): Promise<PreparedImage[]> {
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
        throw new Error(`Could not read image "${path}": ${(error as Error).message}`);
      }
    }),
  );
}

function imagePlaceholders(description: string): string[] {
  return [...description.matchAll(/\{\{image:([^{}\r\n]+)\}\}/g)].map((match) => match[1]);
}

/** Validates that an image operation and its effective description name the same attachments. */
export function validateImagePlaceholders(
  description: string,
  images: readonly Pick<PreparedImage, "filename">[],
): void {
  const filenames = new Set(images.map((image) => image.filename));
  const placeholders = new Set(imagePlaceholders(description));
  const missing = [...filenames].filter((filename) => !placeholders.has(filename));
  const unmatched = [...placeholders].filter((filename) => !filenames.has(filename));
  if (missing.length === 0 && unmatched.length === 0) return;

  const details = [
    ...missing.map((filename) => `missing {{image:${filename}}} for --image ${filename}`),
    ...unmatched.map((filename) => `no --image was supplied for {{image:${filename}}}`),
  ];
  throw new Error(`Image placeholder mismatch: ${details.join("; ")}.`);
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
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

function replaceImagePlaceholder(description: string, attachment: PullRequestAttachment): string {
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

function preflightAttachments(
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
        .join(", ")} because ${collisions.length === 1 ? "it already exists" : "they already exist"} on PR #${prId}. Attachment filename collisions are case-sensitive; remove existing attachments in a separate command because replacement is not supported.`,
    );
  }
  return removals;
}

function identityProperty(
  identity: AzureIdentity,
  propertyName: "Account" | "Mail",
): string | undefined {
  const property = Object.entries(identity.properties ?? {}).find(
    ([name]) => name.toLowerCase() === propertyName.toLowerCase(),
  )?.[1];
  if (typeof property === "string") return property;
  if (property && typeof property === "object") {
    const propertyValue = property as { $value?: unknown; value?: unknown };
    const value = propertyValue.$value ?? propertyValue.value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function identityLabel(identity: AzureIdentity): string {
  return (
    identity.customDisplayName ??
    identity.providerDisplayName ??
    identityProperty(identity, "Mail") ??
    identity.id
  );
}

function reviewerLabel(reviewer: PullRequestReviewer): string {
  return reviewer.displayName ?? reviewer.uniqueName ?? reviewer.id;
}

/** Turns a plain branch name into a full ref, leaving an already-qualified ref untouched. */
function toFullRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function createPullRequestService({
  azure,
  ctx,
  getCurrentBranch = defaultGetCurrentBranch,
}: {
  azure: AzureRequester;
  ctx: AzureDevOpsRepoContext;
  getCurrentBranch?: (options?: { signal?: AbortSignal }) => Promise<string>;
}): PullRequestService {
  async function list(): Promise<PullRequest[]> {
    const currentUserId = await getAuthenticatedUserId(azure, ctx.organization);
    const url = `${reposBaseUrl(ctx)}/pullrequests?searchCriteria.creatorId=${encodeURIComponent(currentUserId)}&searchCriteria.status=active&api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequest[] }>(url);
    return data.value;
  }

  async function getDefaultBranch(): Promise<string> {
    const url = `${reposBaseUrl(ctx)}?api-version=${API_VERSION}`;
    const data = await azure.request<{ defaultBranch?: string }>(url);
    if (!data.defaultBranch) {
      throw new Error(
        `Could not determine the default branch for ${ctx.organization}/${ctx.project}/${ctx.repository}; pass --target explicitly.`,
      );
    }
    return data.defaultBranch;
  }

  async function resolveReviewer(value: string): Promise<AzureIdentity> {
    if (value === "") {
      throw new Error("Reviewer search value must not be empty.");
    }
    const url =
      `https://vssps.dev.azure.com/${encodeURIComponent(ctx.organization)}/_apis/identities?` +
      `searchFilter=General&filterValue=${encodeURIComponent(value)}&queryMembership=None&api-version=${API_VERSION}`;
    const data = await azure.request<{ value: AzureIdentity[] }>(url);
    const expected = value.toLowerCase();
    const matches = data.value.filter((identity) => {
      if (identity.isActive !== true) return false;
      return [
        identity.customDisplayName,
        identity.providerDisplayName,
        identityProperty(identity, "Account"),
        identityProperty(identity, "Mail"),
      ].some((candidate) => candidate?.toLowerCase() === expected);
    });
    const uniqueMatches = [...new Map(matches.map((identity) => [identity.id, identity])).values()];

    if (uniqueMatches.length === 0) {
      throw new Error(
        `No active Azure DevOps identity exactly matched reviewer "${value}" by custom display name, display name, account, or mail.`,
      );
    }
    if (uniqueMatches.length > 1) {
      throw new Error(
        `Reviewer "${value}" is ambiguous; exact matches were:\n${uniqueMatches
          .map((identity) => `  ${identityLabel(identity)} (${identity.id})`)
          .join("\n")}`,
      );
    }
    return uniqueMatches[0];
  }

  async function resolveReviewers(values: string[]): Promise<AzureIdentity[]> {
    const identities: AzureIdentity[] = [];
    for (const value of values) {
      identities.push(await resolveReviewer(value));
    }
    const duplicate = identities.find(
      (identity, index) => identities.findIndex((candidate) => candidate.id === identity.id) !== index,
    );
    if (duplicate) {
      throw new Error(
        `Duplicate resolved reviewer for addition: ${identityLabel(duplicate)} (${duplicate.id}).`,
      );
    }
    return identities;
  }

  function resolveCurrentReviewers(
    values: string[],
    currentReviewers: PullRequestReviewer[],
    prId: number,
  ): PullRequestReviewer[] {
    const resolved = values.map((value) => {
      if (value === "") {
        throw new Error("Reviewer removal value must not be empty.");
      }
      const expected = value.toLowerCase();
      const matches = currentReviewers.filter((reviewer) =>
        [reviewer.displayName, reviewer.uniqueName].some(
          (candidate) => candidate?.toLowerCase() === expected,
        ),
      );
      const uniqueMatches = [
        ...new Map(matches.map((reviewer) => [reviewer.id.toLowerCase(), reviewer])).values(),
      ];

      if (uniqueMatches.length === 0) {
        throw new Error(
          `No current reviewer exactly matched "${value}" by display name or unique name on PR #${prId}.`,
        );
      }
      if (uniqueMatches.length > 1) {
        throw new Error(
          `Current reviewer "${value}" is ambiguous on PR #${prId}; exact matches were:\n${uniqueMatches
            .map((reviewer) => `  ${reviewerLabel(reviewer)} (${reviewer.id})`)
            .join("\n")}`,
        );
      }
      return uniqueMatches[0];
    });

    const duplicate = resolved.find(
      (reviewer, index) =>
        resolved.findIndex(
          (candidate) => candidate.id.toLowerCase() === reviewer.id.toLowerCase(),
        ) !== index,
    );
    if (duplicate) {
      throw new Error(
        `Duplicate resolved reviewer for removal: ${reviewerLabel(duplicate)} (${duplicate.id}).`,
      );
    }
    return resolved;
  }

  async function uploadAttachment(
    prId: number,
    image: PreparedImage,
  ): Promise<PullRequestAttachment> {
    const url = `${pullRequestApiUrl(ctx, prId, `/attachments/${encodeURIComponent(image.filename)}`)}?api-version=${API_VERSION}`;
    return azure.request<PullRequestAttachment>(url, {
      method: "POST",
      rawBody: image.bytes,
      contentType: "application/octet-stream",
    });
  }

  async function listAttachments(prId: number): Promise<PullRequestAttachment[]> {
    const url = `${pullRequestApiUrl(ctx, prId, "/attachments")}?api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequestAttachment[] }>(url);
    return data.value;
  }

  async function deleteAttachment(prId: number, filename: string): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/attachments/${encodeURIComponent(filename)}`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "DELETE", responseType: "none" });
  }

  async function uploadImagesWithCleanup(
    prId: number,
    description: string,
    images: PreparedImage[],
    context: string,
  ): Promise<string> {
    const uploadedAttachments: PullRequestAttachment[] = [];
    try {
      let updatedDescription = description;
      for (const image of images) {
        const attachment = await uploadAttachment(prId, image);
        uploadedAttachments.push(attachment);
        updatedDescription = replaceImagePlaceholder(updatedDescription, attachment);
      }
      assertDescriptionLength(updatedDescription, true);
      return updatedDescription;
    } catch (error) {
      const cleanupProblems: string[] = [];
      for (const attachment of [...uploadedAttachments].reverse()) {
        try {
          await deleteAttachment(prId, attachment.displayName);
        } catch (cleanupError) {
          cleanupProblems.push(
            `cleanup failed for "${attachment.displayName}": ${(cleanupError as Error).message}`,
          );
        }
      }

      const cleanupSummary =
        cleanupProblems.length > 0
          ? `\nBest-effort upload cleanup was incomplete: ${cleanupProblems.join("; ")}.`
          : "";
      throw new Error(`${(error as Error).message}\n${context}${cleanupSummary}`);
    }
  }

  async function updateAfterImageUploads(
    prId: number,
    options: UpdatePullRequestOptions,
    hasUploadedImages: boolean,
    context: string,
  ): Promise<PullRequest> {
    try {
      return await update(prId, options);
    } catch (error) {
      if (!hasUploadedImages) throw error;
      throw new Error(`${(error as Error).message}\n${context}`);
    }
  }

  async function addReviewer(prId: number, identity: AzureIdentity): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/reviewers/${encodeURIComponent(identity.id)}`)}?api-version=${API_VERSION}`;
    await azure.request(url, {
      method: "PUT",
      body: { id: identity.id, vote: 0 },
      responseType: "none",
    });
  }

  async function listReviewers(prId: number): Promise<PullRequestReviewer[]> {
    const url = `${pullRequestApiUrl(ctx, prId, "/reviewers")}?api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequestReviewer[] }>(url);
    return data.value;
  }

  async function removeReviewer(prId: number, reviewer: PullRequestReviewer): Promise<void> {
    const url = `${pullRequestApiUrl(ctx, prId, `/reviewers/${encodeURIComponent(reviewer.id)}`)}?api-version=${API_VERSION}`;
    await azure.request(url, { method: "DELETE", responseType: "none" });
  }

  async function findForCurrentBranch(
    options: PullRequestReadOptions = {},
  ): Promise<PullRequest> {
    let branch: string;
    try {
      branch = await getCurrentBranch({ signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new AzureRequestError("Pull request resolution was aborted by the caller.", "abort");
      }
      throw error;
    }
    if (options.signal?.aborted) {
      throw new AzureRequestError("Pull request resolution was aborted by the caller.", "abort");
    }
    const url = `${reposBaseUrl(ctx)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(toFullRef(branch))}&searchCriteria.status=active&api-version=${API_VERSION}`;
    const data = await azure.request<{ value: PullRequest[] }>(url, options);
    if (!Array.isArray(data.value)) {
      throw new Error("Malformed Azure DevOps response: pull request collection value must be an array.");
    }
    for (const [index, candidate] of data.value.entries()) {
      assertPullRequestId(candidate?.pullRequestId, `pull request collection value[${index}].pullRequestId`);
    }

    if (data.value.length === 0) {
      throw new Error(
        `No active pull request found for branch "${branch}" in ${ctx.organization}/${ctx.project}/${ctx.repository}.`,
      );
    }
    if (data.value.length > 1) {
      throw new Error(
        `Multiple active pull requests found for branch "${branch}"; pass --pr <id> to disambiguate:\n${data.value
          .map((pr) => `  #${pr.pullRequestId}: ${pr.title}`)
          .join("\n")}`,
      );
    }
    return data.value[0];
  }

  /**
   * Creates a new pull request. Defaults the source branch to the current branch (which must
   * already exist on the remote) and the target branch to the repository's default branch.
   */
  async function create(options: CreatePullRequestOptions): Promise<PullRequest> {
    const description = options.description ?? "";
    assertDescriptionLength(description);
    const images = await prepareImages(options.images ?? []);
    validateImagePlaceholders(description, images);
    const reviewers = await resolveReviewers(options.reviewers ?? []);
    const sourceBranch = options.sourceBranch ?? (await getCurrentBranch());
    const targetBranch = options.targetBranch ?? (await getDefaultBranch());

    const url = `${reposBaseUrl(ctx)}/pullrequests?api-version=${API_VERSION}`;
    const created = await azure.request<PullRequest>(url, {
      method: "POST",
      body: {
        sourceRefName: toFullRef(sourceBranch),
        targetRefName: toFullRef(targetBranch),
        title: options.title,
        description,
        isDraft: options.draft,
        ...(reviewers.length > 0
          ? { reviewers: reviewers.map((reviewer) => ({ id: reviewer.id })) }
          : {}),
      },
    });

    if (images.length === 0) return created;

    const attachments = await listAttachments(created.pullRequestId);
    preflightAttachments(attachments, [], images, created.pullRequestId);
    const updatedDescription = await uploadImagesWithCleanup(
      created.pullRequestId,
      description,
      images,
      `PR #${created.pullRequestId} was created with its original placeholder description; successfully uploaded attachments were cleaned up where safe.`,
    );
    return updateAfterImageUploads(
      created.pullRequestId,
      { description: updatedDescription },
      true,
      `PR #${created.pullRequestId} was created, but the final description update outcome is uncertain. Newly uploaded attachments were left in place to avoid breaking a possibly applied description.`,
    );
  }

  async function edit(
    requestedPrId: number | undefined,
    options: EditPullRequestOptions,
  ): Promise<number> {
    const removeImageNames = options.removeImages ?? [];
    assertUniqueValues(removeImageNames, "attachment filename");
    for (const filename of removeImageNames) {
      if (basename(filename) !== filename || filename === "." || filename === "..") {
        throw new Error(`--remove-image requires a filename, not a path: "${filename}".`);
      }
    }

    const images = await prepareImages(options.images ?? []);
    const removeImageSet = new Set(removeImageNames);
    const imageConflict = images.find((image) => removeImageSet.has(image.filename));
    if (imageConflict) {
      throw new Error(
        `Cannot add and remove image "${imageConflict.filename}" in the same command.`,
      );
    }
    if (options.description !== undefined) {
      validateImagePlaceholders(options.description, images);
      if (removeImageNames.length === 0) {
        assertDescriptionLength(options.description);
      }
    }

    const requestedReviewerRemovals = options.removeReviewers ?? [];
    const resolvedAdditions = await resolveReviewers(options.reviewers ?? []);

    const needsCurrentDescription =
      (images.length > 0 || removeImageNames.length > 0) && options.description === undefined;
    const current = needsCurrentDescription ? await resolve(requestedPrId) : undefined;
    const prId = current ? current.pullRequestId : await resolveId(requestedPrId);

    const currentReviewers =
      resolvedAdditions.length > 0 || requestedReviewerRemovals.length > 0
        ? await listReviewers(prId)
        : [];
    const removedReviewers = resolveCurrentReviewers(
      requestedReviewerRemovals,
      currentReviewers,
      prId,
    );
    const removedReviewerIds = new Set(
      removedReviewers.map((reviewer) => reviewer.id.toLowerCase()),
    );
    const reviewerConflict = resolvedAdditions.find((identity) =>
      removedReviewerIds.has(identity.id.toLowerCase()),
    );
    if (reviewerConflict) {
      throw new Error(
        `Cannot add and remove reviewer ${identityLabel(reviewerConflict)} (${reviewerConflict.id}) in the same command.`,
      );
    }
    const currentReviewerIds = new Set(
      currentReviewers.map((reviewer) => reviewer.id.toLowerCase()),
    );
    const reviewers = resolvedAdditions.filter(
      (identity) => !currentReviewerIds.has(identity.id.toLowerCase()),
    );

    let description = options.description ?? current?.description ?? "";
    if (images.length > 0 && options.description === undefined) {
      validateImagePlaceholders(description, images);
      if (removeImageNames.length === 0) {
        assertDescriptionLength(description);
      }
    }

    const attachments =
      removeImageNames.length > 0 || images.length > 0 ? await listAttachments(prId) : [];
    const removals = preflightAttachments(attachments, removeImageNames, images, prId);

    const originalDescription = description;
    for (const attachment of removals) {
      description = removeAttachmentMarkdown(description, attachment);
    }
    if (removeImageNames.length > 0) {
      assertDescriptionLength(description);
    }
    if (images.length > 0) {
      description = await uploadImagesWithCleanup(
        prId,
        description,
        images,
        `PR #${prId} was not updated; successfully uploaded attachments were cleaned up where safe.`,
      );
    }

    const shouldUpdateDescription =
      options.description !== undefined ||
      images.length > 0 ||
      description !== originalDescription;
    if (shouldUpdateDescription || options.draft !== undefined) {
      await updateAfterImageUploads(
        prId,
        {
          ...(shouldUpdateDescription ? { description } : {}),
          ...(options.draft !== undefined ? { draft: options.draft } : {}),
        },
        images.length > 0,
        "The PR update outcome is uncertain. Newly uploaded attachments were left in place to avoid breaking a possibly applied description.",
      );
    }
    for (const attachment of removals) {
      await deleteAttachment(prId, attachment.displayName);
    }
    for (const reviewer of reviewers) {
      await addReviewer(prId, reviewer);
    }
    for (const reviewer of removedReviewers) {
      await removeReviewer(prId, reviewer);
    }

    return prId;
  }

  /** Updates only the explicitly supplied pull request fields. */
  async function update(prId: number, options: UpdatePullRequestOptions): Promise<PullRequest> {
    if (options.description !== undefined) {
      assertDescriptionLength(options.description);
    }
    const body = {
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.draft !== undefined ? { isDraft: options.draft } : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new Error("At least one pull request field is required for an update.");
    }

    const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
    return azure.request<PullRequest>(url, { method: "PATCH", body });
  }

  /** Fetches a pull request by ID, including its description and other PR-level metadata. */
  async function get(
    prId: number,
    options: PullRequestReadOptions = {},
  ): Promise<PullRequest> {
    const url = `${pullRequestApiUrl(ctx, prId)}?api-version=${API_VERSION}`;
    const pr = await azure.request<PullRequest>(url, options);
    assertPullRequestId(pr?.pullRequestId, "hydrated pull request.pullRequestId");
    if (pr.pullRequestId !== prId) {
      throw new Error(
        `Malformed Azure DevOps response: hydrated pull request ID ${pr.pullRequestId} did not match selected PR #${prId}.`,
      );
    }
    return pr;
  }

  /** Resolves and fully fetches either an explicitly selected PR or the active PR for the branch. */
  async function resolve(
    requestedPrId: number | undefined,
    options: PullRequestReadOptions = {},
  ): Promise<PullRequest> {
    if (requestedPrId !== undefined) {
      return get(requestedPrId, options);
    }
    const candidate = await findForCurrentBranch(options);
    // Azure truncates descriptions in pull-request collection responses, so hydrate the selected PR.
    return get(candidate.pullRequestId, options);
  }

  async function resolveId(requestedPrId: number | undefined): Promise<number> {
    if (requestedPrId !== undefined) {
      return requestedPrId;
    }
    const pr = await findForCurrentBranch();
    return pr.pullRequestId;
  }

  function formatRef(ref: string | undefined): string {
    return ref?.replace(/^refs\/heads\//, "") ?? "unknown";
  }

  function format(pr: PullRequest): string {
    return [
      `PR #${pr.pullRequestId}: ${pr.title}`,
      `Status: ${pr.status ?? "unknown"}`,
      `Draft: ${pr.isDraft === undefined ? "unknown" : pr.isDraft ? "yes" : "no"}`,
      `Source: ${formatRef(pr.sourceRefName)}`,
      `Target: ${formatRef(pr.targetRefName)}`,
      `URL: ${pullRequestWebUrl(ctx, pr.pullRequestId)}`,
      "Description:",
      pr.description?.length ? pr.description : "(empty)",
    ].join("\n");
  }

  function formatListItem(pr: PullRequest): string {
    return [
      `- PR #${pr.pullRequestId}: ${pr.title}${pr.isDraft ? " [draft]" : ""}`,
      `  ${formatRef(pr.sourceRefName)} -> ${formatRef(pr.targetRefName)}`,
      `  ${pullRequestWebUrl(ctx, pr.pullRequestId)}`,
    ].join("\n");
  }

  return {
    list,
    create,
    edit,
    update,
    get,
    findForCurrentBranch,
    resolve,
    resolveId,
    format,
    formatListItem,
  };
}
