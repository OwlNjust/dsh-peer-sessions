#!/usr/bin/env bash
# Pre-push privacy scan: is anything IDENTIFYING about this machine present in
# what a push would publish?
#
# HEAD is only half the question. A push publishes HISTORY, so every commit is
# scanned as well — a marker that was edited away in a later commit still
# fails here, and that is the failure mode this script exists for (a real
# conversation title survived in this repository for four releases that way).
#
# THE MARKERS ARE NOT IN THIS FILE. A list of your own usernames, paths, private
# IPs and session titles is exactly the thing that must never be committed, so it
# lives in an ignored file on your machine:
#
#   printf '%s\n' 'REPLACE_WITH_YOUR_USERNAME' 'REPLACE_WITH_YOUR_HOME' \
#     'REPLACE_WITH_A_REAL_SESSION_TITLE' > PRIVACY-PATTERNS.txt   # already ignored
#   ./scripts/privacy-scan.sh
#
# Marker sources, all applied together: $PRIVACY_PATTERNS (newline-separated),
# $PRIVACY_PATTERN_FILE, then ./PRIVACY-PATTERNS.txt. Each line is an ERE; blank
# lines and #comments are ignored. With no personal markers the scan still covers
# a GENERIC set (private IP ranges, home/mount paths, credential shapes) and says
# which set it used, so "it passed" is never mistaken for "it checked everything".
#
# Exit codes: 0 clean, 1 findings, 2 usage problem.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

patterns=()
add_pattern() {
  local line="$1"
  [ -z "$line" ] && return 0
  case "$line" in \#*) return 0 ;; esac
  patterns+=("$line")
}

if [ -n "${PRIVACY_PATTERNS:-}" ]; then
  while IFS= read -r line; do add_pattern "$line"; done <<< "${PRIVACY_PATTERNS}"
fi

pattern_file="${PRIVACY_PATTERN_FILE:-PRIVACY-PATTERNS.txt}"
personal=0
if [ -f "${pattern_file}" ]; then
  while IFS= read -r line; do [ -n "$line" ] && case "$line" in \#*) ;; *) personal=$((personal + 1)) ;; esac; done < "${pattern_file}"
  while IFS= read -r line; do add_pattern "$line"; done < "${pattern_file}"
fi

# Generic shapes that are suspicious on any machine. Kept deliberately narrow:
# a false positive here would teach the next maintainer to ignore the scan.
#
# The home/mount rule is spelled to be SELF-SAFE (`[\/]` rather than a bare `/`):
# the literal text of this file must not match the rules this file applies —
# learned the hard way, when the first version reported itself.
generic_patterns=(
  '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)'
  '[\/](home|Users|mnt)[\/][A-Za-z0-9._-]+'
  'session-[0-9a-f]{8}-[0-9a-f]{4}'
  'sk-[A-Za-z0-9]{16,}'
)
patterns+=("${generic_patterns[@]}")

grep_args=()
for p in "${patterns[@]}"; do grep_args+=(-e "$p"); done

scan_target_oneline() {
  local label="$1"; local quiet="$2"; shift 2
  local hits
  hits="$(git grep -h -I -n -E "${grep_args[@]}" "$@" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "${hits}" | sed "s|^|  ${label}  |"
    return 1
  fi
  [ "${quiet}" = loud ] && echo "  clean"
  return 0
}

findings=0
echo "== privacy scan =="
echo "markers: ${#patterns[@]} (env $(( ${#patterns[@]} - personal - ${#generic_patterns[@]} )), ${pattern_file} ${personal}, generic ${#generic_patterns[@]})"
if [ "${personal}" -eq 0 ]; then
  echo "NOTE: no personal marker file — only the generic shapes were checked."
  echo "      Add your own names/paths/titles to ${pattern_file} (gitignored)."
fi
echo

# 1. Everything currently tracked (what a fresh clone checks out at the tip).
echo "[1/3] tracked files at HEAD"
if ! scan_target_oneline 'HEAD' loud -- .; then findings=$((findings + 1)); fi

# 2. Every commit's content — the part a new commit cannot fix.
echo "[2/3] every commit's content"
history_hits=0
while IFS= read -r commit; do
  if ! scan_target_oneline "${commit:0:7}" quiet "${commit}" -- .; then history_hits=$((history_hits + 1)); fi
done < <(git rev-list --all)
if [ "${history_hits}" -gt 0 ]; then findings=$((findings + 1)); else echo "  clean"; fi

# 3. Commit messages and authorship.
echo "[3/3] commit messages and identities"
meta="$(git log --all --format='%h %an <%ae> %s%n%b' | grep -I -E "${grep_args[@]}" 2>/dev/null || true)"
if [ -n "${meta}" ]; then
  printf '%s\n' "${meta}" | sed 's|^|  log  |'
  findings=$((findings + 1))
else
  echo "  clean"
fi

echo
if [ "${findings}" -gt 0 ]; then
  echo "== FAIL: ${findings} section(s) have findings =="
  echo "A marker in a commit's CONTENT cannot be fixed by a new commit."
  echo "Either rewrite history (and say so in the release notes), or accept it"
  echo "and keep HEAD clean — see MAINTENANCE.md §九."
  exit 1
fi
echo "== PASS: nothing matching the markers was found =="
