## Commits

- Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`, e.g. `feat(NxSelect): ...`. Valid types: `feat`, `fix`, `refactor`, `chore`, `build`, `docs`, `perf`, `test`, `style`, `ci`, `revert`.
- Commit messages must include the affected component or module name as the scope, e.g. `feat(NxSelect): ...`
- For e2e related changes the component/module name should be prefixed with "e2e" e.g. `feat(e2e-NxSelect): ...`
- If not said otherwise commit the changes while implementing the feature into meaningfull chunks
- Never mix files belonging to different components or modules in a single commit; each commit should be scoped to one component/module so the commit message can follow conventional commits with a single scope
- If a change spans multiple components or modules, split it into separate commits, one per affected component/module
