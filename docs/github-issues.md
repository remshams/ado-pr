# GitHub issues

Follow this guide when creating or updating a GitHub issue for ado-pr. Apply the `unslop` skill to the title and body before publishing.

## Opening summary

Start every issue body with a short paragraph summarizing the problem or requested feature. State what goes wrong or what the user should be able to do. Keep the title short and specific too.

For example, "Build wait progress appears in stdout alongside the JSON result. Send progress to stderr so agents can parse the final result without filtering status messages."

Add supporting details after the summary as needed. For a bug, include reproduction steps, actual behavior, and expected behavior. For a feature, describe the intended behavior and how to verify it. Distinguish confirmed facts from assumptions.

## Labels

Assign at least one relevant GitHub label to every issue. Check the repository's existing labels and select those that match the work, such as a bug, feature, or documentation label if available. Apply labels through GitHub's issue metadata; mentioning them in the body does not assign them.

## Affected modules

Include an "Affected modules" section. Use the module names in the [architecture document](architecture.md) and list each affected module when you can identify it. Briefly explain its connection to the issue. Include affected command rules where relevant.

For example, a build wait output issue might list `src/pr.ts` for stdout/stderr routing and `src/builds/` for progress events and formatting. Check the code before treating either as a confirmed cause.

If the impact is uncertain, say "Unknown" and describe what needs investigation. If no module is affected, say "None" and state the scope, such as documentation. Do not invent an architectural impact to fill the section.

## Before publishing

- Confirm that the body starts with a concise problem or feature summary.
- Assign at least one relevant repository label.
- List affected modules, or explain why they are unknown or none apply.
- Apply the `unslop` skill to the title and body, removing filler and keeping concrete details.
