# ado-pr

A TypeScript CLI for developers' coding agents to manage Azure DevOps pull requests,
comments and review threads, and PR build pipelines. Node >= 22.6 strips the types;
there is no build step.

Run `./pr.sh --help` from an Azure Repos checkout. Export `AZURE_DEVOPS_PAT` or copy
`.env.tpl` to `.env` beside `pr.sh`. The launcher accepts a literal PAT or resolves
an `op://` reference with the 1Password CLI. For help without authentication, run
`node --experimental-strip-types src/pr.ts --help`.

## Layout

- `src/shared/`: Azure HTTP, Git context, shared command contracts and types.
- `src/pull-requests/`: PRs, attachments and reviewers.
- `src/comments/`: threads, file anchors and batch operations.
- `src/builds/`: PR validation pipelines and build diagnostics.
- `src/cli/`: argument parsing, help and CLI option types.
- `src/pr.ts`: entrypoint that wires services together.
- Tests live beside each feature as `.test.mjs`. Shared helpers, fixtures and
  launcher tests live in `tests/`.

Features import shared code. Builds may also import pull requests. Only the CLI
and entrypoint wire features together. Features must never import the CLI, and
shared code must never import a feature.

## Development

Keep the project small and simple. Split by feature where it doesn't complicate
things. Handle realistic failure modes only; avoid speculative edge-case and
race-condition hardening.

Use pnpm. Run `pnpm check` before committing. It covers typecheck, lint, formatting,
tests and all Fallow gates with fresh V8 coverage. The temporary health baseline
tracks functions for PR 2 to refactor. Mutation testing is optional locally:
`pnpm mutation` checks changed code against `origin/main`, configurable through
`MUTATION_BASE`; `pnpm mutation:all` reports the full score.

## Commits

- Use Conventional Commits: `<type>(<scope>): <description>`, e.g. `feat(NxSelect): ...`.
  Valid types: `feat`, `fix`, `refactor`, `chore`, `build`, `docs`, `perf`, `test`,
  `style`, `ci`, `revert`.
- Include the affected component or module name as the scope, in PascalCase.
- For e2e changes, prefix the component/module scope with `e2e-`, e.g.
  `feat(e2e-NxSelect): ...`.
- Unless instructed otherwise, commit changes in meaningful implementation chunks.
- Never mix files from different components or modules in one commit. Each commit
  must have a single component/module scope. Split changes across modules into
  separate commits. Repository moves and codebase formatting may each use one commit.
- End every commit message with `Co-authored-by: Codex <noreply@openai.com>`, exactly
  once. Keep existing trailers and follow any task-specific author instructions.
