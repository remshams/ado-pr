import { createFileAnchorCache, type FileAnchorCache } from "./file-anchors.ts";
import type { AzureDevOpsRepoContext } from "./lib.ts";
import {
  actionRequiresComment,
  actionRequiresMessage,
  actionRequiresThread,
  isPositiveInteger,
  toCommentLocation,
} from "./operation-types.ts";
import {
  deleteComment,
  editComment,
  postComment,
  postReply,
  resolveThread,
  threadWebUrl,
} from "./threads.ts";

interface BatchOperation {
  action: "comment" | "reply" | "edit" | "delete" | "resolve";
  pr?: number;
  thread?: number;
  comment?: number;
  message?: string;
  file?: string;
  line?: number;
  endLine?: number;
}

const BATCH_ACTIONS: BatchOperation["action"][] = ["comment", "reply", "edit", "delete", "resolve"];

/** Validates and normalizes a single element of a `batch` action's JSON operations array. */
function parseBatchOperation(raw: unknown, index: number): BatchOperation {
  const label = `Batch operation ${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const op = raw as Record<string, unknown>;

  const action = op.action;
  if (typeof action !== "string" || !BATCH_ACTIONS.includes(action as BatchOperation["action"])) {
    throw new Error(
      `${label} has an invalid "action" (must be one of: ${BATCH_ACTIONS.join(", ")}).`,
    );
  }

  function positiveIntField(field: string): number | undefined {
    const value = op[field];
    if (value === undefined) {
      return undefined;
    }
    if (!isPositiveInteger(value)) {
      throw new Error(`${label} has an invalid "${field}" (must be a positive integer).`);
    }
    return value;
  }

  const pr = positiveIntField("pr");
  const thread = positiveIntField("thread");
  const comment = positiveIntField("comment");
  const line = positiveIntField("line");
  const endLine = positiveIntField("endLine");
  const message = typeof op.message === "string" ? op.message : undefined;
  const file = typeof op.file === "string" ? op.file : undefined;

  if (actionRequiresThread(action) && !thread) {
    throw new Error(`${label} ("${action}") requires a "thread".`);
  }
  if (actionRequiresComment(action) && !comment) {
    throw new Error(`${label} ("${action}") requires a "comment".`);
  }
  if (actionRequiresMessage(action) && !message) {
    throw new Error(`${label} ("${action}") requires a "message".`);
  }
  if (line !== undefined && !file) {
    throw new Error(`${label} ("${action}") has "line" but no "file".`);
  }
  if (endLine !== undefined && line === undefined) {
    throw new Error(`${label} ("${action}") has "endLine" but no "line".`);
  }
  if (endLine !== undefined && line !== undefined && endLine < line) {
    throw new Error(`${label} ("${action}") has "endLine" < "line".`);
  }

  return {
    action: action as BatchOperation["action"],
    pr,
    thread,
    comment,
    message,
    file,
    line,
    endLine,
  };
}

/** Reads and JSON-parses the full contents of stdin. Used by the `batch` action. */
async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new Error(
      "batch reads its operations from stdin, but none was piped/redirected in " +
        "(stdin is a terminal). Use e.g. `pr.sh batch < operations.json`.",
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error(
      "No batch operations provided on stdin. Pipe/redirect a JSON array of operations in, e.g. `pr.sh batch < operations.json`.",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse batch operations as JSON: ${(error as Error).message}`);
  }
}

/** Executes a single batch operation and returns a short human-readable description of it. */
async function executeBatchOperation(
  ctx: AzureDevOpsRepoContext,
  pat: string,
  defaultPrId: number,
  op: BatchOperation,
  fileAnchorCache: FileAnchorCache,
): Promise<string> {
  const prId = op.pr ?? defaultPrId;
  switch (op.action) {
    case "comment": {
      const location = toCommentLocation(op);
      const thread = await postComment(ctx, prId, op.message!, pat, location, fileAnchorCache);
      const url = threadWebUrl(ctx, prId, thread.id);
      return `posted new comment thread ${thread.id} on PR #${prId} (${url})`;
    }
    case "reply": {
      await postReply(ctx, prId, op.thread!, op.message!, pat);
      return `posted reply to thread ${op.thread} on PR #${prId}`;
    }
    case "edit": {
      await editComment(ctx, prId, op.thread!, op.comment!, op.message!, pat);
      return `edited comment ${op.comment} in thread ${op.thread} on PR #${prId}`;
    }
    case "delete": {
      await deleteComment(ctx, prId, op.thread!, op.comment!, pat);
      return `deleted comment ${op.comment} from thread ${op.thread} on PR #${prId}`;
    }
    case "resolve": {
      await resolveThread(ctx, prId, op.thread!, pat);
      return `marked thread ${op.thread} on PR #${prId} as resolved`;
    }
  }
}

export async function runBatch(
  ctx: AzureDevOpsRepoContext,
  pat: string,
  defaultPrId: number,
): Promise<void> {
  const raw = await readStdinJson();
  if (!Array.isArray(raw)) {
    throw new Error("Batch operations must be a JSON array.");
  }
  const operations = raw.map((entry, index) => parseBatchOperation(entry, index));
  if (operations.length === 0) {
    console.log("No batch operations to run.");
    return;
  }

  const fileAnchorCache = createFileAnchorCache();
  let hadFailure = false;
  for (const [index, op] of operations.entries()) {
    const label = `[${index + 1}/${operations.length}] ${op.action}`;
    try {
      const result = await executeBatchOperation(ctx, pat, defaultPrId, op, fileAnchorCache);
      console.log(`${label}: ${result}`);
    } catch (error) {
      hadFailure = true;
      console.error(`${label}: FAILED - ${(error as Error).message}`);
    }
  }
  if (hadFailure) {
    process.exitCode = 1;
  }
}
