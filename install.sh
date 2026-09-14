#!/usr/bin/env bash
# dsh-peer-sessions installer for a DeepSeek Harness profile.
#
# Idempotent: re-run it safely after editing the skill or pulling new code.
#
# Two things here are deliberate and easy to "fix" wrongly:
#
#   * The plugin's node_modules is a symlink to the profile's, because Node
#     resolves a bare specifier from the importing file's REAL path. A `link:`
#     install leaves this package outside the profile tree, so without the link
#     its `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` imports do not
#     resolve. Pointing at the profile also keeps it on the same module
#     instances the harness already loaded, so there is no second copy.
#
#   * The skill is COPIED, never symlinked. The skill provider lists each skill
#     root with lstat semantics (dsh-fs-local), so a symlinked directory is
#     classified as 'other' and the skill is never discovered.
#
# Environment overrides:
#   DSH_PROFILE   profile to install into            (default: web)
#   DSH_HOME      harness config root                (default: ~/.dsh)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
PATCH_FILE="${PROFILE_DIR}/cordis.patch.yml"
DEPLOY_NODE_MODULES="${DSH_HOME}/profiles/node_modules"
ROW_ID="dsh-peer-sessions"
SKILL_NAME="peer-session"
SKILL_SRC="${REPO_DIR}/skill/${SKILL_NAME}"
SKILL_DST="${DSH_HOME}/skills/${SKILL_NAME}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "== dsh-peer-sessions installer =="
say "repo:    ${REPO_DIR}"
say "profile: ${PROFILE}  (${PROFILE_DIR})"
say ""

# ---------------------------------------------------------------- 0. preflight
[ -f "${REPO_DIR}/lib/index.js" ] \
  || fail "lib/index.js is missing — this package is still a skeleton. Refusing to wire a plugin that does not exist."

[ -d "${PROFILE_DIR}" ] \
  || fail "profile directory not found: ${PROFILE_DIR} (set DSH_PROFILE to the profile you actually use)"

[ -f "${PATCH_FILE}" ] \
  || fail "patch layer not found: ${PATCH_FILE}"

[ -d "${DEPLOY_NODE_MODULES}" ] \
  || fail "deployment packages not found: ${DEPLOY_NODE_MODULES}"

# ------------------------------------------------ 1. module resolution link
# One implementation, in scripts/, because this is the step a newcomer gets
# stuck on and it must not exist in two slightly different forms.
say "[1/4] module resolution  (${REPO_DIR}/node_modules)"
bash "${REPO_DIR}/scripts/link-deps.sh"
say ""

# --------------------------------------------------- 2. profile dependency
say "[2/4] profile dependency"
if command -v dsh >/dev/null 2>&1; then
  # link: keeps the checkout live, so edits need no reinstall.
  ( cd "${PROFILE_DIR}" && dsh plugin --profile "${PROFILE}" add "link:${REPO_DIR}" )
  say "      added link:${REPO_DIR}"
else
  warn "the 'dsh' CLI is not on PATH; add the dependency by hand:"
  warn "  cd ${PROFILE_DIR}"
  warn "  dsh plugin --profile ${PROFILE} add link:${REPO_DIR}"
  warn "or add this to ${PROFILE_DIR}/package.json under \"dependencies\":"
  warn "  \"${ROW_ID}\": \"link:${REPO_DIR}\""
  DEP_MANUAL=1
fi
say ""

# ------------------------------------------------------- 3. patch layer row
say "[3/4] patch layer row  (${PATCH_FILE})"
if grep -q "${ROW_ID}" "${PATCH_FILE}"; then
  say "      already present — leaving it alone"
else
  BACKUP="${PATCH_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "${PATCH_FILE}" "${BACKUP}"
  say "      backed up to ${BACKUP}"
  {
    printf '\n# dsh-peer-sessions: peer channels between conversations at the same level.\n'
    printf -- '- insert:\n'
    printf '    - id: %s\n' "${ROW_ID}"
    printf '      name: %s\n' "${ROW_ID}"
  } >> "${PATCH_FILE}"
  say "      appended the insert row"
  say "      rollback: cp '${BACKUP}' '${PATCH_FILE}'"
fi
say ""

# --------------------------------------------------------------- 4. skill
say "[4/4] skill  (${SKILL_DST})"
[ -d "${SKILL_SRC}" ] || fail "skill source not found: ${SKILL_SRC}"
mkdir -p "${DSH_HOME}/skills"
# Replace the whole directory so removed files do not linger in the deployed copy.
rm -rf "${SKILL_DST}"
cp -R "${SKILL_SRC}" "${SKILL_DST}"
say "      copied (not symlinked — the provider uses lstat semantics)"
say ""

say "== done =="
say "Restart the '${PROFILE}' profile for the host plugin to load."
say "Verify afterwards with:  /peers"
if [ "${DEP_MANUAL:-0}" = "1" ]; then
  fail "the profile dependency still has to be added by hand (see the warning above), then restart '${PROFILE}'."
fi
