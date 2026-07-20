import minimist from "minimist";

import {
  BOOLEAN_FLAG_NAMES,
  COMMAND_REGISTRY,
  FLAG_DEFINITIONS,
  STRING_FLAG_NAMES,
  formatHelp,
  getCommandId,
  isResourceName,
  type CommandId,
  type CommandValidationRule,
  type FlagName,
  type ParsedCommandFlags,
  type PositiveIntegerFlagName,
  type StringFlagName,
  type TextFlagName,
} from "./command-registry.ts";
import { isPositiveInteger, type CliOptions } from "./operation-types.ts";

const KNOWN_FLAGS = new Set<string>(Object.keys(FLAG_DEFINITIONS));
const STRING_FLAG_SET = new Set<string>(STRING_FLAG_NAMES);
const BOOLEAN_FLAG_SET = new Set<string>(BOOLEAN_FLAG_NAMES);

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
  console.error(formatHelp());
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
  flag: StringFlagName,
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

function parsePositiveIntFlag(
  occurrences: Map<string, FlagOccurrence>,
  flag: PositiveIntegerFlagName,
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

function parseCommandFlags<Id extends CommandId>(
  commandId: Id,
  route: string,
  occurrences: Map<string, FlagOccurrence>,
  enforceRequired: true,
): ParsedCommandFlags<Id>;
function parseCommandFlags<Id extends CommandId>(
  commandId: Id,
  route: string,
  occurrences: Map<string, FlagOccurrence>,
  enforceRequired: false,
): void;
function parseCommandFlags<Id extends CommandId>(
  commandId: Id,
  route: string,
  occurrences: Map<string, FlagOccurrence>,
  enforceRequired: boolean,
): ParsedCommandFlags<Id> | void {
  const definition = COMMAND_REGISTRY[commandId];
  const values: Partial<Record<FlagName, string | number | boolean>> = {};
  const requiredFlags = new Set<FlagName>(
    "requiredFlags" in definition ? definition.requiredFlags : [],
  );

  for (const flag of definition.flags) {
    const kind = FLAG_DEFINITIONS[flag].kind;
    if (kind === "boolean") {
      values[flag] = occurrences.has(flag);
    } else if (kind === "positiveInteger") {
      values[flag] = parsePositiveIntFlag(occurrences, flag as PositiveIntegerFlagName);
    } else {
      values[flag] = parseStringFlag(occurrences, flag as TextFlagName);
    }

    if (enforceRequired && requiredFlags.has(flag) && !values[flag]) {
      printUsageAndExit(`--${flag} is required for "${route}"`);
    }
  }

  if (!enforceRequired) {
    for (const flag of requiredFlags) {
      if (occurrences.has(flag) && !values[flag]) {
        printUsageAndExit(`--${flag} is required for "${route}"`);
      }
    }
  }

  const validationRules: readonly CommandValidationRule[] | undefined =
    "validationRules" in definition ? definition.validationRules : undefined;
  if (validationRules?.includes("draftState")) {
    const setDraft = values.draft === true;
    const clearDraft = values["no-draft"] === true;
    if (setDraft && clearDraft) {
      printUsageAndExit(`--draft and --no-draft cannot be used together`);
    }
    if (enforceRequired && values.description === undefined && !setDraft && !clearDraft) {
      printUsageAndExit(`--description, --draft, or --no-draft is required for "${route}"`);
    }
  }
  if (validationRules?.includes("commentLocation")) {
    const file = values.file as string | undefined;
    const line = values.line as number | undefined;
    const endLine = values["end-line"] as number | undefined;
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

  if (enforceRequired) {
    return values as ParsedCommandFlags<Id>;
  }
}

type CliOptionsFor<Id extends CommandId> = Id extends `${infer Resource}.${infer Command}`
  ? Extract<CliOptions, { resource: Resource; command: Command }>
  : never;
type CommandOptionBuilders = {
  [Id in CommandId]: (values: ParsedCommandFlags<Id>) => CliOptionsFor<Id>;
};

const COMMAND_OPTION_BUILDERS: CommandOptionBuilders = {
  "pr.show": (values) => ({
    resource: "pr",
    command: "show",
    pr: values.pr,
    json: values.json,
  }),
  "pr.create": (values) => ({
    resource: "pr",
    command: "create",
    title: values.title,
    description: values.description,
    sourceBranch: values.source,
    targetBranch: values.target,
    draft: values.draft,
  }),
  "pr.edit": (values) => {
    const draft = values.draft ? true : values["no-draft"] ? false : undefined;
    if (values.description !== undefined) {
      return {
        resource: "pr",
        command: "edit",
        pr: values.pr,
        description: values.description,
        draft,
      };
    }
    if (draft === undefined) {
      throw new Error("Registered pr.edit validation did not produce an update.");
    }
    return { resource: "pr", command: "edit", pr: values.pr, draft };
  },
  "comment.list": (values) => ({
    resource: "comment",
    command: "list",
    pr: values.pr,
    json: values.json,
    excludeOwn: values["exclude-own"],
    excludeResolved: values["exclude-resolved"],
  }),
  "comment.create": (values) => ({
    resource: "comment",
    command: "create",
    pr: values.pr,
    message: values.message,
    file: values.file,
    line: values.line,
    endLine: values["end-line"],
  }),
  "comment.reply": (values) => ({
    resource: "comment",
    command: "reply",
    pr: values.pr,
    thread: values.thread,
    message: values.message,
  }),
  "comment.edit": (values) => ({
    resource: "comment",
    command: "edit",
    pr: values.pr,
    thread: values.thread,
    comment: values.comment,
    message: values.message,
  }),
  "comment.delete": (values) => ({
    resource: "comment",
    command: "delete",
    pr: values.pr,
    thread: values.thread,
    comment: values.comment,
  }),
  "comment.resolve": (values) => ({
    resource: "comment",
    command: "resolve",
    pr: values.pr,
    thread: values.thread,
  }),
  "comment.batch": (values) => ({
    resource: "comment",
    command: "batch",
    pr: values.pr,
  }),
};

function buildCliOptions<Id extends CommandId>(
  commandId: Id,
  values: ParsedCommandFlags<Id>,
): CliOptionsFor<Id> {
  return COMMAND_OPTION_BUILDERS[commandId](values);
}

export function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const scanned = scanFlags(args);
  validateKnownFlags(scanned);

  if (args.length === 1 && scanned[0]?.name === "help") {
    printUsageAndExit();
  }

  const argv = minimist(args, {
    string: [...STRING_FLAG_NAMES],
    boolean: [...BOOLEAN_FLAG_NAMES],
    alias: { h: "help" },
  });
  const positional = argv._.map(String);
  const resource = positional[0];
  const command = positional[1];

  if (!resource) {
    printUsageAndExit("a resource and command are required");
  }
  if (!isResourceName(resource)) {
    printUsageAndExit(`unknown resource "${resource}"`);
  }
  if (!command) {
    printUsageAndExit(`a command is required for resource "${resource}"`);
  }
  if (positional.length > 2) {
    printUsageAndExit(`unexpected positional argument "${positional[2]}"`);
  }

  const route = `${resource} ${command}`;
  const commandId = getCommandId(resource, command);
  if (!commandId) {
    printUsageAndExit(`unknown command "${command}" for resource "${resource}"`);
  }
  const definition = COMMAND_REGISTRY[commandId];
  const occurrences = validateRouteFlags(route, new Set([...definition.flags, "help"]), scanned);
  if (occurrences.has("help")) {
    parseCommandFlags(commandId, route, occurrences, false);
    printUsageAndExit();
  }
  const values = parseCommandFlags(commandId, route, occurrences, true);
  return buildCliOptions(commandId, values);
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
