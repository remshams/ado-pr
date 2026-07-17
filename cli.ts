import minimist from "minimist";

import {
  actionRequiresMessage,
  actionRequiresThread,
  isPositiveInteger,
} from "./operation-types.ts";

export type Action = "list" | "reply" | "resolve" | "create" | "comment" | "batch";

export interface Options {
  action: Action;
  pr?: number;
  thread?: number;
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
       pr.sh create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft]
       pr.sh comment --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]
       pr.sh reply --thread <id> --message "..." [--pr <id>]
       pr.sh resolve --thread <id> [--pr <id>]
       pr.sh batch [--pr <id>] < operations.json

Actions:
  list                     Lists comment threads for the pull request matching the current
                           branch (both resolved and unresolved, unless narrowed below). This is
                           the default action.
  create                   Creates a new pull request from the current branch (or --source, if
                           given). Prints the new PR's ID and web URL.
  comment                  Posts a new, top-level comment thread on the pull request - either
                           general, or anchored to a file (optionally a specific line/range).
                           Use \`reply\` instead to respond within an existing thread.
  reply                    Posts a reply comment to an existing thread.
  resolve                  Marks an existing thread as resolved. This always sets the thread's
                           status to Azure DevOps' "fixed" state (not "closed"/"won't fix" -
                           there's currently no flag to choose those instead).
  batch                    Runs several comment/reply/resolve operations from a single invocation
                           (a JSON array of operations, read from stdin). Useful for posting
                           multiple review comments (or replying to/resolving several threads) at
                           once - only needs approving/authenticating one command instead of one
                           per operation, and shares file-anchoring lookups across comments on the
                           same PR instead of repeating them per comment. Each array element is an
                           object shaped like one of:
                             {"action": "comment", "message": "...", "file"?: "...", "line"?: n, "endLine"?: n}
                             {"action": "reply", "thread": n, "message": "..."}
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
  --thread <id>            Required for reply/resolve. The thread ID, as shown by \`list\`.
  --message <text>         Required for reply/comment. The comment text to post.
  --title <text>           Required for \`create\`. The pull request's title.
  --description <text>     For \`create\`. The pull request's description. Defaults to empty.
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
  -h, --help               Show this help.

Requires:
  - Being run from within a git checkout whose origin remote points at Azure Repos (so the
    current branch/remote can be read).
  - AZURE_DEVOPS_PAT set in the environment (pr.sh loads this from .env - see .env.tpl).
`);
  process.exit(message ? 1 : 0);
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePositiveIntFlag(
  argv: minimist.ParsedArgs,
  flag: "pr" | "thread" | "line" | "end-line",
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

const ACTIONS: Action[] = ["list", "reply", "resolve", "create", "comment", "batch"];

export function parseArgs(): Options {
  const argv = minimist(process.argv.slice(2), {
    string: [
      "pr",
      "thread",
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
  if (actionRequiresMessage(action) && !message) {
    printUsageAndExit(`--message is required for "${action}"`);
  }
  if (action === "create" && !title) {
    printUsageAndExit(`--title is required for "create"`);
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
      "Error: AZURE_DEVOPS_PAT is not set. Run this via pr.sh, which injects it from 1Password.",
    );
    process.exit(1);
  }
  return pat;
}
