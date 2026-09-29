#!/usr/bin/env bash
# Pre-push privacy scan: is anything IDENTIFYING about this machine present in
# what a push would publish?
#
# HEAD is only half the question. A push publishes HISTORY, so every commit is
# scanned as well — a marker that was edited away in a later commit still fails
# here, and that is the failure mode this script exists for: an audit of this
# repository found a real conversation title that had survived four releases, and
# a real mount path + project name in 17 commits that predate the first tag (so
# scanning tags alone reported "clean").
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
# HITS THAT ARE KNOWN AND ACCEPTED go in $PRIVACY_ACCEPT_FILE (default
# ./PRIVACY-ACCEPTED.txt, gitignored). Those are still PRINTED, marked
# `[accepted]`, and do not fail the scan — a check that is always red is a check
# nobody reads, while a new leak must stay loud. Use it for something already
# public that you have deliberately decided not to rewrite history over.
#
# Note on coverage: `git grep` sees TRACKED files, so a brand-new file is only
# scanned once it is added — which matches what a push publishes. Untracked,
# unignored files are reported anyway, because `git add -A` is how they get in.
#
# Exit codes: 0 clean (accepted hits allowed), 1 unaccepted findings.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

patterns=()
add_pattern() {
  local line="$1"
  [ -z "$line" ] && return 0
  case "$line" in \#*) return 0 ;; esac
  patterns+=("$line")
}

read_pattern_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line; do add_pattern "$line"; done < <(grep -v -E '^[[:space:]]*(#|$)' "$file" || true)
}

if [ -n "${PRIVACY_PATTERNS:-}" ]; then
  while IFS= read -r line; do add_pattern "$line"; done <<< "${PRIVACY_PATTERNS}"
fi

pattern_file="${PRIVACY_PATTERN_FILE:-PRIVACY-PATTERNS.txt}"
personal=0
if [ -f "${pattern_file}" ]; then
  personal="$(grep -c -v -E '^[[:space:]]*(#|$)' "${pattern_file}" || true)"
  read_pattern_file "${pattern_file}"
fi

# Accepted-and-already-public markers: read into their own list, then folded into
# the search so they are still reported.
accepted_patterns=()
accept_file="${PRIVACY_ACCEPT_FILE:-PRIVACY-ACCEPTED.txt}"
if [ -f "${accept_file}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    accepted_patterns+=("$line")
    patterns+=("$line")
  done < <(grep -v -E '^[[:space:]]*(#|$)' "${accept_file}" || true)
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
accept_args=()
for p in "${accepted_patterns[@]}"; do accept_args+=(-e "$p"); done

accepted_total=0
declare -A accepted_by_pattern=()
is_accepted() {
  [ "${#accepted_patterns[@]}" -eq 0 ] && return 1
  printf '%s' "$1" | grep -q -E "${accept_args[@]}"
}
# Which accepted marker a line matched, so the summary names it.
accepted_pattern_of() {
  local p
  for p in "${accepted_patterns[@]}"; do
    printf '%s' "$1" | grep -q -E -e "$p" && { printf '%s' "$p"; return 0; }
  done
  printf 'unknown'
}

# Scan one revision. Prints each hit tagged, and returns 1 only when at least one
# hit is NOT on the accepted list.
scan_target() {
  local label="$1"; local quiet="$2"; shift 2
  local hits
  hits="$(git grep -h -I -n -E "${grep_args[@]}" "$@" 2>/dev/null || true)"
  if [ -z "${hits}" ]; then
    [ "${quiet}" = loud ] && echo "  clean"
    return 0
  fi
  local bad=0
  while IFS= read -r line; do
    if is_accepted "${line}"; then
      accepted_total=$((accepted_total + 1))
      local matched
      matched="$(accepted_pattern_of "${line}")"
      accepted_by_pattern["${matched}"]=$(( ${accepted_by_pattern["${matched}"]:-0} + 1 ))
      [ "${PRIVACY_VERBOSE:-0}" = 1 ] && printf '  [accepted] %s  %s\n' "${label}" "${line}"
    else
      printf '  [!] %s  %s\n' "${label}" "${line}"
      bad=1
    fi
  done <<< "${hits}"
  return "${bad}"
}

findings=0
echo "== privacy scan =="
echo "markers: ${#patterns[@]} (env/file ${personal}, accepted ${#accepted_patterns[@]}, generic ${#generic_patterns[@]})"
if [ "${personal}" -eq 0 ] && [ "${#accepted_patterns[@]}" -eq 0 ]; then
  echo "NOTE: no personal marker file — only the generic shapes were checked."
  echo "      Add your own names/paths/titles to ${pattern_file} (gitignored)."
fi
echo

# 1. Everything currently tracked (what a fresh clone checks out at the tip).
echo "[1/4] tracked files at HEAD"
if ! scan_target 'HEAD' loud -- .; then findings=$((findings + 1)); fi

# 2. Every commit's content — the part a new commit cannot fix.
echo "[2/4] every commit's content"
history_hits=0
while IFS= read -r commit; do
  if ! scan_target "${commit:0:7}" quiet "${commit}" -- .; then history_hits=$((history_hits + 1)); fi
done < <(git rev-list --all)
report_accepted() {
  [ "${accepted_total}" -eq 0 ] && return 0
  echo "  accepted, kept on purpose (${accept_file}):"
  local key
  for key in "${!accepted_by_pattern[@]}"; do
    printf '    %s  ×%s\n' "${key}" "${accepted_by_pattern[${key}]}"
  done
  [ "${PRIVACY_VERBOSE:-0}" = 1 ] || echo "    (set PRIVACY_VERBOSE=1 to see every line)"
}
if [ "${history_hits}" -gt 0 ]; then
  findings=$((findings + 1))
else
  echo "  clean"
  report_accepted
fi

# 3. Untracked files that are NOT ignored — they would enter on a `git add -A`.
echo "[3/4] untracked, unignored files"
untracked="$(git status --porcelain --untracked-files=all | grep -v '^!!' | sed '/^$/d' || true)"
if [ -n "${untracked}" ]; then
  printf '%s\n' "${untracked}" | sed 's|^|  pending  |'
  echo "  (each is scanned by [1/4] once it is tracked)"
else
  echo "  clean"
fi

# 4. Commit messages and authorship.
echo "[4/4] commit messages and identities"
meta="$(git log --all --format='%h %an <%ae> %s%n%b' | grep -I -E "${grep_args[@]}" 2>/dev/null || true)"
meta_bad=""
if [ -n "${meta}" ]; then
  while IFS= read -r line; do
    if is_accepted "${line}"; then
      printf '  [accepted] log  %s\n' "${line}"
      accepted_total=$((accepted_total + 1))
    else
      printf '  [!] log  %s\n' "${line}"
      meta_bad=1
    fi
  done <<< "${meta}"
fi
if [ -n "${meta_bad}" ]; then findings=$((findings + 1)); else echo "  clean"; fi

echo
if [ "${findings}" -gt 0 ]; then
  echo "== FAIL: ${findings} section(s) have unaccepted findings =="
  echo "A marker inside a commit's CONTENT cannot be fixed by a new commit: either"
  echo "rewrite history (and say so in the release notes), or accept it explicitly"
  echo "in ${accept_file} and keep HEAD clean. See MAINTENANCE.md §九."
  exit 1
fi
echo "== PASS: nothing unaccepted was found =="
