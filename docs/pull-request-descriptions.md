# Pull request descriptions

Write for a reviewer who has not read the conversation or issue history. Apply the `unslop` skill when writing or editing a PR description. Use plain English, concrete behavior, and links that help the reviewer check your claims. Keep the description current as the scope changes.

Use the sections below, with the opening description first. Scale the detail to the change. A documentation fix may need only a sentence per section; a CLI contract change needs enough detail to assess compatibility and rollout. Replace examples with facts about the PR.

## Opening description

Start with a short paragraph explaining the problem, what motivated the change, and the resulting behavior. Name the user action or failure that prompted the work when relevant. Link the originating issue if there is one, but include enough context to understand the PR without opening it.

For example, explain that build progress could appear in stdout alongside the final JSON result, and that the change sends progress to stderr so agents can parse stdout. Avoid opening with a list of files or a chronology of implementation work.

## Visual summary

Follow the opening description with a visual when it shows the change faster than prose: pseudocode, a call tree, a component or file tree, a Mermaid diagram, or a `diff` sketch of one of these. Pick the smallest view that makes the key point clear. Skip this section when a sentence says enough, such as for a documentation fix.

Read the [pull request visuals guide](pull-request-visuals.md) for an example of each type and when to use it.

## Architecture impact

Use the module names in the [architecture document](architecture.md). Include a table with one row for each affected module. Describe changes to its responsibilities, dependencies, contracts, or communication with other components. Include affected command rules, such as PR/build association or comment anchoring, where relevant.

The following rows illustrate a hypothetical build output change.

| Module | What changed | Effect on callers or boundaries |
| --- | --- | --- |
| `src/builds/` | Added a field to the build wait result. | Callers receive the expanded result contract. |
| `src/pr.ts` | Includes that field in `--json` output. | Agents can read it from the final stdout result. |

If no module changes, keep the table and use a single row stating that, with the actual scope, such as documentation or tooling. Link any updated architecture documentation or ADRs. Do not claim an ownership or dependency change when the PR only updates behavior inside an existing boundary.

## Important decisions

Explain choices that a reviewer could reasonably question. State the chosen approach, the constraint it addresses, and the tradeoff. Mention a rejected alternative only when it explains the decision. Link relevant ADRs rather than repeating them. If the PR introduces no such decisions, say so briefly.

## After merge

State the actions needed after merging, who should perform them, and their order when it matters. Include CLI updates, configuration changes, credential scope changes, or follow-up work that the PR requires.

For a CLI contract change, spell out which agent scripts or skill instructions need updating and whether update order matters. For example, if a command is renamed, explain whether callers must update alongside the CLI or whether the old name still works. State any runtime, migration, or rollback constraints. If merging requires no further action, write "No post-merge action required."

## Risk

Choose `small`, `medium`, or `high` and explain the rating in terms of what could fail and who would be affected. Diff size alone does not determine risk.

- `small` fits a contained change with limited consequences and a straightforward revert, such as a documentation correction.
- `medium` fits a behavior change that can affect an agent workflow or several components but has a practical recovery path.
- `high` fits a change that could lose data, break agent scripts, or require a coordinated rollout or difficult rollback.

Name the main failure case, the validation that reduces the risk, and any remaining uncertainty. Explain recovery steps when reverting the commit alone would not restore service or data.

## Evidence

Show concrete before and after evidence that the change works.

Show execution output: the test that failed before the change and passes after it, or the command output before and after, such as the `--json` result or the stderr progress lines. Pseudocode is fine when the full test is long.

For a change with no observable behavior, such as documentation or a refactor, say so and point to the validation below.

## Validation and CI

List the CI jobs or steps executed for the current PR revision and their results, including the Node test matrix, lint, Fallow and mutation jobs where applicable. Link the CI runs so reviewers can inspect failures or warnings. Report local checks separately, with the commands and results, so reviewers can tell which checks CI has confirmed. Run `pnpm check` before committing; report `pnpm mutation` separately if run.

For each skipped step, name it and explain why it is unnecessary for this PR's scope. For example, mutation checks can be skipped for a documentation-only change because it cannot affect production behavior, tests, or build inputs. If a required check could not run because of a missing tool, platform, or another blocker, state that limitation and what remains unverified. Mark pending checks as pending and update the description when they finish.

## Review focus

Direct the reviewer to the parts that need judgment. Link the relevant files, tests, or ADRs and explain what to verify, such as PR/build association, cancellation, JSON output compatibility, or file comment anchors. Mention test gaps and assumptions that need confirmation.

Keep this specific to the PR. "Check that build wait progress stays on stderr when `--json` is set" gives the reviewer a useful question; "review the code carefully" does not.
