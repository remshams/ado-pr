export type FlagKind = "string" | "positiveInteger" | "boolean";

interface FlagDefinition {
  kind: FlagKind;
  usage: string;
  description: string;
}

/** Global flag syntax. Commands opt into these flags through COMMAND_REGISTRY. */
export const FLAG_DEFINITIONS = {
  pr: {
    kind: "positiveInteger",
    usage: "--pr <id>",
    description: "Use a specific pull request instead of the current branch's active PR.",
  },
  title: {
    kind: "string",
    usage: "--title <text>",
    description: "Pull request title (required for `pr create`).",
  },
  description: {
    kind: "string",
    usage: "--description <text>",
    description: "Pull request description. Pass an explicit empty string to clear it.",
  },
  source: {
    kind: "string",
    usage: "--source <branch>",
    description: "Source branch for `pr create` (defaults to the current branch).",
  },
  target: {
    kind: "string",
    usage: "--target <branch>",
    description: "Target branch for `pr create` (defaults to the repository default).",
  },
  draft: {
    kind: "boolean",
    usage: "--draft",
    description: "Create a draft PR or mark an existing PR as draft.",
  },
  "no-draft": {
    kind: "boolean",
    usage: "--no-draft",
    description: "Mark an existing PR as ready; valid only for `pr edit`.",
  },
  thread: {
    kind: "positiveInteger",
    usage: "--thread <id>",
    description: "Thread ID for reply/edit/delete/resolve.",
  },
  comment: {
    kind: "positiveInteger",
    usage: "--comment <id>",
    description: "Comment ID for edit/delete.",
  },
  message: {
    kind: "string",
    usage: "--message <text>",
    description: "Comment text for create/reply/edit.",
  },
  file: {
    kind: "string",
    usage: "--file <path>",
    description: "Anchor a new comment thread to a repository-relative file.",
  },
  line: {
    kind: "positiveInteger",
    usage: "--line <n>",
    description: "Anchor to a line in --file. Requires --file.",
  },
  "end-line": {
    kind: "positiveInteger",
    usage: "--end-line <n>",
    description: "End an anchored range. Requires --line and must be >= --line.",
  },
  "exclude-own": {
    kind: "boolean",
    usage: "--exclude-own",
    description: "Hide threads where the current identity is the only commenter.",
  },
  "exclude-resolved": {
    kind: "boolean",
    usage: "--exclude-resolved",
    description: "Hide resolved threads.",
  },
  json: {
    kind: "boolean",
    usage: "--json",
    description: "Print raw JSON for `pr show` or `comment list`.",
  },
  help: {
    kind: "boolean",
    usage: "-h, --help",
    description: "Show this help.",
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAG_DEFINITIONS;
export type TextFlagName = {
  [Name in FlagName]: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "string" ? Name : never;
}[FlagName];
export type PositiveIntegerFlagName = {
  [Name in FlagName]: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "positiveInteger"
    ? Name
    : never;
}[FlagName];
export type StringFlagName = TextFlagName | PositiveIntegerFlagName;
export type BooleanFlagName = {
  [Name in FlagName]: (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "boolean" ? Name : never;
}[FlagName];

export const TEXT_FLAG_NAMES = Object.entries(FLAG_DEFINITIONS)
  .filter(([, definition]) => definition.kind === "string")
  .map(([name]) => name) as TextFlagName[];

export const POSITIVE_INTEGER_FLAG_NAMES = Object.entries(FLAG_DEFINITIONS)
  .filter(([, definition]) => definition.kind === "positiveInteger")
  .map(([name]) => name) as PositiveIntegerFlagName[];

export const STRING_FLAG_NAMES: StringFlagName[] = [
  ...TEXT_FLAG_NAMES,
  ...POSITIVE_INTEGER_FLAG_NAMES,
];

export const BOOLEAN_FLAG_NAMES = Object.entries(FLAG_DEFINITIONS)
  .filter(([, definition]) => definition.kind === "boolean")
  .map(([name]) => name) as BooleanFlagName[];

export type BatchFieldKind = "command" | "positiveInteger" | "message" | "file";

interface BatchFieldDefinition {
  kind: BatchFieldKind;
  required: boolean;
  example: string;
}

/** Batch field syntax shared by all batch-capable commands. */
export const BATCH_FIELD_DEFINITIONS = {
  command: { kind: "command", required: true, example: "" },
  pr: { kind: "positiveInteger", required: false, example: "n" },
  thread: { kind: "positiveInteger", required: true, example: "n" },
  comment: { kind: "positiveInteger", required: true, example: "n" },
  message: { kind: "message", required: true, example: '"..."' },
  file: { kind: "file", required: false, example: '"..."' },
  line: { kind: "positiveInteger", required: false, example: "n" },
  endLine: { kind: "positiveInteger", required: false, example: "n" },
} as const satisfies Record<string, BatchFieldDefinition>;

export type BatchFieldName = keyof typeof BATCH_FIELD_DEFINITIONS;

export type CommandValidationRule = "draftState" | "commentLocation";

interface CommandDefinition {
  resource: "pr" | "comment";
  command: string;
  usage: string;
  summary: string;
  flags: readonly FlagName[];
  requiredFlags?: readonly FlagName[];
  validationRules?: readonly CommandValidationRule[];
  batchFields?: readonly BatchFieldName[];
}

function defineCommandRegistry<const Registry extends Record<string, CommandDefinition>>(
  registry: Registry & {
    [Id in keyof Registry]: {
      requiredFlags?: readonly Registry[Id]["flags"][number][];
    };
  },
): Registry {
  return registry;
}

/**
 * The authoritative inventory of commands and their external contracts.
 *
 * CLI routes, accepted flags, help text, batch command names, and batch field allowlists are all
 * derived from this registry.
 */
export const COMMAND_REGISTRY = defineCommandRegistry({
  "pr.show": {
    resource: "pr",
    command: "show",
    usage: "pr show [--pr <id>] [--json]",
    summary: "Show pull request details. Use --json for raw data.",
    flags: ["pr", "json"],
  },
  "pr.create": {
    resource: "pr",
    command: "create",
    usage:
      'pr create --title "..." [--description "..."] [--source <branch>] [--target <branch>] [--draft]',
    summary: "Create a pull request from the current branch or --source.",
    flags: ["title", "description", "source", "target", "draft"],
    requiredFlags: ["title"],
  },
  "pr.edit": {
    resource: "pr",
    command: "edit",
    usage: 'pr edit [--description "..."] [--draft | --no-draft] [--pr <id>]',
    summary: "Change a pull request description and/or draft state.",
    flags: ["pr", "description", "draft", "no-draft"],
    validationRules: ["draftState"],
  },
  "comment.list": {
    resource: "comment",
    command: "list",
    usage: "comment list [--pr <id>] [--json] [--exclude-own] [--exclude-resolved]",
    summary: "List comment threads, optionally filtering or printing JSON.",
    flags: ["pr", "json", "exclude-own", "exclude-resolved"],
  },
  "comment.create": {
    resource: "comment",
    command: "create",
    usage:
      'comment create --message "..." [--pr <id>] [--file <path> [--line <n> [--end-line <n>]]]',
    summary: "Create a general or file-anchored comment thread.",
    flags: ["pr", "message", "file", "line", "end-line"],
    requiredFlags: ["message"],
    validationRules: ["commentLocation"],
    batchFields: ["command", "message", "pr", "file", "line", "endLine"],
  },
  "comment.reply": {
    resource: "comment",
    command: "reply",
    usage: 'comment reply --thread <id> --message "..." [--pr <id>]',
    summary: "Reply to an existing thread.",
    flags: ["pr", "thread", "message"],
    requiredFlags: ["thread", "message"],
    batchFields: ["command", "thread", "message", "pr"],
  },
  "comment.edit": {
    resource: "comment",
    command: "edit",
    usage: 'comment edit --thread <id> --comment <id> --message "..." [--pr <id>]',
    summary: "Edit an existing comment.",
    flags: ["pr", "thread", "comment", "message"],
    requiredFlags: ["thread", "comment", "message"],
    batchFields: ["command", "thread", "comment", "message", "pr"],
  },
  "comment.delete": {
    resource: "comment",
    command: "delete",
    usage: "comment delete --thread <id> --comment <id> [--pr <id>]",
    summary: "Delete an existing comment.",
    flags: ["pr", "thread", "comment"],
    requiredFlags: ["thread", "comment"],
    batchFields: ["command", "thread", "comment", "pr"],
  },
  "comment.resolve": {
    resource: "comment",
    command: "resolve",
    usage: "comment resolve --thread <id> [--pr <id>]",
    summary: "Mark an existing thread as resolved.",
    flags: ["pr", "thread"],
    requiredFlags: ["thread"],
    batchFields: ["command", "thread", "pr"],
  },
  "comment.batch": {
    resource: "comment",
    command: "batch",
    usage: "comment batch [--pr <id>] < operations.json",
    summary: "Run comment operations from a JSON array read from stdin.",
    flags: ["pr"],
  },
});

export type CommandId = keyof typeof COMMAND_REGISTRY;
export type CommandRegistryEntry = (typeof COMMAND_REGISTRY)[CommandId];
export type ResourceName = CommandRegistryEntry["resource"];
export type BatchCommand = {
  [Id in CommandId]: (typeof COMMAND_REGISTRY)[Id] extends {
    batchFields: readonly BatchFieldName[];
  }
    ? Id
    : never;
}[CommandId];

type CommandFlag<Id extends CommandId> = (typeof COMMAND_REGISTRY)[Id]["flags"][number];
type RequiredCommandFlag<Id extends CommandId> = (typeof COMMAND_REGISTRY)[Id] extends {
  requiredFlags: readonly (infer Name extends FlagName)[];
}
  ? Name
  : never;
type FlagValue<Name extends FlagName> = (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "boolean"
  ? boolean
  : (typeof FLAG_DEFINITIONS)[Name]["kind"] extends "positiveInteger"
    ? number
    : string;
type PresentCommandFlag<Id extends CommandId> =
  | RequiredCommandFlag<Id>
  | Extract<CommandFlag<Id>, BooleanFlagName>;

/** Parsed values guaranteed by a command's registered flag schema. */
export type ParsedCommandFlags<Id extends CommandId> = {
  [Name in PresentCommandFlag<Id>]-?: FlagValue<Name>;
} & {
  [Name in Exclude<CommandFlag<Id>, PresentCommandFlag<Id>>]?: FlagValue<Name>;
};

type BatchFieldFor<Id extends BatchCommand> = (typeof COMMAND_REGISTRY)[Id] extends {
  batchFields: readonly (infer Field extends BatchFieldName)[];
}
  ? Exclude<Field, "command">
  : never;
type BatchFieldValue<Field extends BatchFieldName> =
  (typeof BATCH_FIELD_DEFINITIONS)[Field]["kind"] extends "positiveInteger" ? number : string;
type RequiredBatchField<Id extends BatchCommand> = {
  [Field in BatchFieldFor<Id>]: (typeof BATCH_FIELD_DEFINITIONS)[Field]["required"] extends true
    ? Field
    : never;
}[BatchFieldFor<Id>];

/** A validated batch operation, derived from its registered fields and their value definitions. */
export type BatchOperation = {
  [Id in BatchCommand]: {
    command: Id;
  } & {
    [Field in RequiredBatchField<Id>]-?: BatchFieldValue<Field>;
  } & {
    [Field in Exclude<BatchFieldFor<Id>, RequiredBatchField<Id>>]?: BatchFieldValue<Field>;
  };
}[BatchCommand];

export const COMMAND_IDS = Object.keys(COMMAND_REGISTRY) as CommandId[];
export const RESOURCE_NAMES = [...new Set(COMMAND_IDS.map((id) => COMMAND_REGISTRY[id].resource))];
export const BATCH_COMMANDS = COMMAND_IDS.filter(
  (id): id is BatchCommand => "batchFields" in COMMAND_REGISTRY[id],
);
export const BATCH_FIELD_NAMES = Object.keys(BATCH_FIELD_DEFINITIONS) as BatchFieldName[];

export function isResourceName(value: string): value is ResourceName {
  return RESOURCE_NAMES.includes(value as ResourceName);
}

export function getCommandId(resource: string, command: string): CommandId | undefined {
  const id = `${resource}.${command}`;
  return Object.hasOwn(COMMAND_REGISTRY, id) ? (id as CommandId) : undefined;
}

export function getCommandDefinition(
  resource: string,
  command: string,
): CommandRegistryEntry | undefined {
  const id = getCommandId(resource, command);
  return id ? COMMAND_REGISTRY[id] : undefined;
}

export function isBatchCommand(value: string): value is BatchCommand {
  return BATCH_COMMANDS.includes(value as BatchCommand);
}

export function getBatchFields(command: BatchCommand): readonly BatchFieldName[] {
  return (
    COMMAND_REGISTRY[command] as CommandRegistryEntry & {
      batchFields: readonly BatchFieldName[];
    }
  ).batchFields;
}

export function getCommandValidationRules(command: CommandId): readonly CommandValidationRule[] {
  const definition = COMMAND_REGISTRY[command] as CommandDefinition;
  return definition.validationRules ?? [];
}

function formatBatchShape(command: BatchCommand): string {
  const fields = getBatchFields(command).map((field) => {
    if (field === "command") {
      return `"command":"${command}"`;
    }
    const definition = BATCH_FIELD_DEFINITIONS[field];
    return `"${field}"${definition.required ? "" : "?"}:${definition.example}`;
  });
  return `{${fields.join(",")}}`;
}

export function formatHelp(): string {
  const commands = COMMAND_IDS.map((id) => COMMAND_REGISTRY[id]);
  const usage = commands
    .map((definition, index) => `${index === 0 ? "Usage:" : "      "} pr.sh ${definition.usage}`)
    .join("\n");
  const commandList = commands
    .map(
      (definition) =>
        `  ${`${definition.resource} ${definition.command}`.padEnd(25)}${definition.summary}`,
    )
    .join("\n");
  const batchShapes = BATCH_COMMANDS.map((command) => `    ${formatBatchShape(command)}`).join(
    "\n",
  );
  const options = Object.values(FLAG_DEFINITIONS)
    .map((definition) => `  ${definition.usage.padEnd(25)}${definition.description}`)
    .join("\n");

  return `${usage}

Commands:
${commandList}

Batch input:
  Each array element must have exactly one of these shapes (fields marked ? are optional):
${batchShapes}
  Per-operation "pr" overrides the command's --pr/default PR for that operation. Unknown fields and
  fields irrelevant to the selected command are invalid. Operations execute sequentially in array
  order. A failed operation is reported and later operations still run; after all operations finish,
  the process exits nonzero if any operation failed.

Options:
${options}

Requires:
  - A git checkout whose origin remote points at Azure Repos.
  - AZURE_DEVOPS_PAT exported by the caller or set in .env.`;
}
