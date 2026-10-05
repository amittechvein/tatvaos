#!/usr/bin/env bash
#
# tests/support/grep-helper-calibration.sh - do the suites' has() / hasnt()
# helpers tell the truth about a LONG text?
#
# WHY (3 Oct 2026, PR 386). The helpers were written
#     printf "%s" "$2" | grep -qF -- "$3"
# under `set -o pipefail`. When the needle is near the top of a text longer
# than the pipe's buffer (64 KB), grep -q exits at the first match, printf dies
# of SIGPIPE writing the rest, and the pipeline is "false":
#   - has()   then FAILS with the line present (a false red; PR 386's CI), and
#   - hasnt() then PASSES with the line present (a FALSE GREEN: a "must not
#     contain" check that cannot see what it is looking for).
# A standalone calibration: 20 of 20 wrong with the pipe, 0 of 20 with a
# here-string; both are right when the needle is absent.
#
# WHAT IT DOES. For every test script under ROOT/tests that defines has() or
# hasnt(), it lifts THAT FILE'S OWN definition (not a copy), runs it under
# pipefail against a 200,000-line text with the needle on line 1, and against
# the same text without it, and says whether each answer is right.
#
#   bash tests/support/grep-helper-calibration.sh [ROOT]   (default: this checkout)
#   exit 0 = every helper right; 1 = at least one wrong; 2 = nothing found to test
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
TRIES=5
WRONG=0; TESTED=0

# The long text, with and without the needle. Bigger than any pipe buffer.
TEXT_WITH="needle-on-line-one
$(seq 1 200000)"
TEXT_WITHOUT="$(seq 1 200000)"

# lift NAME FILE -> that function's definition: from "NAME() {" to the next
# line that is exactly "}", or that one line when it closes itself
# ("has() { ...; }", as tests/lib/throwaway-db-guard-test.sh writes them).
# The name is matched as a plain prefix, not a regex, so "has" never lifts
# "hasnt" and no regex escaping is involved.
lift() { awk -v n="$1" '
    !on && substr($0, 1, length(n) + 2) == n "()" && substr($0, length(n) + 3) ~ /^[ \t]*[{]/ {
        on = 1; print; if ($0 ~ /[}][ \t]*$/) exit; next
    }
    on { print }
    on && /^[}]/ { exit }' "$2"; }

# run FILE NAME TEXT NEEDLE -> PASS or FAIL, as that file's helper says
run() {
    local def; def=$(lift "$2" "$1")
    bash -c '
        set -uo pipefail
        pass() { echo PASS; }
        fail() { echo FAIL; }
        brief() { printf "%.40s" "$1"; }
        eval "$1"
        "$2" "label" "$3" "$4"
    ' _ "$def" "$2" "$3" "$4" 2>/dev/null | head -1
}

# check FILE NAME TEXT NEEDLE WANT TRIES DESCRIPTION
check() {
    local got bad=0 i
    for i in $(seq 1 "$6"); do
        got=$(run "$1" "$2" "$3" "$4")
        [ "$got" = "$5" ] || bad=$((bad+1))
    done
    if [ "$bad" -eq 0 ]; then printf "  ok    %s %s: %s\n" "${1#$ROOT/}" "$2" "$7"
    else printf "  WRONG %s %s: %s - wrong %d of %d\n" "${1#$ROOT/}" "$2" "$7" "$bad" "$6"; WRONG=$((WRONG+1)); fi
}

printf "\n  has()/hasnt() on a long text\n  tree: %s\n\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
while IFS= read -r f; do
    for name in has hasnt; do
        grep -qE "^$name\(\)[[:space:]]*\{" "$f" || continue
        TESTED=$((TESTED+1))
        if [ "$name" = has ]; then
            check "$f" has   "$TEXT_WITH"    needle-on-line-one PASS "$TRIES" "present, early in a long text -> PASS"
            check "$f" has   "$TEXT_WITHOUT" needle-on-line-one FAIL 1        "absent -> FAIL"
        else
            check "$f" hasnt "$TEXT_WITH"    needle-on-line-one FAIL "$TRIES" "present, early in a long text -> FAIL"
            check "$f" hasnt "$TEXT_WITHOUT" needle-on-line-one PASS 1        "absent -> PASS"
        fi
    done
done < <(grep -rlE '^(has|hasnt)\(\)[[:space:]]*\{' "$ROOT/tests" --include=*.sh | sort)

printf "\n  -----------------------------------------------\n"
if [ "$TESTED" -eq 0 ]; then printf "  NOTHING TESTED - no has()/hasnt() found under %s/tests\n\n" "$ROOT"; exit 2; fi
if [ "$WRONG" -eq 0 ]; then printf "  PASS  %d helpers, every answer right\n\n" "$TESTED"; exit 0
else printf "  FAIL  %d wrong answers across %d helpers\n\n" "$WRONG" "$TESTED"; exit 1; fi
