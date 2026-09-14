#!/usr/bin/env bash
# Undo what install.sh did. The plugin package itself is left alone, so a
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
ROW_ID="dsh-peer-sessions"
SKILL_DST="${DSH_HOME}/skills/peer-session"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

say "== dsh-peer-sessions uninstaller =="

# --------------------------------------------------------------- 1. skill
if [ -d "${SKILL_DST}" ]; then
  rm -rf "${SKILL_DST}"
  say "[1/3] removed skill ${SKILL_DST}"
else
  say "[1/3] skill not present — nothing to do"
fi

# ---------------------------------------------------------- 2. patch layer
if [ -f "${PATCH_FILE}" ] && grep -q "${ROW_ID}" "${PATCH_FILE}"; then
  BACKUP="${PATCH_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "${PATCH_FILE}" "${BACKUP}"
  python3 - "${PATCH_FILE}" "${ROW_ID}" <<'PY'
import sys, re
path, row = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
# Drop our comment line and the three-line insert block naming the row.
lines = text.splitlines(keepends=True)
out, i = [], 0
while i < len(lines):
    line = lines[i]
    if row in line and line.lstrip().startswith('#'):
        i += 1
        continue
    if re.match(r'^\s*-\s*insert:\s*$', line):
        block = [line]
        j = i + 1
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
  say "[2/3] removed the insert row (backup: ${BACKUP})"
else
  say "[2/3] patch layer has no ${ROW_ID} row — nothing to do"
fi

# ------------------------------------------------------------- 3. profile
say "[3/3] profile dependency"
if command -v dsh >/dev/null 2>&1; then
  ( cd "${PROFILE_DIR}" && dsh plugin --profile "${PROFILE}" remove "${ROW_ID}" ) \
    || warn "the CLI could not remove it; delete \"${ROW_ID}\" from ${PROFILE_DIR}/package.json by hand"
else
  warn "the 'dsh' CLI is not on PATH; delete \"${ROW_ID}\" from ${PROFILE_DIR}/package.json by hand"
fi

say ""
say "== done =="
say "Restart the '${PROFILE}' profile."
