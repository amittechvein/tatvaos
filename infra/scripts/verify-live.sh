#!/usr/bin/env bash
#
# TatvaOS — is production actually up?
#
#   ./verify-live.sh                 (from anywhere; it finds the repo root)
#
# Runnable STANDALONE, on purpose. A verification script you can only reach
# through a deploy is one nobody runs when they're worried. deploy.sh calls
# this as its final step and the deploy workflow calls it over SSH; all three
# entrances run the same definition of "up".
#
# Shebang is /usr/bin/env bash, not sh: /dev/tcp and `local` below are
# bashisms, and under dash every network check would fail in a way that looks
# like the network's fault.
#
# EVERY check fails CLOSED. "Could not perform the test" and "the test passed"
# never share a branch — that distinction is the entire lesson of 27 August,
# when three HTTP 200s stood guard over a dead mail server.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); B=$(c $'\033[1m'); X=$(c $'\033[0m')

# Same convention as deploy.sh: bad() COUNTS, and the verdict reads the
# counter. A red line that never reaches the exit status is a comment.
FAILURES=0

step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf '   %s%s%s\n' "$D" "$1" "$X"; }

COMPOSE="docker compose \
    -f infra/docker/docker-compose.base.yml \
    -f infra/docker/docker-compose.production.yml \
    --env-file infra/docker/.env"

# ---------------------------------------------------------------------------
#  1. Service count — declaration vs reality.
#
#  The denominator comes from `config --services` (what the compose files
#  DECLARE), never from `ps` (what happens to exist). A service that never
#  created a container vanishes from both sides of a ps-vs-ps comparison,
#  which is how "all 10 running" once printed on an 11-service stack.
# ---------------------------------------------------------------------------
check_services() {
    step "Services"

    local expected running
    expected=$($COMPOSE config --services 2>/dev/null | wc -l)
    if [ "$expected" -eq 0 ]; then
        bad "Could not read the service list from the compose files."
        note "check:  $COMPOSE config --services"
        return 1
    fi

    running=$($COMPOSE ps --services --filter status=running 2>/dev/null | wc -l)
    if [ "$running" -eq "$expected" ]; then
        ok "all ${expected} declared services running"
    else
        bad "${running} of ${expected} declared services running."
        note "declared but not running:"
        comm -23 <($COMPOSE config --services 2>/dev/null | sort) \
                 <($COMPOSE ps --services --filter status=running 2>/dev/null | sort) \
            | sed 's/^/      /'
        return 1
    fi
}

# ---------------------------------------------------------------------------
#  2. IMAP answers, and its certificate is real.        (Mail's check, as
#  reviewed — one connection, two questions.)
# ---------------------------------------------------------------------------
check_imap() {
    step "IMAP (mail edge, port 993)"

    # ONE connection, two questions. Not -quiet: the verify line is half of
    # what we came for, and -quiet suppresses it.
    #
    # Stdin is a piped LOGOUT, NOT </dev/null. With </dev/null, s_client
    # hits stdin EOF straight after the TLS handshake and closes — BEFORE a
    # freshly restarted Dovecot has sent its greeting. deploy.sh restarts
    # Dovecot moments before calling this script, so the </dev/null form
    # false-alarmed on every deploy and passed only against a warm server:
    # the worst calibration a check can have, because a check that cries
    # wolf on every deploy is ignored by the third deploy, and then it is
    # not a check. The piped LOGOUT keeps s_client reading until the server
    # answers, captures the greeting, and ends clean with "a1 OK Logout".
    # (Found by the CTO against production, 30 Aug 2026.)
    local out
    out=$(printf 'a1 LOGOUT\r\n' | timeout 10 openssl s_client \
              -connect "$MAIL_HOST:993" -servername "$MAIL_HOST" 2>&1 || true)

    if [ -z "$out" ]; then
        # Timeout, refused, DNS failure — all of them arrive here as silence.
        # Silence is a FAILURE, never a pass.
        bad "Could not reach $MAIL_HOST:993 at all — no response to test."
        return 1
    fi

    if printf '%s\n' "$out" | grep -q '^\* OK'; then
        ok "IMAP greeting received."
    else
        bad "No IMAP greeting on $MAIL_HOST:993 — Dovecot is not serving."
        note "Check: docker compose ps dovecot, then its logs."
        return 1
    fi

    # A wrong or expired certificate does not break this script, it breaks
    # every phone in the customer's building — silently, one client at a time.
    if printf '%s\n' "$out" | grep -q 'Verify return code: 0 (ok)'; then
        ok "IMAP certificate verifies."
    else
        bad "IMAP certificate does NOT verify — mail clients will refuse to connect."
        note "$(printf '%s\n' "$out" | grep -m1 'Verify return code:' || echo 'no verify line returned')"
        return 1
    fi
}

# ---------------------------------------------------------------------------
#  3. SMTP answers on both submission paths.            (Mail's check, as
#  reviewed.) 25 is inbound from the world, 587 is where the customer's own
#  clients submit. They fail independently and for different reasons, so
#  they are reported independently.
# ---------------------------------------------------------------------------
check_smtp() {
    step "SMTP (ports 25 and 587)"

    local port banner failed=0
    for port in 25 587; do
        banner=""
        # bash's /dev/tcp rather than nc or swaks: no package to install, and
        # a missing tool must not become a skipped check.
        if exec 3<>"/dev/tcp/$MAIL_HOST/$port" 2>/dev/null; then
            IFS= read -r -t 10 banner <&3 || true
            printf 'QUIT\r\n' >&3 2>/dev/null || true
            exec 3<&- 3>&- 2>/dev/null || true
        fi

        case "$banner" in
            220*) ok "Port $port answered: ${banner%%$'\r'*}" ;;
            "")   bad "Port $port did not answer — Postfix is not listening."; failed=1 ;;
            *)    bad "Port $port answered, but not with 220: ${banner%%$'\r'*}"; failed=1 ;;
        esac
    done

    return $failed
}

# ---------------------------------------------------------------------------
#  4. The queue — the check that would have caught 27 August on its own.
#
#  Mail wrote this against `postqueue -p` and documented two traps in the
#  parsing: mawk has no {5,} interval expressions, and `postqueue -p` prints
#  no year, so a message queued on 31 December reads as eleven months in the
#  future every January. Both traps live in parsing HUMAN output.
#
#  So this uses `postqueue -j` (Postfix ≥ 3.1; the box runs 3.7.11, confirmed
#  by Mail): one JSON object per queued message with arrival_time as an epoch
#  integer. No queue-ID alphabet assumption, no date parsing, no year bug.
#  On an empty queue it prints nothing and exits 0 — verified on the box.
#
#  AGE, NOT DEPTH, DECIDES. One depth sample cannot tell five messages in
#  flight from five stuck, and a threshold on depth goes stale the day this
#  box gets busy. On a box whose normal queue is empty, a message older than
#  ten minutes is delivery stuck, whatever the count; a busy queue that is
#  moving never trips it. Depth is reported for the human, not gated on.
# ---------------------------------------------------------------------------
QUEUE_MAX_AGE=600

# Parsing lives in its own function taking (exit-code, output) so the
# fixtures below the verdict can drive it without a mail server. A check
# nobody has seen fail is not a check — Mail's fixture E caught an inverted
# comparison in the first draft of exactly this logic.
parse_queue() {
    local rc="$1" out="$2"

    # FAIL CLOSED. If the container is gone or exec errored we could not
    # perform the test, and "could not read the queue" must never arrive at
    # the same branch as "the queue is empty". The first draft of this check
    # piped into `grep -c || true` and reported a healthy depth=0 precisely
    # when the mail server was dead.
    if [ "$rc" -ne 0 ]; then
        bad "Could not read the mail queue (exit $rc) — Postfix is not answering."
        note "${out%%$'\n'*}"
        return 1
    fi

    if [ -z "$out" ]; then
        ok "Queue empty."
        return 0
    fi

    local depth
    depth=$(printf '%s\n' "$out" | grep -c '"queue_id"')

    local now oldest=0 secs
    now=$(date +%s)
    # Keep the EARLIEST. oldest=0 means "nothing parsed yet", which is why it
    # is also the sentinel the failure branch below tests for.
    while IFS= read -r secs; do
        [ -n "$secs" ] || continue
        if [ "$oldest" -eq 0 ] || [ "$secs" -lt "$oldest" ]; then
            oldest=$secs
        fi
    done < <(printf '%s\n' "$out" \
             | grep -o '"arrival_time": *[0-9][0-9]*' \
             | grep -o '[0-9][0-9]*$')

    # Output exists but not one arrival time parsed: the output is in a shape
    # we do not understand, which is a failure to test, not a pass.
    if [ "$oldest" -eq 0 ]; then
        bad "${depth} queue entr(y/ies) and no arrival_time could be read — queue output not understood."
        return 1
    fi

    local age=$(( now - oldest ))
    note "${depth} message(s) queued, oldest ${age}s old."

    if [ "$age" -gt "$QUEUE_MAX_AGE" ]; then
        bad "Mail has been queued for ${age}s — delivery is stuck, not slow."
        note "Postfix accepts and holds when Dovecot LMTP is unreachable. Nothing is lost yet."
        note "Check: docker compose ps dovecot"
        return 1
    fi

    ok "Queue moving (oldest ${age}s)."
}

# ---------------------------------------------------------------------------
#  Self-test: ./verify-live.sh --selftest
#
#  Mail's six fixtures, ported to -j output. Two pass and four fail ON
#  PURPOSE. Each fixture ASSERTS its expected exit code — so the self-test
#  itself exits non-zero when parse_queue misbehaves. (Its first draft ran
#  before parse_queue was even defined and still exited 0: a self-test that
#  cannot fail, caught by running it. The house rule applies to the tests
#  too.)
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--selftest" ]; then
    now=$(date +%s)
    j() { printf '{"queue_name": "deferred", "queue_id": "%s", "arrival_time": %s, "message_size": 1204, "sender": "a@b", "recipients": [{"address": "c@d"}]}\n' "$1" "$2"; }

    ST_FAILED=0
    fixture() {  # fixture <name> <expected-rc> <rc> <output>
        local name="$1" want="$2" rc="$3" out="$4" got
        echo "== $name (expect rc $want)"
        parse_queue "$rc" "$out"; got=$?
        if [ "$got" -eq "$want" ]; then
            echo "   rc=$got — as expected"
        else
            echo "   rc=$got — EXPECTED $want: SELF-TEST FAILURE"
            ST_FAILED=1
        fi
    }

    fixture "A: empty (rc 0, no output)"        0 0 ""
    fixture "B: exec failed"                    1 1 "Error: no such container: tatvaos-postfix-1"
    fixture "C: one fresh (30s)"                0 0 "$(j AAAA1111 $((now-30)))"
    fixture "D: one old (45m, stuck)"           1 0 "$(j BBBB2222 $((now-2700)))"
    fixture "E: mixed - oldest must win"        1 0 "$(j AAAA1111 $((now-30)); j BBBB2222 $((now-2700)))"
    fixture "F: entries but no arrival_time"    1 0 '{"queue_id": "CCCC3333", "sender": "a@b"}'

    if [ "$ST_FAILED" -ne 0 ]; then
        echo; echo "SELF-TEST FAILED — parse_queue does not behave as the fixtures require."
        exit 1
    fi
    echo; echo "self-test passed: 6 fixtures, 4 of them failures that failed correctly."
    exit 0
fi

check_queue() {
    step "Mail queue"
    local out rc=0
    out=$($COMPOSE exec -T postfix postqueue -j 2>&1) || rc=$?
    parse_queue "$rc" "$out"
}

# ---------------------------------------------------------------------------
#  MAIL_HOST — read from .env, never assumed.
#
#  Standalone means no variable a deploy happened to export. An unset
#  hostname must not silently become an empty check: openssl against ""
#  fails instantly and would count as "unreachable", which is a lie in both
#  directions. So: resolve it here, or stop here.
# ---------------------------------------------------------------------------
MAIL_HOST=$(grep '^MAIL_DOMAIN=' infra/docker/.env 2>/dev/null | cut -d= -f2)
if [ -z "$MAIL_HOST" ]; then
    bad "MAIL_DOMAIN is not set in infra/docker/.env — cannot test the mail edge."
    note "Every mail check below would silently test an empty hostname."
    printf '\n   %s%sNOT verified — %d check(s) failed.%s\n\n' "$B" "$R" "$FAILURES" "$X"
    exit 1
fi

# ---------------------------------------------------------------------------
#  Run everything. No check aborts the script: a dead IMAP must not hide a
#  stuck queue — the operator gets the whole picture, then one verdict.
# ---------------------------------------------------------------------------
check_services || true
check_imap     || true
check_smtp     || true
check_queue    || true

step "Verdict"
if [ "$FAILURES" -gt 0 ]; then
    printf '\n   %s%sNOT verified — %d check(s) failed.%s\n\n' "$B" "$R" "$FAILURES" "$X"
    exit 1
fi
printf '\n   %sproduction verified — services, IMAP, SMTP, queue all answer.%s\n\n' "$G" "$X"
