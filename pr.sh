#!/usr/bin/env bash
# Creates Azure DevOps pull requests, and lists/creates/replies-to/resolves PR comment threads,
# for the pull request associated with the current branch of a scada-ui checkout (see pr.ts for
# the actions/options). This tool is fully self-contained (its own package.json/node_modules live
# alongside this script), so it works against any scada-ui checkout/worktree without needing
# anything installed or copied there - just cd into the target worktree and run this.
#
# Requires:
#   - Node.js >= 22.6 (native TypeScript support). No ts-node/build step needed.
#   - The 1Password CLI (`op`), signed in/unlocked, to resolve the AZURE_DEVOPS_PAT reference in
#     .env.tpl without ever writing the token to disk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v op >/dev/null 2>&1; then
  echo "Error: the 1Password CLI ('op') is required but was not found on PATH. Install it and run 'op signin' first." >&2
  exit 1
fi

if [ ! -f "angular.json" ]; then
  echo "Error: pr.sh must be run from the root of a scada-ui checkout (no angular.json found in $(pwd))." >&2
  exit 1
fi

exec op run --env-file="${SCRIPT_DIR}/.env.tpl" -- node "${SCRIPT_DIR}/pr.ts" "$@"
