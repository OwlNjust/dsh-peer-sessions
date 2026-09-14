#!/usr/bin/env bash
# Undo what install.sh did. The plugin checkout itself is left alone, so a
# re-install needs no re-download.
#
# Environment overrides:
#   DSH_PROFILE   profile to uninstall from       (default: web)
#   DSH_HOME      harness config root             (default: ~/.dsh)

set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
PATCH_FILE="${PROFILE_DIR}/cordis.patch.yml"
DEPLOY_NODE_MODULES="${DSH_HOME}/profiles/node_modules"
ROW_ID="dsh-peer-sessions"
SKILL_DST="${DSH_HOME}/skills/peer-session"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

say "== dsh-peer-sessions uninstaller =="

# --------------------------------------------------------------- 1. skill
if [ -d "${SKILL_DST}" ]; then
  rm -rf "${SKILL_DST}"
  say "[1/4] removed skill ${SKILL_DST}"
else
  say "[1/4] skill not present — nothing to do"
fi

# ---------------------------------------------------------- 2. patch layer
if [ -f "${PATCH_FILE}" ] && grep -q "${ROW_ID}" "${PATCH_FILE}"; then
  BACKUP="${PATCH_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "${PATCH_FILE}" "${BACKUP}"
  python3 - "${PATCH_FILE}" "${ROW_ID}" <<'PY'
import sys, re
path, row = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
out, i = [], 0
while i < len(lines):
    line = lines[i]
    # Our own comment line.
    if row in line and line.lstrip().startswith('#'):
        i += 1
        continue
    # A three-line `- insert:` block that names the row.
    if re.match(r'^\s*-\s*insert:\s*$', line):
        block, j = [line], i + 1
        while j < len(lines) and re.match(r'^\s{4,}\S', lines[j]):
            block.append(lines[j]); j += 1
        if any(row in b for b in block):
            i = j
            continue
        out.extend(block); i = j
        continue
    out.append(line); i += 1
open(path, 'w', encoding='utf-8').write(''.join(out))
PY
  say "[2/4] removed the insert row (backup: ${BACKUP})"
else
  say "[2/4] patch layer has no ${ROW_ID} row — nothing to do"
fi

# ------------------------------------------------------------- 3. profile
say "[3/4] profile dependency"
if command -v dsh >/dev/null 2>&1; then
  ( cd "${PROFILE_DIR}" && dsh plugin --profile "${PROFILE}" remove "${ROW_ID}" ) \
    || warn "the CLI could not remove it; delete \"${ROW_ID}\" from ${PROFILE_DIR}/package.json by hand"
else
  warn "the 'dsh' CLI is not on PATH; delete \"${ROW_ID}\" from ${PROFILE_DIR}/package.json by hand"
fi

# -------------------------------------------------- 4. module resolution link
NM="${REPO_DIR}/node_modules"
if [ -L "${NM}" ] && [ "$(readlink "${NM}")" = "${DEPLOY_NODE_MODULES}" ]; then
  rm -f "${NM}"
  say "[4/4] removed the node_modules link"
else
  say "[4/4] no node_modules link of ours to remove"
fi

say ""
say "== done =="
say "Restart the '${PROFILE}' profile."
