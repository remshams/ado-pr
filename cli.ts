import minimist from "minimist";

import { isPositiveInteger, type CliOptions } from "./operation-types.ts";

const STRING_FLAGS = [
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
] as const;
const BOOLEAN_FLAGS = ["help", "json", "exclude-own", "exclude-resolved", "draft"] as const;
const KNOWN_FLAGS = new Set<string>([...STRING_FLAGS, ...BOOLEAN_FLAGS, "no-draft"]);
const STRING_FLAG_SET = new Set<string>(STRING_FLAGS);
const BOOLEAN_FLAG_SET = new Set<string>([...BOOLEAN_FLAGS, "no-draft"]);

const ROUTE_FLAGS: Record<string, ReadonlySet<string>> = {
  "pr show": new Set(["pr", "json"]),
  "pr create": new Set(["title", "description", "source", "target", "draft"]),
  "pr edit": new Set(["pr", "description", "draft", "no-draft"]),
  "comment list": new Set(["pr", "json", "exclude-own", "exclude-resolved"]),
  "comment create": new Set(["pr", "message", "file", "line", "end-line"]),
  "comment reply": new Set(["pr", "thread", "message"]),
  "comment edit": new Set(["pr", "thread", "comment", "message"]),
  "comment delete": new Set(["pr", "thread", "comment"]),
  "comment resolve": new Set(["pr", "thread"]),
  "comment batch": new Set(["pr"]),
};

interface FlagOccurrence {
  name: string;
  display: string;
  value?: string;
  hasExplicitValue: boolean;
  hasInlineValue: boolean;
}

function printUsageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.error(`Usage: pr.sh pr show [--pr <id>] [--json]
       pr.sh pr create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft]
       pr.sh pr edit [--description "..."] [--draft | --no-draft] [--pr <id>]
       pr.sh comment list [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]
       pr.sh comment create --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]
       pr.sh comment reply --thread <id> --message "..." [--pr <id>]
       pr.sh comment edit --thread <id> --comment <id> --message "..." [--pr <id>]
       pr.sh comment delete --thread <id> --comment <id> [--pr <id>]
       pr.sh comment resolve --thread <id> [--pr <id>]
       pr.sh comment batch [--pr <id>] < operations.json

Commands:
  pr show                  Show pull request details. Use --json for raw data.
  pr create                Create a pull request from the current branch or --source.
  pr edit                  Change a pull request description and/or draft state.
  comment list             List comment threads, optionally filtering or printing JSON.
  comment create           Create a general or file-anchored comment thread.
  comment reply            Reply to an existing thread.
  comment edit             Edit an existing comment.
  comment delete           Delete an existing comment.
  comment resolve          Mark an existing thread as resolved.
  comment batch            Run comment operations from a JSON array read from stdin.

Batch input:
  Each array element must have exactly one of these shapes (fields marked ? are optional):
    {"command":"comment.create","message":"...","pr"?:n,"file"?:"...","line"?:n,"endLine"?:n}
    {"command":"comment.reply","thread":n,"message":"...","pr"?:n}
    {"command":"comment.edit","thread":n,"comment":n,"message":"...","pr"?:n}
    {"command":"comment.delete","thread":n,"comment":n,"pr"?:n}
    {"command":"comment.resolve","thread":n,"pr"?:n}
  Per-operation "pr" overrides the command's --pr/default PR for that operation. Unknown fields and
  fields irrelevant to the selected command are invalid. Operations execute sequentially in array
  order. A failed operation is reported and later operations still run; after all operations finish,
  the process exits nonzero if any operation failed.

Options:
  --pr <id>                Use a specific pull request instead of the current branch's active PR.
  --title <text>           Pull request title (required for \`pr create\`).
  --description <text>     Pull request description. Pass an explicit empty string to clear it.
  --source <branch>        Source branch for \`pr create\` (defaults to the current branch).
  --target <branch>        Target branch for \`pr create\` (defaults to the repository default).
  --draft                  Create a draft PR or mark an existing PR as draft.
  --no-draft               Mark an existing PR as ready; valid only for \`pr edit\`.
  --thread <id>            Thread ID for reply/edit/delete/resolve.
  --comment <id>           Comment ID for edit/delete.
  --message <text>         Comment text for create/reply/edit.
  --file <path>            Anchor a new comment thread to a repository-relative file.
  --line <n>               Anchor to a line in --file. Requires --file.
  --end-line <n>           End an anchored range. Requires --line and must be >= --line.
  --exclude-own            Hide threads where the current identity is the only commenter.
  --exclude-resolved       Hide resolved threads.
  --json                   Print raw JSON for \`pr show\` or \`comment list\`.
  -h, --help               Show this help.

Requires:
  - A git checkout whose origin remote points at Azure Repos.
  - AZURE_DEVOPS_PAT exported by the caller or set in .env.
`);
  process.exit(message ? 1 : 0);
}

function looksLikeOption(token: string): boolean {
  return token.startsWith("--") || /^-[A-Za-z]/.test(token);
}

function scanFlags(args: string[]): FlagOccurrence[] {
  const occurrences: FlagOccurrence[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      break;
    }
    if (token === "-h") {
      occurrences.push({
        name: "help",
        display: "-h",
        hasExplicitValue: false,
        hasInlineValue: false,
      });
      continue;
    }
    if (!token.startsWith("--")) {
      if (token.startsWith("-") && token !== "-") {
        occurrences.push({
          name: token,
          display: token,
          hasExplicitValue: false,
          hasInlineValue: false,
        });
      }
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const isStringFlag = STRING_FLAG_SET.has(name);
    let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

    if (
      isStringFlag &&
      equalsIndex === -1 &&
      args[index + 1] !== undefined &&
      !looksLikeOption(args[index + 1])
    ) {
      value = args[index + 1];
      index += 1;
    }

    occurrences.push({
      name,
      display: `--${name}`,
      value,
      hasExplicitValue: value !== undefined,
      hasInlineValue: equalsIndex !== -1,
    });
  }

  return occurrences;
}

function validateKnownFlags(occurrences: FlagOccurrence[]): void {
  for (const occurrence of occurrences) {
    if (!KNOWN_FLAGS.has(occurrence.name)) {
      printUsageAndExit(`unknown option "${occurrence.display}"`);
    }
    if (BOOLEAN_FLAG_SET.has(occurrence.name) && occurrence.hasInlineValue) {
      printUsageAndExit(`${occurrence.display} does not take a value`);
    }
  }
}

function validateRouteFlags(
  route: string,
  allowed: ReadonlySet<string>,
  occurrences: FlagOccurrence[],
): Map<string, FlagOccurrence> {
  const byName = new Map<string, FlagOccurrence>();
  for (const occurrence of occurrences) {
    if (!allowed.has(occurrence.name)) {
      printUsageAndExit(`${occurrence.display} is not valid for "${route}"`);
    }
    if (byName.has(occurrence.name)) {
      printUsageAndExit(`${occurrence.display} may only be passed once`);
    }
    byName.set(occurrence.name, occurrence);
  }
  return byName;
}

function parseStringFlag(
  occurrences: Map<string, FlagOccurrence>,
  flag: string,
): string | undefined {
  const occurrence = occurrences.get(flag);
  if (!occurrence) {
    return undefined;
  }
  if (!occurrence.hasExplicitValue) {
    printUsageAndExit(`--${flag} requires an explicit value`);
  }
  return occurrence.value;
}

function parseRequiredStringFlag(
  occurrences: Map<string, FlagOccurrence>,
  flag: string,
  route: string,
): string {
  const value = parseStringFlag(occurrences, flag);
  if (!value) {
    printUsageAndExit(`--${flag} is required for "${route}"`);
  }
  return value;
}

function parsePositiveIntFlag(
  occurrences: Map<string, FlagOccurrence>,
  flag: "pr" | "thread" | "comment" | "line" | "end-line",
): number | undefined {
  const raw = parseStringFlag(occurrences, flag);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!isPositiveInteger(value)) {
    printUsageAndExit(`invalid --${flag} "${raw}" (pass it once, as a single positive integer)`);
  }
  return value;
}

function parseRequiredPositiveIntFlag(
  occurrences: Map<string, FlagOccurrence>,
  flag: "thread" | "comment",
  route: string,
): number {
  const value = parsePositiveIntFlag(occurrences, flag);
  if (value === undefined) {
    printUsageAndExit(`--${flag} is required for "${route}"`);
  }
  return value;
}

function validateHelpOptions(route: string, occurrences: Map<string, FlagOccurrence>): void {
  const positiveIntegerFlags = ["pr", "thread", "comment", "line", "end-line"] as const;
  for (const flag of positiveIntegerFlags) {
    if (occurrences.has(flag)) {
      parsePositiveIntFlag(occurrences, flag);
    }
  }
  for (const flag of ["message", "title", "description", "source", "target", "file"] as const) {
    if (occurrences.has(flag)) {
      parseStringFlag(occurrences, flag);
    }
  }

  const requireNonEmptyIfPresent = (flag: "message" | "title"): void => {
    if (occurrences.has(flag) && !parseStringFlag(occurrences, flag)) {
      printUsageAndExit(`--${flag} is required for "${route}"`);
    }
  };

  if (route === "pr create") {
    requireNonEmptyIfPresent("title");
  }
  if (route === "pr edit" && occurrences.has("draft") && occurrences.has("no-draft")) {
    printUsageAndExit(`--draft and --no-draft cannot be used together`);
  }
  if (route === "comment create") {
    requireNonEmptyIfPresent("message");
    const file = parseStringFlag(occurrences, "file");
    const line = parsePositiveIntFlag(occurrences, "line");
    const endLine = parsePositiveIntFlag(occurrences, "end-line");
    if (file === "") {
      printUsageAndExit(`--file must not be empty`);
    }
    if (line !== undefined && file === undefined) {
      printUsageAndExit(`--line requires --file`);
    }
    if (endLine !== undefined && line === undefined) {
      printUsageAndExit(`--end-line requires --line`);
    }
    if (endLine !== undefined && line !== undefined && endLine < line) {
      printUsageAndExit(`--end-line must be >= --line`);
    }
  }
  if (route === "comment reply" || route === "comment edit") {
    requireNonEmptyIfPresent("message");
  }
}

export function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const scanned = scanFlags(args);
  validateKnownFlags(scanned);

  if (args.length === 1 && scanned[0]?.name === "help") {
    printUsageAndExit();
  }

  const argv = minimist(args, {
    string: [...STRING_FLAGS],
    boolean: [...BOOLEAN_FLAGS],
    alias: { h: "help" },
  });
  const positional = argv._.map(String);
  const resource = positional[0];
  const command = positional[1];

  if (!resource) {
    printUsageAndExit("a resource and command are required");
  }
  if (resource !== "pr" && resource !== "comment") {
    printUsageAndExit(`unknown resource "${resource}"`);
  }
  if (!command) {
    printUsageAndExit(`a command is required for resource "${resource}"`);
  }
  if (positional.length > 2) {
    printUsageAndExit(`unexpected positional argument "${positional[2]}"`);
  }

  const route = `${resource} ${command}`;
  const allowed = ROUTE_FLAGS[route];
  if (!allowed) {
    printUsageAndExit(`unknown command "${command}" for resource "${resource}"`);
  }
  const occurrences = validateRouteFlags(route, new Set([...allowed, "help"]), scanned);
  if (occurrences.has("help")) {
    validateHelpOptions(route, occurrences);
    printUsageAndExit();
  }
  const pr = parsePositiveIntFlag(occurrences, "pr");

  if (resource === "pr") {
    switch (command) {
      case "show":
        return { resource, command, pr, json: occurrences.has("json") };
      case "create": {
        const title = parseRequiredStringFlag(occurrences, "title", route);
        const description = parseStringFlag(occurrences, "description");
        const sourceBranch = parseStringFlag(occurrences, "source");
        const targetBranch = parseStringFlag(occurrences, "target");
        return {
          resource,
          command,
          title,
          description,
          sourceBranch,
          targetBranch,
          draft: occurrences.has("draft"),
        };
      }
      case "edit": {
        const description = parseStringFlag(occurrences, "description");
        const setDraft = occurrences.has("draft");
        const clearDraft = occurrences.has("no-draft");
        if (setDraft && clearDraft) {
          printUsageAndExit(`--draft and --no-draft cannot be used together`);
        }
        const draft = setDraft ? true : clearDraft ? false : undefined;
        if (description !== undefined) {
          return { resource, command, pr, description, draft };
        }
        if (draft !== undefined) {
          return { resource, command, pr, draft };
        }
        printUsageAndExit(`--description, --draft, or --no-draft is required for "${route}"`);
      }
    }
  }

  switch (command) {
    case "list":
      return {
        resource: "comment",
        command,
        pr,
        json: occurrences.has("json"),
        excludeOwn: occurrences.has("exclude-own"),
        excludeResolved: occurrences.has("exclude-resolved"),
      };
    case "create": {
      const message = parseRequiredStringFlag(occurrences, "message", route);
      const file = parseStringFlag(occurrences, "file");
      const line = parsePositiveIntFlag(occurrences, "line");
      const endLine = parsePositiveIntFlag(occurrences, "end-line");
      if (file === "") {
        printUsageAndExit(`--file must not be empty`);
      }
      if (line !== undefined && file === undefined) {
        printUsageAndExit(`--line requires --file`);
      }
      if (endLine !== undefined && line === undefined) {
        printUsageAndExit(`--end-line requires --line`);
      }
      if (endLine !== undefined && line !== undefined && endLine < line) {
        printUsageAndExit(`--end-line must be >= --line`);
      }
      return { resource: "comment", command, pr, message, file, line, endLine };
    }
    case "reply":
      return {
        resource: "comment",
        command,
        pr,
        thread: parseRequiredPositiveIntFlag(occurrences, "thread", route),
        message: parseRequiredStringFlag(occurrences, "message", route),
      };
    case "edit":
      return {
        resource: "comment",
        command,
        pr,
        thread: parseRequiredPositiveIntFlag(occurrences, "thread", route),
        comment: parseRequiredPositiveIntFlag(occurrences, "comment", route),
        message: parseRequiredStringFlag(occurrences, "message", route),
      };
    case "delete":
      return {
        resource: "comment",
        command,
        pr,
        thread: parseRequiredPositiveIntFlag(occurrences, "thread", route),
        comment: parseRequiredPositiveIntFlag(occurrences, "comment", route),
      };
    case "resolve":
      return {
        resource: "comment",
        command,
        pr,
        thread: parseRequiredPositiveIntFlag(occurrences, "thread", route),
      };
    case "batch":
      return { resource: "comment", command, pr };
  }

  return printUsageAndExit(`unknown command "${command}" for resource "comment"`);
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
