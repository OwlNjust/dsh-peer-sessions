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
# WHICH deployment (this is the part that bit once): preferring
# `$DSH_HOME/profiles/node_modules` alone is not enough, because after a harness
# UPGRADE that directory can still hold the OLD version while the running host
# is a newer one — measured here as the plugin loading 0.1.5-rc.3 modules
# against a 0.1.7-rc.2 host. Identity was split exactly as the paragraph above
# warns, and nothing failed loudly; only comparing `readlink -f` revealed it.
# So the harness that `dsh` actually resolves to is preferred, and the profiles
# directory stays as the fallback for a layout with no discoverable `dsh`.
#
# Usage:   npm run link        (or: bash scripts/link-deps.sh)
# Override the deployment root with DSH_HOME, or the whole target with
# DSH_DEPLOY_NODE_MODULES.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
FALLBACK_NODE_MODULES="${DSH_HOME}/profiles/node_modules"

# Does this directory actually provide the harness packages the plugin imports?
usable() {
  [ -n "${1:-}" ] && [ -d "${1}/@deepseek-ai/dsh-tools" ] && [ -d "${1}/@deepseek-ai/dsh-llm" ]
}

# The node_modules of the harness `dsh` resolves to right now.
resolve_from_path() {
  command -v dsh >/dev/null 2>&1 || return 0
  local bin d
  bin="$(readlink -f "$(command -v dsh)" 2>/dev/null)" || return 0
  d="$(dirname "${bin}")"
  while [ "${d}" != "/" ]; do
    if usable "${d}/node_modules"; then
      printf '%s\n' "${d}/node_modules"
      return 0
    fi
    d="$(dirname "${d}")"
  done
}

DEPLOY_NODE_MODULES="${DSH_DEPLOY_NODE_MODULES:-}"
SOURCE="DSH_DEPLOY_NODE_MODULES"
if ! usable "${DEPLOY_NODE_MODULES}"; then
  DEPLOY_NODE_MODULES="$(resolve_from_path)"
  SOURCE="the harness 'dsh' resolves to"
fi
if ! usable "${DEPLOY_NODE_MODULES}"; then
  DEPLOY_NODE_MODULES="${FALLBACK_NODE_MODULES}"
  SOURCE="fallback: \$DSH_HOME/profiles/node_modules"
fi

if ! usable "${DEPLOY_NODE_MODULES}"; then
  printf 'error: no DeepSeek Harness deployment with @deepseek-ai/dsh-tools found\n' >&2
  printf '       tried the harness on PATH, then %s\n' "${FALLBACK_NODE_MODULES}" >&2
  printf '       Set DSH_DEPLOY_NODE_MODULES to the deployment node_modules.\n' >&2
  exit 1
fi

if [ -e "${REPO_DIR}/node_modules" ] && [ ! -L "${REPO_DIR}/node_modules" ]; then
  printf 'error: %s/node_modules exists and is not a symlink.\n' "${REPO_DIR}" >&2
  printf '       Remove it first if it is a leftover dependency directory.\n' >&2
  exit 1
fi

ln -sfn "${DEPLOY_NODE_MODULES}" "${REPO_DIR}/node_modules"
printf 'linked  %s/node_modules\n     -> %s\n' "${REPO_DIR}" "${DEPLOY_NODE_MODULES}"
printf '        (%s; dsh-llm %s)\n' "${SOURCE}" \
  "$(node -e "console.log(require('${DEPLOY_NODE_MODULES}/@deepseek-ai/dsh-llm/package.json').version)" 2>/dev/null || printf '?')"
