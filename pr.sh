#!/usr/bin/env bash
# Creates, lists, and edits Azure DevOps pull requests (including attachments and reviewers),
# manages PR comments, and waits for validation builds from a git checkout whose origin remote
# points at Azure Repos (see src/pr.ts for the actions/options). This tool is fully self-contained
# (its own package.json/node_modules live alongside this script), so it works against any such
# checkout/worktree without needing anything installed or copied there - just cd into the target
# worktree and run this.
#
# Requires:
#   - Node.js >= 22.6 (TypeScript stripping and --env-file support). No build step is needed.
#   - AZURE_DEVOPS_PAT either exported by the caller or set in a .env path alongside this script.
#     PR/comment mutations need Code (Read & Write). Build commands need Code (Read); build queries
#     also need Build (Read, vso.build), and retries additionally need Build execute
#     (vso.build_execute). Reviewer additions also need Identity (Read).
#     Reviewer removal resolves current PR reviewers and does not need Identity access. Build support
#     covers YAML/classic Build API validations only: no Releases, external checks, or individual
#     stage/job/task retries; diagnostics default to the final 200 log lines, while --full-logs is
#     explicit and potentially sensitive.
#     Regular files accept a literal PAT or an op:// reference resolved just-in-time by 1Password
#     CLI. The path may also be a 1Password Environment mount containing a literal PAT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ -n "${AZURE_DEVOPS_PAT:-}" ]]; then
  if [[ "${AZURE_DEVOPS_PAT}" == op://* ]]; then
    if ! command -v op >/dev/null 2>&1; then
      echo "Error: AZURE_DEVOPS_PAT is an op:// reference, but the 1Password CLI ('op') was not found on PATH." >&2
      exit 1
    fi
    exec op run -- node --disable-warning=ExperimentalWarning --experimental-strip-types "${SCRIPT_DIR}/src/pr.ts" "$@"
  fi
  exec node --disable-warning=ExperimentalWarning --experimental-strip-types "${SCRIPT_DIR}/src/pr.ts" "$@"
fi

# An explicitly empty inherited value must not override a value loaded from .env.
unset AZURE_DEVOPS_PAT

if [[ ! -e "${ENV_FILE}" ]]; then
  echo "Error: AZURE_DEVOPS_PAT is not set and ${ENV_FILE} was not found. Export AZURE_DEVOPS_PAT, or copy ${SCRIPT_DIR}/.env.tpl to ${ENV_FILE}." >&2
  exit 1
fi

# 1Password Environment mounts are named pipes that provide literal values on demand. Read a
# mounted dotenv file only once: probing it first would consume one delivery before Node starts.
if [[ -p "${ENV_FILE}" ]]; then
  exec node --disable-warning=ExperimentalWarning --experimental-strip-types --env-file="${ENV_FILE}" "${SCRIPT_DIR}/src/pr.ts" "$@"
fi

# Probe a regular dotenv file without printing the PAT. Only op:// references require 1Password;
# literal values use Node's native dotenv loader even when `op` happens to be installed.
if node --env-file="${ENV_FILE}" -e 'process.exit(process.env.AZURE_DEVOPS_PAT?.startsWith("op://") ? 0 : 1)'; then
  if ! command -v op >/dev/null 2>&1; then
    echo "Error: AZURE_DEVOPS_PAT in ${ENV_FILE} is an op:// reference, but the 1Password CLI ('op') was not found on PATH." >&2
    exit 1
  fi
  exec op run --env-file="${ENV_FILE}" -- node --disable-warning=ExperimentalWarning --experimental-strip-types "${SCRIPT_DIR}/src/pr.ts" "$@"
fi

exec node --disable-warning=ExperimentalWarning --experimental-strip-types --env-file="${ENV_FILE}" "${SCRIPT_DIR}/src/pr.ts" "$@"
