#!/usr/bin/env bash
#
# TatvaOS — retired addresses: one list, organisations and personal accounts
# alike (Mr. Singh, 26 Sept 2026; 20260927-retired-addresses.sql).
#
#   1. EVERY path that retires an address writes its row, with its source:
#      person deleted, person offboarded (naming the forward), shared mailbox
#      deactivated, domain removed (its aliases), and any HARD delete — an
#      organisation removed takes its mailboxes and aliases by cascade, and the
#      database writes their rows itself. (Personal deletion: the purge
#      function, proven in tests/personal-lifecycle.)
#   2. The database refuses a mailbox, or an alias, at a held address — RED
#      FIRST: with the trigger dropped (in a rolled-back transaction) the same
#      insert SUCCEEDS. The one alias allowed is the forward the hold names.
#      Through the product: a person at a held address is told why (409).
#   3. Release: only an operator (an organisation owner gets 403), only with a
#      reason, never before the mail server has counted, never while it counts
#      files, never before the rule's floor, never while a mailbox still has
#      the address. The count comes from the mail server's job
#      (infra/scripts/maildir-removals.sh, count-only pass) — never the API.
#      Released: audited with who and why, and the address can be used again.
#
# Needs: the Development API ($TATVAOS_API) with DevOperatorSignIn on, the
# local seed (Techvein on techvein.local), the database with the migration.
#   bash tests/retired-addresses/test-retired.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
VMAIL="${TATVAOS_VMAIL:-.tmp/vmail}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
TECHVEIN="11111111-1111-1111-1111-111111111111"
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
has() { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 300)]"; fi; }
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
# Errors included, verbose: the SQLSTATE and the CONSTRAINT NAME are the proof.
PGE() { ${TATVAOS_PSQL_VERBOSE:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -v VERBOSITY=verbose -Atc} "$1" 2>&1 | tr -d '\r'; }
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
row() { PG "SELECT source||'|'||coalesce(tenant_id::text,'-')||'|'||coalesce(forward_mailbox_id::text,'-') FROM core.retired_addresses WHERE address='$1' AND released_at IS NULL"; }
rid() { PG "SELECT id FROM core.retired_addresses WHERE address='$1' AND released_at IS NULL"; }
release() { req POST "/api/admin/retired-addresses/$1/release" "$2" "{\"reason\":\"$3\"}"; }
box_id() { PG "SELECT id FROM mail.mailboxes WHERE address='$1'"; }
count_job() {
    TATVAOS_VMAIL="$VMAIL" MR_BATCH=500 \
    MR_PSQL="wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d "${TDB_NAME:-tatvaos_personal}" -Atq -v ON_ERROR_STOP=1" \
    MR_EXPUNGE="bash tests/personal-maildir-removal/fake-doveadm.sh expunge" \
    MR_COUNT="bash tests/personal-maildir-removal/fake-doveadm.sh count" \
    bash infra/scripts/maildir-removals.sh 2>&1 | tr -d '\r'
}

# ---------------------------------------------------------------------------
step "0. An organisation owner, an operator"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ] && pass "API health 200" || { fail "API down"; exit 1; }
PG "UPDATE core.users SET phone='$OWNER_PHONE', role='org_owner' WHERE id='d1111111-1111-1111-1111-111111111111' AND (phone IS NULL OR phone='$OWNER_PHONE'); UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
code=$(jq_ "$(body "$(req POST /api/auth/otp/request "" "{\"phone\":\"$OWNER_PHONE\"}")")" "d.get('devCode') or ''")
OWNER=$(jq_ "$(body "$(req POST /api/auth/otp/verify "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")")" "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "no owner sign-in"; exit 1; }
OP=$(jq_ "$(body "$(req POST /api/dev/operator-session "")")" "d['accessToken']")
[ -n "$OP" ] && pass "operator signed in" || { fail "no operator session"; exit 1; }

# ---------------------------------------------------------------------------
step "1. Every path that retires an address writes its row"
D="del.$RUN"; DA="$D@$DOMAIN"
create "$D" "Deleted Person" >/dev/null
req DELETE "/api/org/users/$(PG "SELECT id FROM core.users WHERE email='$DA'")" "$OWNER" >/dev/null
same "person DELETED → user_deleted, the organisation named" "$(row "$DA")" "user_deleted|$TECHVEIN|-"

SUCC="succ.$RUN"; create "$SUCC" "Successor" >/dev/null
SUCC_ID=$(PG "SELECT id FROM core.users WHERE email='$SUCC@$DOMAIN'"); SUCC_BOX=$(box_id "$SUCC@$DOMAIN")
# A new person is pending until first sign-in; offboarding forwards only to an active one.
PG "UPDATE core.users SET status='active' WHERE id='$SUCC_ID'" >/dev/null
O="off.$RUN"; OA="$O@$DOMAIN"
create "$O" "Leaver" >/dev/null
r=$(req POST "/api/org/users/$(PG "SELECT id FROM core.users WHERE email='$OA'")/offboard" "$OWNER" "{\"forwardToUserId\":\"$SUCC_ID\"}")
same "offboard, forwarding to the successor, still works (the forward is allowed)" "$(status "$r")" "200"
[ "$(status "$r")" = "200" ] || printf '     body: %s\n' "$(body "$r" | head -c 300)"
same "person OFFBOARDED → user_offboarded, naming the successor's mailbox" "$(row "$OA")" "user_offboarded|$TECHVEIN|$SUCC_BOX"
same "…and the forwarding alias exists" "$(PG "SELECT count(*) FROM mail.aliases WHERE address='$OA' AND target_mailbox_id='$SUCC_BOX'")" "1"

SH="shared.$RUN"; SHA="$SH@$DOMAIN"
r=$(req POST /api/org/mailboxes "$OWNER" "{\"localPart\":\"$SH\",\"domainId\":\"$DOMAIN_ID\",\"displayName\":\"Shared $RUN\"}")
req DELETE "/api/org/mailboxes/$(box_id "$SHA")" "$OWNER" >/dev/null
same "shared mailbox DEACTIVATED → shared_mailbox_deactivated" "$(row "$SHA")" "shared_mailbox_deactivated|$TECHVEIN|-"

# A second Techvein domain with an alias on it and no mailboxes, so removal is allowed.
XD="x$RUN.local"; XID="e$(printf '%07d' $((RUN % 10000000)))-1111-1111-1111-111111111111"
PG "INSERT INTO core.domains (id, tenant_id, fqdn, type, is_active, ownership_verified_at) VALUES ('$XID', '$TECHVEIN', '$XD', 'alias', true, now())" >/dev/null
PG "INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address) VALUES ('$TECHVEIN', '$XID', '$SUCC_BOX', 'sales@$XD')" >/dev/null
r=$(req DELETE "/api/org/domains/$XID" "$OWNER")
same "domain removal (no mailboxes on it) — 200" "$(status "$r")" "200"
same "DOMAIN REMOVED → its alias retired as domain_removed" "$(row "sales@$XD")" "domain_removed|$TECHVEIN|-"

# An organisation removed — no product path does this today; the database
# must write the rows anyway, whoever deletes, by cascade.
T="f$(printf '%07d' $((RUN % 10000000)))-2222-2222-2222-222222222222"; TD="gone$RUN.local"
PG "INSERT INTO core.tenants (id, name) VALUES ('$T', 'Gone $RUN');
    INSERT INTO core.domains (id, tenant_id, fqdn, is_active, ownership_verified_at) VALUES ('${T/2222-2222-2222/3333-3333-3333}', '$T', '$TD', true, now());
    INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part) VALUES ('$T', '${T/2222-2222-2222/3333-3333-3333}', 'boss@$TD', 'boss');
    INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address) SELECT '$T', '${T/2222-2222-2222/3333-3333-3333}', id, 'info@$TD' FROM mail.mailboxes WHERE address='boss@$TD'" >/dev/null
same "(an organisation with a mailbox and an alias, set up)" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE address='boss@$TD'")" "1"
PG "DELETE FROM core.tenants WHERE id='$T'" >/dev/null
same "ORGANISATION REMOVED (cascade) → its mailbox retired by the database" "$(row "boss@$TD")" "mailbox_deleted|$T|-"
same "…and its alias" "$(row "info@$TD")" "alias_deleted|$T|-"
same "…and the rows outlive the organisation" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$T'")" "0"

# ---------------------------------------------------------------------------
step "2. The database refuses a mailbox or an alias at a held address"
MB_INSERT="INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part) VALUES ('$TECHVEIN', '$DOMAIN_ID', 'boss@$TD', 'boss')"
r=$(PGE "$MB_INSERT")
has "a MAILBOX at a held address: refused by the trigger (23505, constraint retired_address_held)" "$r" "CONSTRAINT NAME:  retired_address_held"
has "…saying why" "$r" "is retired (mailbox_deleted"
# citext: the rule must not be dodged by case. (A narrowed search_path in the
# trigger would compare as text and let this through.)
has "…and in CAPITALS too" "$(PGE "${MB_INSERT//boss@$TD/BOSS@${TD^^}}")" "CONSTRAINT NAME:  retired_address_held"
r=$(PGE "BEGIN; DROP TRIGGER refuse_retired_address ON mail.mailboxes; $MB_INSERT; SELECT 'inserted:'||count(*) FROM mail.mailboxes WHERE address='boss@$TD'; ROLLBACK;")
has "RED FIRST: with the trigger dropped, the same mailbox IS created" "$r" "inserted:1"
same "…(rolled back: the trigger is still there)" "$(PG "SELECT count(*) FROM pg_trigger WHERE tgname='refuse_retired_address'")" "2"

AL_INSERT="INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address) VALUES ('$TECHVEIN', '$DOMAIN_ID', '$SUCC_BOX', 'info@$TD')"
r=$(PGE "$AL_INSERT")
has "an ALIAS at a held address: refused (constraint retired_address_held)" "$r" "CONSTRAINT NAME:  retired_address_held"
r=$(PGE "BEGIN; DROP TRIGGER refuse_retired_address ON mail.aliases; $AL_INSERT; SELECT 'inserted:'||count(*) FROM mail.aliases WHERE address='info@$TD'; ROLLBACK;")
has "RED FIRST: with the trigger dropped, the alias IS created" "$r" "inserted:1"

# The offboarding forward: the hold names the successor's mailbox.
PG "DELETE FROM mail.aliases WHERE address='$OA'" >/dev/null
same "(the forward removed; the hold stays)" "$(row "$OA")" "user_offboarded|$TECHVEIN|$SUCC_BOX"
OTHER_BOX=$(box_id "$SHA")
has "an alias at the leaver's address to ANOTHER mailbox: refused" \
    "$(PGE "INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address) VALUES ('$TECHVEIN', '$DOMAIN_ID', '$OTHER_BOX', '$OA')")" "retired_address_held"
has "…to the successor the hold names: allowed" \
    "$(PG "INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address) VALUES ('$TECHVEIN', '$DOMAIN_ID', '$SUCC_BOX', '$OA') RETURNING 'ok'")" "ok"

# Through the product: a person at an address whose rows were hard-deleted.
H="hard.$RUN"; HA="$H@$DOMAIN"
create "$H" "First Holder" >/dev/null
PG "DELETE FROM mail.mailboxes WHERE address='$HA'; DELETE FROM core.users WHERE email='$HA'" >/dev/null
same "(rows hard-deleted; the database retired the address itself)" "$(row "$HA")" "mailbox_deleted|$TECHVEIN|-"
r=$(create "$H" "Second Holder")
same "creating a person there: 409" "$(status "$r")" "409"
has "…told it was used before and is held" "$(body "$r")" "was used before and is held"
r=$(req POST /api/org/mailboxes "$OWNER" "{\"localPart\":\"$H\",\"domainId\":\"$DOMAIN_ID\",\"displayName\":\"Shared at a held address\"}")
same "a shared mailbox there: refused (400)" "$(status "$r")" "400"

# ---------------------------------------------------------------------------
step "3. Release: a person, a reason, a zero count — nothing else"
HID=$(rid "$HA")
same "an organisation OWNER cannot release (403)" "$(status "$(release "$HID" "$OWNER" "mine")")" "403"
same "the operator, with no reason: 400" "$(status "$(release "$HID" "$OP" "  ")")" "400"
r=$(release "$HID" "$OP" "testing")
same "before the mail server has counted: 409" "$(status "$r")" "409"
has "…saying so" "$(body "$r")" "has not counted"

mkdir -p "$VMAIL/$DOMAIN/$H/cur" && printf 'old' > "$VMAIL/$DOMAIN/$H/cur/$RUN.old"
out=$(count_job)
has "the job's count-only pass counts it (never expunges)" "$out" "counted [$HA]: 1 message file(s)"
same "…the file is still there" "$(find "$VMAIL/$DOMAIN/$H" -type f | wc -l | tr -d ' ')" "1"
r=$(release "$HID" "$OP" "testing")
same "files on disk: 409" "$(status "$r")" "409"
has "…with the count" "$(body "$r")" "counted 1 message file(s) still on disk"

rm -rf "$VMAIL/$DOMAIN/$H"
out=$(count_job)
has "files gone: the next pass counts zero" "$out" "counted [$HA]: 0 message file(s) — an operator may now release it"
l=$(body "$(req GET "/api/admin/retired-addresses?q=$H" "$OP")")
same "the console list shows it releasable" "$(jq_ "$l" "[x['releasable'] for x in d if x['address']=='$HA'][0]")" "True"

PG "UPDATE core.retired_addresses SET not_before = now() + interval '5 days' WHERE id=$HID" >/dev/null
r=$(release "$HID" "$OP" "testing")
same "before its rule's floor: 409" "$(status "$r")" "409"
has "…'Held until'" "$(body "$r")" "Held until"
PG "UPDATE core.retired_addresses SET not_before = NULL WHERE id=$HID" >/dev/null

DID=$(rid "$DA")
PG "UPDATE core.retired_addresses SET files_left=0, files_checked_at=now() WHERE id=$DID" >/dev/null
r=$(release "$DID" "$OP" "testing")
same "while a mailbox row still has the address (a deleted person's): 409" "$(status "$r")" "409"
has "…saying so" "$(body "$r")" "still has this address"

r=$(release "$HID" "$OP" "Customer asked to reuse it; old owner left in 2025 (ticket $RUN)")
same "RELEASED: operator, reason, zero count — 200" "$(status "$r")" "200"
same "…the row keeps who and why" "$(PG "SELECT (released_by IS NOT NULL)::text||'|'||release_reason FROM core.retired_addresses WHERE id=$HID")" "true|Customer asked to reuse it; old owner left in 2025 (ticket $RUN)"
same "…audited" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%address.released' AND target_id='$HID' AND after_state::text LIKE '%ticket $RUN%'")" "1"
same "…and released only once (409)" "$(status "$(release "$HID" "$OP" "again")")" "409"
r=$(create "$H" "Second Holder")
same "the address can be used again: 201" "$(status "$r")" "201"
same "…and deleting that person holds it again (a new row, the old one kept)" \
    "$(req DELETE "/api/org/users/$(PG "SELECT id FROM core.users WHERE email='$HA'")" "$OWNER" >/dev/null; PG "SELECT count(*) FILTER (WHERE released_at IS NULL)||'/'||count(*) FROM core.retired_addresses WHERE address='$HA'")" "1/2"

# ---------------------------------------------------------------------------
PG "DELETE FROM mail.aliases WHERE address='$OA'" >/dev/null
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
