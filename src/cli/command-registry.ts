import { BATCH_COMMANDS, BATCH_FIELD_DEFINITIONS, COMMAND_IDS, COMMAND_REGISTRY, FLAG_DEFINITIONS, getBatchFields, type BatchCommand } from "../shared/command-contracts.ts";

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

function formatHelpRows(rows: readonly (readonly [string, string])[], minimumWidth = 0): string {
  const width = Math.max(minimumWidth, ...rows.map(([label]) => label.length + 2));
  return rows
    .map(([label, description]) => `  ${label.padEnd(width)}${description}`)
    .join("\n");
}

export function formatHelp(): string {
  const commands = COMMAND_IDS.map((id) => COMMAND_REGISTRY[id]);
  const usage = commands
    .map((definition, index) => `${index === 0 ? "Usage:" : "      "} pr.sh ${definition.usage}`)
    .join("\n");
  const commandList = formatHelpRows(
    commands.map(
      (definition): [string, string] => [
        `${definition.resource} ${definition.command}`,
        definition.summary,
      ],
    ),
    25,
  );
  const batchShapes = BATCH_COMMANDS.map((command) => `    ${formatBatchShape(command)}`).join(
    "\n",
  );
  const options = formatHelpRows(
    Object.values(FLAG_DEFINITIONS).map(
      (definition): [string, string] => [definition.usage, definition.description],
    ),
  );

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

Build wait:
  \`build wait\` monitors validation metadata for the requested build, whether it is current or
  historical. --pr only selects or resolves the associated pull request. After bounded PR
  resolution, polling runs every 60 seconds for up to 1 hour by default; --interval accepts
  10–3600 seconds and --timeout accepts 10–86400 seconds. Five-minute heartbeats and progress go to
  stderr. Completed and timed-out waits emit one final human or pretty JSON result to stdout;
  operational failures and signals emit none. JSON includes the selected PR summary, requested
  build ID, raw Azure build metadata (or null before observation), counters, elapsed polling time,
  timeout state, and outcome; inspect raw metadata before persisting it.
  Exit codes are 0 for succeeded, 124 for timeout, 1 for other outcomes/errors, 130 for SIGINT, and
  143 for SIGTERM. Transient poll requests retry, but a third consecutive transient failure aborts.
  Waiting never retries/requeues the build, fetches logs, retries individual work, or mutates builds;
  use \`build show\` afterward for diagnostics.

Requires:
  - A git checkout whose origin remote points at Azure Repos.
  - AZURE_DEVOPS_PAT exported by the caller or set in .env.
  - PAT Code (Read & Write) for PR/comment mutations; Code (Read) is sufficient for build commands.
  - Build read, also named vso.build, for build queries; Build execute, also named vso.build_execute,
    additionally for build retries.
  - Build commands support YAML and classic Build API validation runs, not Releases, external status
    checks, or individual stage/job/task retries.
  - Identity (Read), also named vso.identity, only for --reviewer additions on pr create/edit.
    --remove-reviewer resolves current PR reviewers and needs only Code (Read & Write).

Image notes:
  Every --image path needs a matching {{image:<basename>}} in the effective description, and every
  such placeholder needs a corresponding --image. Existing attachment displayName collisions are
  rejected before upload using case-sensitive filename matching; replacement is not supported.
  Upload failures before the description update trigger best-effort cleanup of new attachments. If
  the final update fails, its outcome is uncertain, so uploads are retained and may be orphaned.
  Generated image Markdown has an adjacent invisible ownership marker. Keep the marker unchanged for
  automatic reference removal. If it is edited or removed, attachment deletion retains the custom
  reference, which may then be broken.`;
}
