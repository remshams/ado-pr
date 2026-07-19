import { isPositiveInteger, toCommentLocation } from "./operation-types.ts";
import type { ThreadService } from "./threads.ts";

type BatchCommand =
  | "comment.create"
  | "comment.reply"
  | "comment.edit"
  | "comment.delete"
  | "comment.resolve";

interface BatchOperationBase {
  command: BatchCommand;
  pr?: number;
}

interface BatchCreateOperation extends BatchOperationBase {
  command: "comment.create";
  message: string;
  file?: string;
  line?: number;
  endLine?: number;
}

interface BatchReplyOperation extends BatchOperationBase {
  command: "comment.reply";
  thread: number;
  message: string;
}

interface BatchEditOperation extends BatchOperationBase {
  command: "comment.edit";
  thread: number;
  comment: number;
  message: string;
}

interface BatchDeleteOperation extends BatchOperationBase {
  command: "comment.delete";
  thread: number;
  comment: number;
}

interface BatchResolveOperation extends BatchOperationBase {
  command: "comment.resolve";
  thread: number;
}

type BatchOperation =
  | BatchCreateOperation
  | BatchReplyOperation
  | BatchEditOperation
  | BatchDeleteOperation
  | BatchResolveOperation;

const BATCH_COMMANDS: BatchCommand[] = [
  "comment.create",
  "comment.reply",
  "comment.edit",
  "comment.delete",
  "comment.resolve",
];

const BATCH_FIELDS_BY_COMMAND: Record<BatchCommand, readonly string[]> = {
  "comment.create": ["command", "pr", "message", "file", "line", "endLine"],
  "comment.reply": ["command", "pr", "thread", "message"],
  "comment.edit": ["command", "pr", "thread", "comment", "message"],
  "comment.delete": ["command", "pr", "thread", "comment"],
  "comment.resolve": ["command", "pr", "thread"],
};

const BATCH_FIELDS = new Set([
  "command",
  "pr",
  "thread",
  "comment",
  "message",
  "file",
  "line",
  "endLine",
]);

/** Validates and normalizes one element of a `comment batch` command's JSON operations array. */
function parseBatchOperation(raw: unknown, index: number): BatchOperation {
  const label = `Batch operation ${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const op = raw as Record<string, unknown>;

  const command = op.command;
  if (typeof command !== "string" || !BATCH_COMMANDS.includes(command as BatchCommand)) {
    throw new Error(
      `${label} has an invalid "command" (must be one of: ${BATCH_COMMANDS.join(", ")}).`,
    );
  }
  const batchCommand = command as BatchCommand;
  const allowedFields = BATCH_FIELDS_BY_COMMAND[batchCommand];
  for (const field of Object.keys(op)) {
    if (!BATCH_FIELDS.has(field)) {
      throw new Error(`${label} ("${batchCommand}") has an unknown field "${field}".`);
    }
    if (!allowedFields.includes(field)) {
      throw new Error(`${label} ("${batchCommand}") has an irrelevant field "${field}".`);
    }
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

  function requiredPositiveIntField(field: string): number {
    const value = positiveIntField(field);
    if (value === undefined) {
      throw new Error(`${label} ("${batchCommand}") requires a "${field}".`);
    }
    return value;
  }

  function requiredMessage(): string {
    const value = op.message;
    if (value === undefined || value === "") {
      throw new Error(`${label} ("${batchCommand}") requires a "message".`);
    }
    if (typeof value !== "string") {
      throw new Error(`${label} has an invalid "message" (must be a string).`);
    }
    return value;
  }

  function optionalFile(): string | undefined {
    const value = op.file;
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} has an invalid "file" (must be a non-empty string).`);
    }
    return value;
  }

  const pr = positiveIntField("pr");
  switch (batchCommand) {
    case "comment.create": {
      const message = requiredMessage();
      const file = optionalFile();
      const line = positiveIntField("line");
      const endLine = positiveIntField("endLine");
      if (line !== undefined && file === undefined) {
        throw new Error(`${label} ("${batchCommand}") has "line" but no "file".`);
      }
      if (endLine !== undefined && line === undefined) {
        throw new Error(`${label} ("${batchCommand}") has "endLine" but no "line".`);
      }
      if (endLine !== undefined && line !== undefined && endLine < line) {
        throw new Error(`${label} ("${batchCommand}") has "endLine" < "line".`);
      }
      return { command: batchCommand, pr, message, file, line, endLine };
    }
    case "comment.reply":
      return {
        command: batchCommand,
        pr,
        thread: requiredPositiveIntField("thread"),
        message: requiredMessage(),
      };
    case "comment.edit":
      return {
        command: batchCommand,
        pr,
        thread: requiredPositiveIntField("thread"),
        comment: requiredPositiveIntField("comment"),
        message: requiredMessage(),
      };
    case "comment.delete":
      return {
        command: batchCommand,
        pr,
        thread: requiredPositiveIntField("thread"),
        comment: requiredPositiveIntField("comment"),
      };
    case "comment.resolve":
      return {
        command: batchCommand,
        pr,
        thread: requiredPositiveIntField("thread"),
      };
  }
}

/** Reads and JSON-parses the full contents of stdin. Used by the `comment batch` command. */
async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new Error(
      "comment batch reads its operations from stdin, but none was piped/redirected in " +
        "(stdin is a terminal). Use e.g. `pr.sh comment batch < operations.json`.",
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error(
      "No batch operations provided on stdin. Pipe/redirect a JSON array of operations in, e.g. `pr.sh comment batch < operations.json`.",
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
  threads: ThreadService,
  defaultPrId: number,
  op: BatchOperation,
): Promise<string> {
  const prId = op.pr ?? defaultPrId;
  switch (op.command) {
    case "comment.create": {
      const location = toCommentLocation(op);
      const thread = await threads.comment(prId, op.message, location);
      const url = threads.webUrl(prId, thread.id);
      return `posted new comment thread ${thread.id} on PR #${prId} (${url})`;
    }
    case "comment.reply": {
      await threads.reply(prId, op.thread, op.message);
      return `posted reply to thread ${op.thread} on PR #${prId}`;
    }
    case "comment.edit": {
      await threads.edit(prId, op.thread, op.comment, op.message);
      return `edited comment ${op.comment} in thread ${op.thread} on PR #${prId}`;
    }
    case "comment.delete": {
      await threads.delete(prId, op.thread, op.comment);
      return `deleted comment ${op.comment} from thread ${op.thread} on PR #${prId}`;
    }
    case "comment.resolve": {
      await threads.resolve(prId, op.thread);
      return `marked thread ${op.thread} on PR #${prId} as resolved`;
    }
  }
}

export function createBatchRunner({ threads }: { threads: ThreadService }): {
  run(defaultPrId: number): Promise<void>;
} {
  async function run(defaultPrId: number): Promise<void> {
    const raw = await readStdinJson();
    if (!Array.isArray(raw)) {
      throw new Error("Batch operations must be a JSON array.");
    }
    const operations = raw.map((entry, index) => parseBatchOperation(entry, index));
    if (operations.length === 0) {
      console.log("No batch operations to run.");
      return;
    }

    let hadFailure = false;
    for (const [index, op] of operations.entries()) {
      const label = `[${index + 1}/${operations.length}] ${op.command}`;
      try {
        const result = await executeBatchOperation(threads, defaultPrId, op);
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

  return { run };
}
