#!/usr/bin/env bash
# Point this package's node_modules at a DeepSeek Harness deployment.
#
# WHY this exists: the plugin imports @deepseek-ai/dsh-llm and
# @deepseek-ai/dsh-tools. Node resolves a bare specifier from the importing
# file's REAL path, and a `link:` install leaves this package outside the
# profile tree — so without this link those imports do not resolve, and neither
# does `npm test`.
#
# WHY a link and not a dependency: it keeps the plugin on the SAME module
# instances the running harness already loaded. Installing a second copy from
# npm would split identity between plugin and host — the code would load, and
# then compare types against a different copy of the package that defines them.
#
# Usage:   npm run link        (or: bash scripts/link-deps.sh)
# Override the deployment root with DSH_HOME.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEPLOY_NODE_MODULES="${DSH_HOME}/profiles/node_modules"

if [ ! -d "${DEPLOY_NODE_MODULES}" ]; then
  printf 'error: no DeepSeek Harness deployment at %s\n' "${DEPLOY_NODE_MODULES}" >&2
  printf '       Set DSH_HOME to the config root of an installed harness.\n' >&2
  exit 1
fi

if [ -e "${REPO_DIR}/node_modules" ] && [ ! -L "${REPO_DIR}/node_modules" ]; then
  printf 'error: %s/node_modules exists and is not a symlink.\n' "${REPO_DIR}" >&2
  printf '       Remove it first if it is a leftover dependency directory.\n' >&2
  exit 1
fi

ln -sfn "${DEPLOY_NODE_MODULES}" "${REPO_DIR}/node_modules"
printf 'linked  %s/node_modules\n     -> %s\n' "${REPO_DIR}" "${DEPLOY_NODE_MODULES}"
