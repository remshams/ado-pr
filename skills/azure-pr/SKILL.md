---
name: azure-pr
description: "Manage Azure DevOps pull requests, review comments, and Azure Pipelines validation builds with pr.sh: inspect/retry builds, list/create/inspect PRs, update descriptions/images/reviewers/draft state, inspect feedback, post/reply/edit/delete/resolve/reopen comments, and run batch operations. Use whenever the user asks to manage an Azure DevOps pull request, review feedback, or PR validation build."
---

# Azure DevOps PR tooling

Use `pr.sh` from PATH for Azure DevOps pull-request, review-comment, and PR validation-build operations. If `command -v pr.sh` fails, report the install step: `mkdir -p ~/.local/bin && ln -s <checkout>/pr.sh ~/.local/bin/pr.sh`, with `~/.local/bin` on PATH. Run it from the root of the target Azure Repos checkout so it can discover the repository, current branch, and active pull request. Use `pr.sh pr list` to list active pull requests created by the authenticated PAT owner in that repository; add `--json` for raw data. For build inspection/retry/wait use the resource-first `pr.sh build ...` commands; CLI help is the source of truth for their routes, flags, validation, and output. Do not duplicate complete help here. `build show` and `build wait` require either `--build <id>` or `--latest`. The latter selects the newest build validating the PR head across PR merge and source-branch runs. If none validates it, show prints the newest associated build marked stale and exits 1; wait fails naming the head. `pr.sh build wait --build <id>` monitors metadata only for a current or historical associated build; `--pr` only selects or resolves its pull request. After bounded PR resolution, it polls every 60 seconds for up to 1 hour by default (`--interval` is 10–3600 seconds; `--timeout` is 10–86400 seconds). Progress and five-minute heartbeats go to stderr. Completed/timed-out waits emit one final human or pretty JSON result to stdout; errors and signals emit none. JSON retains raw Azure build metadata, so inspect it before persistence. Success exits 0, timeout 124, other outcomes/errors 1, SIGINT 130, and SIGTERM 143. Transient poll requests retry, but the third consecutive failure aborts. Waiting never retries/requeues the build, mutates it, or fetches logs—use `build show` afterward for diagnostics.

Treat the tool's current CLI help as the source of truth for actions, options, validation, authentication, batch schemas, and output. Do not duplicate that reference in this skill. Use `pr.sh --help`; if authentication is not configured yet, run the `src/pr.ts` entrypoint with `--help` instead.

PR descriptions are limited to 4,000 characters, including generated image Markdown. Image uploads use a bidirectional description-placeholder contract: every supplied image needs a matching `{{image:<basename>}}`, and every such placeholder needs a corresponding `--image`. For example, `--description 'Flow: {{image:flow.png}}' --image ./docs/flow.png` uploads the basename `flow.png` and replaces every matching placeholder with rendered image Markdown plus an invisible ado-pr ownership marker. Repeat `--image` and `--reviewer` for multiple values. Uploads reject case-sensitive collisions with existing attachment `displayName` values; replacement is not supported. On `pr edit`, `--remove-image flow.png` removes only exact generated Markdown-and-marker sequences before deleting that exact attachment. Keep the marker unchanged for automatic reference removal. If it is edited or removed, attachment deletion retains the custom reference, which may then be broken. `--remove-reviewer 'Ada Lovelace'` removes the uniquely resolved current reviewer. Quote reviewer display names containing spaces.

Image/reviewer edits can span multiple Azure requests. The tool validates everything it can before mutation and attempts to clean up safely identifiable attachments when an upload-stage failure occurs. A final description-update failure has an uncertain server outcome, so newly uploaded attachments are retained to avoid breaking a possibly applied description; this can leave an orphan attachment. Other later Azure failures can still leave a partially applied edit. Inspect the PR before retrying. The PAT needs Code (Read & Write) for PR/comment mutations. Build commands need Code (Read) for PR metadata; build queries additionally need Build (Read), also named `vso.build`, and build retries and queueing need Build (Read & execute), also named `vso.build_execute`. The policy evaluation requeue scope has not been verified with a real PAT. Build commands support YAML and classic Build API validations, not Releases, external status checks, or individual stage/job/task retries. Diagnostic output defaults to the final 200 log lines; `--full-logs` explicitly requests complete logs and must be treated as potentially sensitive. Only reviewer additions with `--reviewer` on `pr create` or `pr edit` additionally need Identity (Read), also named `vso.identity`; `--remove-reviewer` resolves current PR reviewers and needs only Code (Read & Write).

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

Replace `<actual model name>` with the exact provider and model identity currently executing the turn, obtained from runtime/session metadata. Never infer, guess, or copy the model name from an existing PR comment, an earlier agent message, the branch, or a default value; different comments may have been written by different models. If the runtime does not expose the exact model identity and it cannot be determined reliably, leave the model name out entirely and post only the rest of the disclosure:

```text
---
🤖 Written by an AI agent.
```

Do not ask the user for the model name and do not use an unverified one; the model name is optional, the AI-authorship disclosure is not. When editing a comment, ensure the resulting content contains one current disclosure rather than dropping it or adding duplicates. Never post or edit agent-authored comment text without the disclosure.

Operations that do not write comment content, such as `pr.sh comment delete`, `pr.sh comment resolve`, `pr.sh comment reopen`, `comment.delete`, and `comment.resolve`, do not require a disclosure.
