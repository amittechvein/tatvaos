#!/usr/bin/env bash
#
# TatvaOS — infra/scripts/maildir-removals.sh, the mail server's job that
# removes a deleted personal account's mail files (Mr. Singh on PR 319).
#
# The script's two Docker calls (doveadm expunge; the file count) are swapped
# for tests/personal-maildir-removal/fake-doveadm.sh on a local maildir tree;
# its database side is the real one, against the local database. What this
# proves is the script's DECISIONS — which addresses it will touch, and that
# it frees an address only on seeing the files gone. It does not prove doveadm;
# that is the first server step in the PR.
#
#   1. a queued, held, house address with no mailbox: files removed, row gone
#   2. REFUSED, files untouched: an address that has a mailbox (calibrated —
#      with that check cut out of a copy, the live mailbox's files ARE removed)
#   3. REFUSED: an address with no hold (no purge queued it)
#   4. REFUSED: an address on an organisation's domain
#   5. REFUSED: an address shaped like a path
#   6. the tool "succeeds" but files remain: the row stays, attempts counted,
#      the address stays held; next pass, removed
#   7. --dry-run changes nothing
#
#   bash tests/personal-maildir-removal/test-maildir-removal.sh
# ---------------------------------------------------------------------------
set -uo pipefail

export TATVAOS_VMAIL="${TATVAOS_VMAIL:-.tmp/vmail-mr}"
VMAIL="$TATVAOS_VMAIL"
PSQLC="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
export MR_PSQL="${TATVAOS_MR_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atq -v ON_ERROR_STOP=1}"
export MR_EXPUNGE="bash tests/personal-maildir-removal/fake-doveadm.sh expunge"
export MR_COUNT="bash tests/personal-maildir-removal/fake-doveadm.sh count"
export MR_BATCH=100
JOB=infra/scripts/maildir-removals.sh
RUN=$(date +%s)

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 300)]"; fi; }
PG() { $PSQLC "$1" 2>/dev/null | tr -d '\r'; }
files() { bash tests/personal-maildir-removal/fake-doveadm.sh count "$1" | tr -d '\r[:space:]'; }
mail_for() { # address, n files
    local l="${1%@*}" d="${1#*@}" i
    mkdir -p "$VMAIL/$d/$l/cur" "$VMAIL/$d/$l/new" "$VMAIL/$d/$l/.Sent/cur"
    for i in $(seq 1 "$2"); do printf 'Subject: old mail %s\n\nfor %s\n' "$i" "$1" > "$VMAIL/$d/$l/cur/$RUN.$i.eml"; done
    printf 'x' > "$VMAIL/$d/$l/.Sent/cur/$RUN.sent.eml"
}
queue() { # address, held?
    PG "INSERT INTO core.personal_purge_leftovers(kind, ref, address, last_error) VALUES ('maildir', '$1', '$1', 'queued') ON CONFLICT DO NOTHING" >/dev/null
    [ "$2" = "held" ] && PG "INSERT INTO core.address_holds(address, held_until, reason) VALUES ('$1', now()+interval '90 days', 'test $RUN') ON CONFLICT DO NOTHING" >/dev/null
}
queued() { PG "SELECT count(*) FROM core.personal_purge_leftovers WHERE kind='maildir' AND ref='$1'"; }
# A personal account that is alive: it has a mailbox. Its files must never go.
LIVE_ADDR=$(PG "SELECT address FROM mail.mailboxes WHERE address::text LIKE '%@personal.local' ORDER BY created_at LIMIT 1")
[ -n "$LIVE_ADDR" ] || { echo "needs one personal account with a mailbox (run tests/personal-join first)"; exit 1; }

GONE="gone.$RUN@personal.local"
UNHELD="unheld.$RUN@personal.local"
ORGX="former.$RUN@techvein.local"
STUCK="stuck.$RUN@personal.local"
BAD="../../etc$RUN@personal.local"

# Local only: a clean queue, so nothing earlier rides along.
PG "DELETE FROM core.personal_purge_leftovers WHERE kind='maildir'" >/dev/null
rm -rf "$VMAIL"

step "0. The job refuses to run blind"
out=$(env -u MR_PSQL bash "$JOB" 2>&1 | tr -d '\r')
if docker ps >/dev/null 2>&1; then pass "(docker present here — skipped)"; else
    has "no containers → REFUSED, exit non-zero" "$out" "REFUSED: need both containers running"; fi

step "7. --dry-run changes nothing"
mail_for "$GONE" 3; queue "$GONE" held
out=$(bash "$JOB" --dry-run 2>&1 | tr -d '\r')
has "it says what it would do" "$out" "would expunge [$GONE] (4 file(s) now)"
same "…and the files are all still there" "$(files "$GONE")" "4"
same "…and the row is still queued" "$(queued "$GONE")" "1"

step "1-5. One pass over five queued addresses"
mail_for "$LIVE_ADDR" 2; queue "$LIVE_ADDR" held       # 2: has a mailbox
mail_for "$UNHELD" 2;   queue "$UNHELD" none          # 3: no hold
mail_for "$ORGX" 2;     queue "$ORGX" held            # 4: an organisation's domain
queue "$BAD" held                                     # 5: a path
out=$(bash "$JOB" 2>&1 | tr -d '\r'); printf '%s\n' "$out" | sed 's/^/     | /'
same "1. the held house address: no message files remain" "$(files "$GONE")" "0"
same "…its row is gone (the hold may now end on its date)" "$(queued "$GONE")" "0"
has  "…and the log says so" "$out" "done [$GONE]: no message files remain"
has  "2. a live personal account (it has a mailbox): refused" "$out" "REFUSED [$LIVE_ADDR]: a mailbox with this address EXISTS"
same "…its files untouched" "$(files "$LIVE_ADDR")" "3"
same "…its row left" "$(queued "$LIVE_ADDR")" "1"
has  "3. no hold: refused" "$out" "REFUSED [$UNHELD]: not held by a purge"
same "…files untouched" "$(files "$UNHELD")" "3"
has  "4. an organisation's domain: refused" "$out" "REFUSED [$ORGX]: not on the personal house's domain"
same "…files untouched" "$(files "$ORGX")" "3"
has  "5. a path: refused" "$out" "REFUSED [$BAD]: not a plain address"
has  "the pass reports its totals" "$out" "pass finished: done=1 not_done=0 refused=4"

step "2 calibrated: the mailbox check is what saved that mailbox"
sed '/a mailbox with this address EXISTS/d' "$JOB" > "infra/scripts/.mr-uncut-$RUN.sh"
same "(the copy really lacks the check)" "$(grep -c 'mailbox with this address' "infra/scripts/.mr-uncut-$RUN.sh")" "0"
PG "DELETE FROM core.personal_purge_leftovers WHERE kind='maildir' AND ref <> '$LIVE_ADDR'" >/dev/null
out=$(bash "infra/scripts/.mr-uncut-$RUN.sh" 2>&1 | tr -d '\r')
same "without it, the live mailbox's files are REMOVED" "$(files "$LIVE_ADDR")" "0"
rm -f "infra/scripts/.mr-uncut-$RUN.sh"

step "6. The tool says it worked, files remain"
mail_for "$STUCK" 2; queue "$STUCK" held
out=$(MR_FAKE_STUCK=1 bash "$JOB" 2>&1 | tr -d '\r')
has  "NOT DONE, with the count" "$out" "NOT DONE [$STUCK]: 3 message file(s) remain"
same "the row stays, the attempt counted" "$(PG "SELECT attempts||' '||last_error FROM core.personal_purge_leftovers WHERE kind='maildir' AND ref='$STUCK'")" "1 3 message file(s) remain after doveadm"
same "…so the address stays held (the API's check reads this row)" "$(queued "$STUCK")" "1"
out=$(bash "$JOB" 2>&1 | tr -d '\r')
same "the next pass removes them" "$(files "$STUCK")|$(queued "$STUCK")" "0|0"

step "An empty queue"
PG "DELETE FROM core.personal_purge_leftovers WHERE kind='maildir'" >/dev/null
has "nothing queued" "$(bash "$JOB" 2>&1 | tr -d '\r')" "nothing queued"

PG "DELETE FROM core.address_holds WHERE reason='test $RUN'" >/dev/null
rm -rf "$VMAIL"
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
