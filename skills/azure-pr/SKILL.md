---
name: azure-pr
description: "Manage Azure DevOps pull requests and review comments with pr.sh: create and inspect PRs; read and update PR descriptions; mark PRs as drafts; list PR comment threads and inspect review feedback; post, reply to, edit, delete, and resolve comments; and run batch operations. Use whenever the user asks to open or inspect an Azure DevOps PR, read or update its description, set it to draft, list or review PR comments, respond to PR feedback, or post code-review findings."
---

# Azure DevOps PR tooling

Use `pr.sh` (can be found in one of projects in the "~/coding" folder) for Azure DevOps pull-request and review-comment operations. Run it from the root of the target Azure Repos checkout so it can discover the repository, current branch, and active pull request.

Treat the tool's current CLI help as the source of truth for actions, options, validation, authentication, batch schemas, and output. Do not duplicate that reference in this skill. Use `pr.sh --help`; if authentication is not configured yet, run the adjacent `pr.ts` entrypoint with `--help` instead.

Try to combine as many requests as possible with `pr.sh comment batch` to avoid frequent authentication calls (for example, when the user is using the 1Password integration). Batch input uses qualified `command` values such as `comment.create`, `comment.reply`, and `comment.edit`; consult `--help` for the current schema.

## Disclose AI authorship

Every PR comment whose content is written or rewritten by an agent must disclose the AI authorship and the actual model used. This applies to:

- New threads created with `pr.sh comment create`.
- Replies created with `pr.sh comment reply`.
- Comment content replaced with `pr.sh comment edit`.
- Every `pr.sh comment batch` operation containing a `message` (`comment.create`, `comment.reply`, or `comment.edit`).

Append the disclosure on its own lines after the comment content:

```text
---
🤖 Written by an AI agent (<actual model name>).
```

Replace `<actual model name>` with the model currently running. When editing a comment, ensure the resulting content contains one current disclosure rather than dropping it or adding duplicates. Never post or edit agent-authored comment text without the disclosure.

Operations that do not write comment content, such as `pr.sh comment delete`, `pr.sh comment resolve`, `comment.delete`, and `comment.resolve`, do not require a disclosure.
