import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_COMMANDS,
  BATCH_FIELD_DEFINITIONS,
  COMMAND_IDS,
  COMMAND_REGISTRY,
  FLAG_DEFINITIONS,
  REPEATABLE_STRING_FLAG_NAMES,
  formatHelp,
  getBatchFields,
  getCommandDefinition,
} from "../command-registry.ts";

test("registry keys, routes, and command-local schemas stay coherent", () => {
  for (const id of COMMAND_IDS) {
    const definition = COMMAND_REGISTRY[id];
    assert.equal(id, `${definition.resource}.${definition.command}`);
    assert.equal(getCommandDefinition(definition.resource, definition.command), definition);

    for (const flag of definition.flags) {
      assert.ok(Object.hasOwn(FLAG_DEFINITIONS, flag), `${id} references unknown flag ${flag}`);
    }
    for (const required of definition.requiredFlags ?? []) {
      assert.ok(definition.flags.includes(required), `${id} requires disallowed flag ${required}`);
    }
  }
});

test("registers resource-first build routes and keeps them out of batch schemas", () => {
  assert.deepEqual(COMMAND_REGISTRY["build.list"].flags, ["pr", "history", "json"]);
  assert.deepEqual(COMMAND_REGISTRY["build.show"].requiredFlags, ["build"]);
  assert.deepEqual(COMMAND_REGISTRY["build.retry"].requiredFlags, ["build"]);
  assert.deepEqual(COMMAND_REGISTRY["build.wait"].flags, ["build", "pr", "interval", "timeout", "json"]);
  assert.deepEqual(COMMAND_REGISTRY["build.wait"].requiredFlags, ["build"]);
  assert.equal(COMMAND_REGISTRY["build.wait"].usage, "build wait --build <id> [--pr <id>] [--interval <seconds>] [--timeout <seconds>] [--json]");
  assert.ok(!BATCH_COMMANDS.some((command) => command.startsWith("build.")));
  assert.equal(FLAG_DEFINITIONS.build.kind, "positiveInteger");
  assert.equal(FLAG_DEFINITIONS.history.kind, "boolean");
  assert.equal(FLAG_DEFINITIONS["full-logs"].kind, "boolean");
});

test("only image and reviewer mutation flags are repeatable strings", () => {
  assert.deepEqual(REPEATABLE_STRING_FLAG_NAMES, [
    "image",
    "remove-image",
    "reviewer",
    "remove-reviewer",
  ]);
  assert.equal(FLAG_DEFINITIONS.image.kind, "repeatableString");
  assert.ok(COMMAND_REGISTRY["pr.create"].flags.includes("image"));
  assert.ok(COMMAND_REGISTRY["pr.create"].flags.includes("reviewer"));
  assert.ok(!COMMAND_REGISTRY["pr.create"].flags.includes("remove-image"));
  assert.ok(COMMAND_REGISTRY["pr.edit"].flags.includes("remove-image"));
  assert.ok(COMMAND_REGISTRY["pr.edit"].flags.includes("remove-reviewer"));
});

test("batch schemas contain only registered fields and identify their command", () => {
  for (const command of BATCH_COMMANDS) {
    const fields = getBatchFields(command);
    assert.equal(fields[0], "command");
    assert.equal(new Set(fields).size, fields.length, `${command} contains duplicate batch fields`);
    for (const field of fields) {
      assert.ok(
        Object.hasOwn(BATCH_FIELD_DEFINITIONS, field),
        `${command} references unknown batch field ${field}`,
      );
    }
  }
});

test("help is generated from every registered command and batch schema", () => {
  const help = formatHelp();
  for (const id of COMMAND_IDS) {
    const definition = COMMAND_REGISTRY[id];
    assert.ok(help.includes(`pr.sh ${definition.usage}`));
    assert.ok(help.includes(definition.summary));
  }
  for (const command of BATCH_COMMANDS) {
    assert.ok(help.includes(`\"command\":\"${command}\"`));
  }

  const optionWidth = Math.max(
    ...Object.values(FLAG_DEFINITIONS).map((definition) => definition.usage.length),
  ) + 2;
  for (const definition of Object.values(FLAG_DEFINITIONS)) {
    assert.ok(
      help.split("\n").includes(
        `  ${definition.usage.padEnd(optionWidth)}${definition.description}`,
      ),
      `help does not clearly separate ${definition.usage} from its description`,
    );
  }

  assert.match(
    help,
    /Identity \(Read\), also named vso\.identity, only for --reviewer additions on pr create\/edit\./,
  );
  assert.match(
    help,
    /--remove-reviewer resolves current PR reviewers and needs only Code \(Read & Write\)\./,
  );
  assert.match(help, /requested build, whether it is current or\s+historical/);
  assert.match(help, /--pr only selects or resolves the associated pull request/);
  assert.match(help, /default 60 seconds/);
  assert.match(help, /10–3600 seconds/);
  assert.match(help, /10–86400 seconds/);
});
