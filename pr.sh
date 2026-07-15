#!/usr/bin/env bash
# Creates Azure DevOps pull requests, and lists/creates/replies-to/resolves PR comment threads,
# for the pull request associated with the current branch of a git checkout whose origin remote
# points at Azure Repos (see pr.ts for the actions/options). This tool is fully self-contained
# (its own package.json/node_modules live alongside this script), so it works against any such
# checkout/worktree without needing anything installed or copied there - just cd into the target
# worktree and run this.
#
# Requires:
#   - Node.js >= 22.6 (native TypeScript support). No ts-node/build step needed.
#   - A .env file alongside this script (gitignored, personal to you - copy .env.tpl to .env and
#     fill in your own AZURE_DEVOPS_PAT).
#   - The 1Password CLI (`op`), signed in/unlocked, is used to load .env if it's installed - this
#     is what lets AZURE_DEVOPS_PAT be an op:// reference, resolved just-in-time and never written
#     to disk. If `op` isn't installed, .env is loaded directly instead, which only works if
#     AZURE_DEVOPS_PAT is a literal secret (not an op:// reference).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found. Copy ${SCRIPT_DIR}/.env.tpl to ${ENV_FILE} and fill in your own AZURE_DEVOPS_PAT." >&2
  exit 1
fi

if command -v op >/dev/null 2>&1; then
  exec op run --env-file="${ENV_FILE}" -- node "${SCRIPT_DIR}/pr.ts" "$@"
fi

# No 1Password CLI available: load .env directly instead.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ "${AZURE_DEVOPS_PAT:-}" == op://* ]]; then
  echo "Error: AZURE_DEVOPS_PAT in ${ENV_FILE} is an op:// reference, but the 1Password CLI ('op') was not found on PATH. Install it (https://developer.1password.com/docs/cli/get-started/) and run 'op signin', or replace it with a literal secret in ${ENV_FILE}." >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/pr.ts" "$@"
