# ado-pr

A TypeScript CLI for developers' coding agents to manage Azure DevOps pull requests,
comments and review threads, and PR build pipelines. Node >= 22.6 strips the types;
there is no build step.

Run `./pr.sh --help` from an Azure Repos checkout. Export `AZURE_DEVOPS_PAT` or copy
`.env.tpl` to `.env` beside `pr.sh`. The launcher accepts a literal PAT or resolves
an `op://` reference with the 1Password CLI. For help without authentication, run
`node --experimental-strip-types src/pr.ts --help`.

## Architecture documentation

Start with [the architecture document](docs/architecture.md) for module ownership,
dependency rules, runtime flow and tests. Update it in the same change when
components, dependencies or ownership change. The [ADR index](docs/adr/README.md)
records decisions and explains when to add or supersede a record.

## Development

Keep the project small and simple. Split by feature where it doesn't complicate
things. Handle realistic failure modes only; avoid speculative edge-case and
race-condition hardening.

Use pnpm. Run `pnpm check` before committing. It covers typecheck, lint, formatting,
tests and all Fallow gates with fresh V8 coverage. Mutation testing is optional locally:
`pnpm mutation` checks changed code against `origin/main`, configurable through
`MUTATION_BASE`; `pnpm mutation:all` reports the full score.

## GitHub issues

Follow the [GitHub issue guide](docs/github-issues.md) when creating or updating an
issue. Apply the `unslop` skill to the title and body before publishing.

## Pull request descriptions

Follow the [pull request description guide](docs/pull-request-descriptions.md)
when creating or updating a PR description. Apply the `unslop` skill before
publishing it.

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
