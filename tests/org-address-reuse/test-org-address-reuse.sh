#!/usr/bin/env bash
#
# TatvaOS — can an ORGANISATION free an address and create it again, so that
# a new person's mailbox picks up the previous person's mail from disk?
# (Mr. Singh, 26 Sept 2026, on PR 319.)
#
# The mechanism is real: the mail importer (MaildirIngestWorker) reads maildir
# files by ADDRESS — {VmailRoot}/{domain}/{local}/new|cur — and files them into
# whichever mailbox row has that address. Nothing ever deletes maildir files.
# So the only thing between two people is that the address can never be
# created twice. This proves that, path by path:
#
#   0. the mechanism, shown working: an old file under rahul's address lands
#      in rahul's mailbox
#   1. delete, offboard, suspend, bulk create, shared-mailbox deactivate, and
#      domain removal — after each, creating rahul@ again is REFUSED
#   2. RED FIRST: free the address the way a hard delete would (the mailbox
#      and user rows removed directly), create rahul@ again — the new person's
#      mailbox receives the OLD mail. That is the leak the test would see if
#      any product path ever freed an address.
#
# Needs: the Development API ($TATVAOS_API) with Mail__VmailRoot=$VMAIL, the
# local seed (Techvein, techvein.local verified), its owner on +919999900001.
#   bash tests/org-address-reuse/test-org-address-reuse.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
VMAIL="${TATVAOS_VMAIL:-.tmp/vmail}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
DOMAIN_ID="a1111111-1111-1111-1111-111111111111"   # techvein.local
DOMAIN="techvein.local"
OWNER_PHONE="+919999900001"
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
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d '\r'; }
jq_() { printf '%s' "$1" | j "$2"; }
req() {
    local a=(-s -w '\n%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
    [ -n "$3" ] && a+=(-H "Authorization: Bearer $3")
    [ -n "${4:-}" ] && a+=(-d "$4")
    curl "${a[@]}"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
create() { req POST /api/org/users "$OWNER" "{\"localPart\":\"$1\",\"displayName\":\"$2\",\"domainId\":\"$DOMAIN_ID\",\"password\":\"a long enough passphrase\",\"products\":[\"mail\"]}"; }
old_mail() { # local subject -> drop a file as the mail server would deliver it
    mkdir -p "$VMAIL/$DOMAIN/$1/new" "$VMAIL/$DOMAIN/$1/cur" "$VMAIL/$DOMAIN/$1/tmp"
    printf 'From: someone@example.test\r\nTo: %s@%s\r\nSubject: %s\r\nMessage-ID: <%s@example.test>\r\n\r\nprivate content\r\n' \
        "$1" "$DOMAIN" "$2" "$RANDOM$RUN" > "$VMAIL/$DOMAIN/$1/new/$RUN.$RANDOM.test"
}
count_in() { # address subject -> messages with that subject in that address's LIVE mailbox
    PG "SELECT count(*) FROM mail.messages m JOIN mail.mailboxes b ON b.id=m.mailbox_id WHERE b.address='$1' AND b.is_active AND m.subject='$2'"
}
wait_for() { # address subject want -> waits up to 40s for the importer
    for _ in $(seq 1 20); do [ "$(count_in "$1" "$2")" = "$3" ] && return 0; sleep 2; done; return 1
}

# ---------------------------------------------------------------------------
step "Sign in as the Techvein owner"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ] && pass "API health 200" || { fail "API down"; exit 1; }
PG "UPDATE core.users SET phone='$OWNER_PHONE', role='org_owner' WHERE id='d1111111-1111-1111-1111-111111111111' AND (phone IS NULL OR phone='$OWNER_PHONE'); UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
code=$(jq_ "$(body "$(req POST /api/auth/otp/request "" "{\"phone\":\"$OWNER_PHONE\"}")")" "d.get('devCode') or ''")
OWNER=$(jq_ "$(body "$(req POST /api/auth/otp/verify "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")")" "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "signed in" || { fail "no owner sign-in"; exit 1; }

# ---------------------------------------------------------------------------
step "0. The mechanism: a file on disk under rahul's address lands in rahul's mailbox"
R="rahul.$RUN"; RA="$R@$DOMAIN"
same "rahul@ created" "$(status "$(create "$R" "Rahul One")")" "201"
old_mail "$R" "RAHUL ONE PRIVATE $RUN"
wait_for "$RA" "RAHUL ONE PRIVATE $RUN" 1 && pass "the importer filed it into rahul's mailbox" || fail "the importer did not file it (is Mail__VmailRoot pointing at $VMAIL?)"
RID=$(PG "SELECT id FROM core.users WHERE email='$RA'")

# ---------------------------------------------------------------------------
step "1. Every way the product removes a person or mailbox — then rahul@ again"
r=$(req DELETE "/api/org/users/$RID" "$OWNER"); [ "$(status "$r")" -lt 300 ] && pass "delete rahul ($(status "$r"))" || fail "delete: $(status "$r")"
r=$(create "$R" "Rahul Two")
same "after DELETE: creating rahul@ again is refused (409)" "$(status "$r")" "409"
r=$(req POST /api/org/users/bulk "$OWNER" "{\"domainId\":\"$DOMAIN_ID\",\"users\":[{\"localPart\":\"$R\",\"displayName\":\"Rahul Bulk\",\"password\":\"a long enough passphrase\"}]}")
if [ "$(status "$r")" -lt 300 ] && [ "$(PG "SELECT count(*) FROM core.users WHERE email='$RA' AND status<>'deleted'")" != "0" ]; then
    fail "BULK create re-created rahul@: $(body "$r" | head -c 200)"
else pass "…and by bulk create ($(status "$r"); no live rahul@ made)"; fi

O="off.$RUN"; OA="$O@$DOMAIN"
create "$O" "Offboard Me" >/dev/null
OID=$(PG "SELECT id FROM core.users WHERE email='$OA'")
same "offboard" "$(status "$(req POST "/api/org/users/$OID/offboard" "$OWNER" '{}')")" "200"
same "after OFFBOARD: refused" "$(status "$(create "$O" "New Starter")")" "409"

S="susp.$RUN"; SA="$S@$DOMAIN"
create "$S" "Suspend Me" >/dev/null
SID=$(PG "SELECT id FROM core.users WHERE email='$SA'")
req POST "/api/org/users/$SID/suspend" "$OWNER" >/dev/null
same "after SUSPEND: refused" "$(status "$(create "$S" "New Starter")")" "409"

SH="shared.$RUN"; SHA="$SH@$DOMAIN"
r=$(req POST /api/org/mailboxes "$OWNER" "{\"localPart\":\"$SH\",\"domainId\":\"$DOMAIN_ID\",\"displayName\":\"Shared $RUN\"}")
SHID=$(jq_ "$(body "$r")" "d.get('id') or d.get('mailboxId')")
req DELETE "/api/org/mailboxes/$SHID" "$OWNER" >/dev/null
same "after a shared mailbox is DEACTIVATED: a person at that address is refused" "$(status "$(create "$SH" "Takes Shared")")" "409"
r=$(req POST /api/org/mailboxes "$OWNER" "{\"localPart\":\"$SH\",\"domainId\":\"$DOMAIN_ID\",\"displayName\":\"Again\"}")
same "…and so is a new shared mailbox at it (400, 'already in use')" "$(status "$r") $(jq_ "$(body "$r")" "'already in use' in d.get('error','')")" "400 True"

r=$(req DELETE "/api/org/domains/$DOMAIN_ID" "$OWNER")
same "DOMAIN removal is refused while mailboxes (even deactivated ones) use it" "$(status "$r")" "400"
same "…so no mailbox row was removed by it" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE address='$RA'")" "1"

# ---------------------------------------------------------------------------
step "2. RED FIRST: what the test sees if an address WERE freed"
# Exactly what a hard delete would do: the rows go, the maildir stays.
PG "DELETE FROM mail.mailboxes WHERE address='$RA'; DELETE FROM core.users WHERE email='$RA'" >/dev/null
same "rahul@ can now be created again (201)" "$(status "$(create "$R" "Rahul Two, a different person")")" "201"
old_mail "$R" "NUDGE $RUN"   # any new delivery makes the importer walk the folder
if wait_for "$RA" "RAHUL ONE PRIVATE $RUN" 1; then
    pass "LEAK SHOWN: the new rahul@ received the old rahul's mail from disk (this is what the refusals above prevent)"
else
    fail "calibration: the old file did NOT reach the new mailbox — the test could not see a leak"
fi

# Clean up the calibration's person so a re-run starts clean.
PG "DELETE FROM mail.mailboxes WHERE address='$RA'; DELETE FROM core.users WHERE email='$RA'" >/dev/null
rm -rf "$VMAIL/$DOMAIN/$R" "$VMAIL/$DOMAIN/$O" "$VMAIL/$DOMAIN/$S"

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
