import minimist from "minimist";

import {
  actionRequiresComment,
  actionRequiresMessage,
  actionRequiresThread,
  isPositiveInteger,
} from "./operation-types.ts";

export type Action =
  | "list"
  | "show"
  | "update"
  | "reply"
  | "resolve"
  | "create"
  | "comment"
  | "edit"
  | "delete"
  | "batch";

export interface Options {
  action: Action;
  pr?: number;
  thread?: number;
  comment?: number;
  message?: string;
  json: boolean;
  excludeOwn: boolean;
  excludeResolved: boolean;
  title?: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft: boolean;
  file?: string;
  line?: number;
  endLine?: number;
}

function printUsageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.error(`Usage: pr.sh [list] [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]
       pr.sh show [--pr <id>] [--json]
       pr.sh update --description "..." [--pr <id>]
       pr.sh create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft]
       pr.sh comment --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]
       pr.sh reply --thread <id> --message "..." [--pr <id>]
       pr.sh edit --thread <id> --comment <id> --message "..." [--pr <id>]
       pr.sh delete --thread <id> --comment <id> [--pr <id>]
       pr.sh resolve --thread <id> [--pr <id>]
       pr.sh batch [--pr <id>] < operations.json

Actions:
  list                     Lists comment threads for the pull request matching the current
                           branch (both resolved and unresolved, unless narrowed below). This is
                           the default action.
  show                     Shows details for the pull request matching the current branch,
                           including its description, status, draft state, and source/target
                           branches. Use --json to print the raw pull request data.
  update                   Replaces the pull request's description. An empty description clears
                           the existing value.
  create                   Creates a new pull request from the current branch (or --source, if
                           given). Prints the new PR's ID and web URL.
  comment                  Posts a new, top-level comment thread on the pull request - either
                           general, or anchored to a file (optionally a specific line/range).
                           Use \`reply\` instead to respond within an existing thread.
  reply                    Posts a reply comment to an existing thread.
  edit                     Edits an existing comment in a thread.
  delete                   Deletes an existing comment from a thread.
  resolve                  Marks an existing thread as resolved. This always sets the thread's
                           status to Azure DevOps' "fixed" state (not "closed"/"won't fix" -
                           there's currently no flag to choose those instead).
  batch                    Runs several comment/reply/edit/delete/resolve operations from a single
                           invocation (a JSON array of operations, read from stdin). Useful for
                           applying multiple comment changes at once - only needs approving/
                           authenticating one command instead of one per operation, and shares
                           file-anchoring lookups across comments on the same PR instead of
                           repeating them per comment. Each array element is an object shaped like
                           one of:
                             {"action": "comment", "message": "...", "file"?: "...", "line"?: n, "endLine"?: n}
                             {"action": "reply", "thread": n, "message": "..."}
                             {"action": "edit", "thread": n, "comment": n, "message": "..."}
                             {"action": "delete", "thread": n, "comment": n}
                             {"action": "resolve", "thread": n}
                           Every operation may set its own "pr" to override --pr/the auto-detected
                           PR for just that operation. Operations run in order; a failure is
                           reported inline and does not stop the remaining operations, but the
                           process exits non-zero if any operation failed.

Options:
  --pr <id>                Pull request ID to use, instead of auto-detecting it from the active
                           pull request(s) for the current branch. Required if more than one
                           active pull request matches the current branch. Not used by \`create\`.
                           For \`batch\`, this is the default for operations that don't set their
                           own "pr".
  --thread <id>            Required for reply/edit/delete/resolve. The thread ID, as shown by
                           \`list\`.
  --comment <id>           Required for edit/delete. The comment ID, as shown by \`list\`.
  --message <text>         Required for comment/reply/edit. The comment text to post or replace.
  --title <text>           Required for \`create\`. The pull request's title.
  --description <text>     For \`create\`, the pull request's description (defaults to empty).
                           For \`update\`, the replacement description (required, but may be empty).
  --source <branch>        For \`create\`. The branch to create the pull request from. Defaults to
                           the current branch. Must already exist on the remote.
  --target <branch>        For \`create\`. The branch to merge into. Defaults to the repository's
                           default branch.
  --draft                  For \`create\`. Creates the pull request as a draft.
  --file <path>            For \`comment\`. Anchors the new thread to a file (repo-relative path),
                           instead of leaving it as a general PR-level comment.
  --line <n>               For \`comment\`. Anchors the new thread to a specific line in --file
                           (on the current/right-hand side of the diff). Requires --file.
  --end-line <n>           For \`comment\`. Extends the anchored line into a range, ending at this
                           line (inclusive). Requires --line.
  --exclude-own            For \`list\`: drops threads where you (the identity behind
                           AZURE_DEVOPS_PAT) are the only commenter, i.e. keeps only threads that
                           have at least one comment from someone else. Threads with replies from
                           others are shown in full, including your own comments in them, for
                           context.
  --exclude-resolved       For \`list\`: only show threads that are still active/pending, hiding
                           ones already marked fixed/closed/won't-fix.
  --json                   For \`list\`, print the raw thread data as JSON instead of a
                           human-readable summary. Any --exclude-* filters are applied first.
                           For \`show\`, print the raw pull request data as JSON instead of the
                           human-readable PR details.
  -h, --help               Show this help.

Requires:
  - Being run from within a git checkout whose origin remote points at Azure Repos (so the
    current branch/remote can be read).
  - AZURE_DEVOPS_PAT exported by the caller or set in .env. Regular .env files accept a literal
    PAT or op:// reference; a 1Password Environment may instead mount a literal PAT at that path.
`);
  process.exit(message ? 1 : 0);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePositiveIntFlag(
  argv: minimist.ParsedArgs,
  flag: "pr" | "thread" | "comment" | "line" | "end-line",
): number | undefined {
  if (argv[flag] === undefined) {
    return undefined;
  }
  const raw = stringArg(argv[flag]);
  const value = raw ? Number(raw) : NaN;
  if (!isPositiveInteger(value)) {
    printUsageAndExit(
      `invalid --${flag} "${argv[flag]}" (pass it once, as a single positive integer)`,
    );
  }
  return value;
}

function parseStringFlag(argv: minimist.ParsedArgs, flag: string): string | undefined {
  const value = stringArg(argv[flag]);
  if (argv[flag] !== undefined && value === undefined) {
    printUsageAndExit(`invalid --${flag} "${argv[flag]}" (pass it once, as a single string)`);
  }
  return value;
}

function hasBareStringFlag(args: string[], flag: string): boolean {
  const token = `--${flag}`;
  return args.some((arg, index) => {
    const next = args[index + 1];
    return arg === token && (next === undefined || (next !== "-" && next.startsWith("-")));
  });
}

const ACTIONS: Action[] = [
  "list",
  "show",
  "update",
  "reply",
  "resolve",
  "create",
  "comment",
  "edit",
  "delete",
  "batch",
];

export function parseArgs(): Options {
  const args = process.argv.slice(2);
  const argv = minimist(args, {
    string: [
      "pr",
      "thread",
      "comment",
      "message",
      "title",
      "description",
      "source",
      "target",
      "file",
      "line",
      "end-line",
    ],
    boolean: ["help", "json", "exclude-own", "exclude-resolved", "draft"],
    alias: { h: "help" },
  });

  if (argv.help) {
    printUsageAndExit();
  }

  const positional = argv._[0] as string | undefined;
  const action: Action = (positional as Action | undefined) ?? "list";
  if (positional && !ACTIONS.includes(action)) {
    printUsageAndExit(`unknown action "${positional}"`);
  }

  const pr = parsePositiveIntFlag(argv, "pr");
  const thread = parsePositiveIntFlag(argv, "thread");
  const comment = parsePositiveIntFlag(argv, "comment");
  const line = parsePositiveIntFlag(argv, "line");
  const endLine = parsePositiveIntFlag(argv, "end-line");

  const message = parseStringFlag(argv, "message");
  const title = parseStringFlag(argv, "title");
  const description = parseStringFlag(argv, "description");
  const sourceBranch = parseStringFlag(argv, "source");
  const targetBranch = parseStringFlag(argv, "target");
  const file = parseStringFlag(argv, "file");

  if (actionRequiresThread(action) && !thread) {
    printUsageAndExit(`--thread is required for "${action}"`);
  }
  if (actionRequiresComment(action) && !comment) {
    printUsageAndExit(`--comment is required for "${action}"`);
  }
  if (actionRequiresMessage(action) && !message) {
    printUsageAndExit(`--message is required for "${action}"`);
  }
  if (action === "create" && !title) {
    printUsageAndExit(`--title is required for "create"`);
  }
  if (action === "update" && description === undefined) {
    printUsageAndExit(`--description is required for "update"`);
  }
  if (action === "update" && hasBareStringFlag(args, "description")) {
    printUsageAndExit(`--description requires an explicit value (use --description "" to clear)`);
  }
  if (action !== "comment" && (line || endLine)) {
    printUsageAndExit(`--line/--end-line are only valid for "comment"`);
  }
  if (line && !file) {
    printUsageAndExit(`--line requires --file`);
  }
  if (endLine && !line) {
    printUsageAndExit(`--end-line requires --line`);
  }
  if (endLine && line && endLine < line) {
    printUsageAndExit(`--end-line must be >= --line`);
  }

  return {
    action,
    pr,
    thread,
    comment,
    message,
    json: !!argv.json,
    excludeOwn: !!argv["exclude-own"],
    excludeResolved: !!argv["exclude-resolved"],
    title,
    description,
    sourceBranch,
    targetBranch,
    draft: !!argv.draft,
    file,
    line,
    endLine,
  };
}

export function getPat(): string {
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (!pat) {
    console.error(
      "Error: AZURE_DEVOPS_PAT is not set. Export it before running pr.ts, or configure it in .env and run pr.sh.",
    );
    process.exit(1);
  }
  if (pat.startsWith("op://")) {
    console.error(
      "Error: AZURE_DEVOPS_PAT is still an op:// reference. pr.sh resolves references from regular .env files, but a 1Password Environment mount must contain the literal PAT.",
    );
    process.exit(1);
  }
  return pat;
}
