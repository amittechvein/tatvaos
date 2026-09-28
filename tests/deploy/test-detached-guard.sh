#!/usr/bin/env bash
#
# deploy.sh must refuse to run attached to a session, and must run detached
# (HOUSE_RULES rule 11b; Mr. Singh, 27-28 Sept 2026).
#
# The first version of the guard looked only at stdout. So the natural thing
# to type from an SSH session,
#
#     ./infra/scripts/deploy.sh production > deploy.log 2>&1
#
# passed it: output is a file, not a terminal. But the process is still in the
# session, and still dies when the connection drops — the 26 September failure
# exactly. What matters is whether the process HAS A CONTROLLING TERMINAL, and
# that is what is tested here, four ways:
#
#   1. on a terminal, nothing redirected                      -> refused
#   2. output redirected to a log, stdin still the terminal   -> refused
#   3. output AND stdin redirected, still in the session      -> refused
#   4. the printed form: setsid nohup, log, stdin /dev/null   -> runs
#   5. DEPLOY_ATTACHED=1 on a terminal (local rehearsal)      -> runs
#   6. NO terminal at all, output down a pipe                 -> refused
#      (`ssh host ./deploy.sh production`, or `| tee log`: measured to die
#      by SIGPIPE when the reader goes away)
#   7. the same with DEPLOY_ATTACHED=1 (the workflow's form)  -> runs
#
# "Runs" means it got past the guard to Preflight, where it stops because this
# checkout has no infra/docker/.env. THIS TEST REFUSES TO RUN WHERE THAT FILE
# EXISTS, so it can never start a real deploy.
#
# Needs Linux and `script` (util-linux) to give a command a terminal. On the
# laptop:   wsl -e bash tests/deploy/test-detached-guard.sh
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

if [ -e infra/docker/.env ]; then
    echo "REFUSING: infra/docker/.env exists here. This test starts deploy.sh and relies on"
    echo "its absence to stop at Preflight. Never run it on a server."
    exit 2
fi
command -v script >/dev/null 2>&1 || { echo "needs 'script' (util-linux)"; exit 2; }
command -v setsid >/dev/null 2>&1 || { echo "needs 'setsid' (util-linux)"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

# in_session NAME COMMAND — runs COMMAND under `script`, so it has a
# controlling terminal as an SSH session would; everything it prints, to the
# terminal or to its own log, ends up in $TMP/NAME.out.
in_session() {
    local name="$1" cmd="$2"
    script -qec "$cmd" /dev/null > "$TMP/$name.term" 2>&1 < /dev/null || true
    cat "$TMP/$name.term" "$TMP/$name.log" 2>/dev/null | tr -d '\r' > "$TMP/$name.out"
}
refused() {
    if ! [ -s "$TMP/$1.out" ]; then fail "$2 — produced no output at all"
    elif grep -q "Preflight" "$TMP/$1.out"; then fail "$2 — it RAN (reached Preflight)"
    elif grep -q "Run it detached" "$TMP/$1.out"; then pass "$2"
    else fail "$2 — neither refused nor ran: $(head -c 200 "$TMP/$1.out")"; fi
}
ran() {
    if ! [ -s "$TMP/$1.out" ]; then fail "$2 — produced no output at all"
    elif grep -q "Run it detached" "$TMP/$1.out"; then fail "$2 — it was REFUSED"
    elif grep -q "Preflight" "$TMP/$1.out" && grep -q "DEPLOY VERDICT: FAIL" "$TMP/$1.out"; then pass "$2"
    else fail "$2 — neither refused nor reached Preflight: $(head -c 200 "$TMP/$1.out")"; fi
}

D=./infra/scripts/deploy.sh
# why NAME — the reason the refusal gave, for a failing check to print.
why() { grep -o 'attached: [^.]*' "$TMP/$1.out" | head -1; }

in_session t1 "$D production"
refused t1 "1. on a terminal: refused"

# Each test must be able to fire on its own, not only behind the one before
# it. With input from /dev/null, only the OUTPUT is a terminal here. (The
# first draft ran its tests inside a command substitution, where output is
# never a terminal; this case could not have passed.)
in_session t1b "$D production < /dev/null"
refused t1b "1b. output a terminal, input not: refused"
grep -q "its output is a terminal" "$TMP/t1b.out" \
    && pass "    …because its output is a terminal" || fail "    …for another reason: $(why t1b)"

in_session t2 "$D production > $TMP/t2.log 2>&1"
refused t2 "2. output redirected to a log, stdin the terminal: refused"

in_session t3 "$D production > $TMP/t3.log 2>&1 < /dev/null"
refused t3 "3. output and stdin redirected, still in the session: refused"
grep -q "controlling terminal" "$TMP/t3.out" \
    && pass "    …because it has a controlling terminal" || fail "    …for another reason: $(why t3)"

# The detached run is waited for by polling its log for the verdict: setsid
# returns at once when it has to fork, exactly as it does over SSH.
in_session t4 "CI=1 setsid nohup $D production > $TMP/t4.log 2>&1 < /dev/null & for i in \$(seq 1 50); do grep -q 'DEPLOY VERDICT' $TMP/t4.log 2>/dev/null && break; sleep 0.2; done"
ran t4 "4. the printed form (setsid nohup, log, stdin /dev/null): runs"

in_session t5 "DEPLOY_ATTACHED=1 $D production"
ran t5 "5. DEPLOY_ATTACHED=1 on a terminal (local rehearsal): runs"

# No terminal anywhere: setsid drops it. Output goes down a pipe, as it does
# over `ssh host cmd` without a terminal.
setsid $D production < /dev/null 2>&1 | cat > "$TMP/t6.out"
refused t6 "6. no terminal, output down a pipe (ssh without a terminal, or | tee): refused"
grep -q "not a log file" "$TMP/t6.out" \
    && pass "   …and says why: its output is not a log file" || fail "   …without saying why"

CI=1 DEPLOY_ATTACHED=1 setsid $D production < /dev/null 2>&1 | cat > "$TMP/t7.out"
ran t7 "7. the same with DEPLOY_ATTACHED=1 (the workflow's form): runs"

# The refusal must print the command that works, and take no lock.
grep -q "setsid nohup ./infra/scripts/deploy.sh production" "$TMP/t1.out" \
    && pass "the refusal prints the detached command" || fail "the refusal does not print the detached command"

printf '\n'
if [ "$FAILED" -eq 0 ]; then printf '  PASS  %d checks\n\n' "$PASSED"; exit 0
else printf '  FAIL  %d of %d checks\n\n' "$FAILED" $((PASSED+FAILED)); exit 1; fi
