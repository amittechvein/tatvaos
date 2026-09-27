#!/usr/bin/env bash
#
# TatvaOS — the operator's page for one organisation (Amit, 26 Sept 2026):
# its domains, every mail ID, its shared mailboxes and who can open them.
#
# This reads ACROSS organisations, so most of what is proved here is what must
# NOT happen:
#
#   1. an organisation's own owner has no route to it (403), nobody at all 401
#   2. the operator's counts equal the database's, for THIS organisation
#   3. a mail ID planted in ANOTHER organisation never appears — and the same
#      search against that other organisation DOES find it, so "nothing
#      found" is the tenancy guard and not a broken search
#   4. the shared mailbox shows who can open it, and an alias shows on its box
#   5. nonsense filters are refused; an unknown organisation is a 404
#   6. every open and every new search is in the organisation's audit log,
#      marked platform:, and turning a page is not
#
# Setup is tests/connect-invitation-caps's, deliberately the same: WSL
# Postgres (no Docker on the laptop), the API from the Release build, OTP
# sign-in with the dev code. The operator is the seed school's principal,
# made super_admin for the run and put back on exit.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ORGDETAIL_TEST_PORT:-5087}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/org-detail-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf "%s" "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf "  %s✓%s %s\n" "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  %s✗%s %s\n" "$RED" "$RST" "$1"; }
step() { printf "\n%s>> %s%s\n" "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
jq_() { printf "%s" "$1" | j "$2"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
brief() { printf "%s" "$1" | head -c 220 | tr "\n" " "; }
# An empty operand is REFUSED, not compared: [ "" = "" ] is true, and that has
# already printed false greens in this repository (tests/orgapi).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}
# hasnt refuses an empty haystack: "not found in nothing" is the false green.
hasnt() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then fail "$1 — FOUND in: $(brief "$2")"
    else pass "$1"; fi
}
call() { curl -s -w "\n%{http_code}" -X GET "$API$1" -H "Authorization: Bearer $2"; }
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

LEAK="leak-$RUN"; PROBE="probe-$RUN"; ALIAS="alias-$RUN"
API_PID=""; PRINCIPAL_WAS=""
cleanup() {
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    PG "DELETE FROM mail.aliases WHERE address LIKE '$ALIAS@%'" >/dev/null
    PG "DELETE FROM mail.mailbox_permissions WHERE mailbox_id IN (SELECT id FROM mail.mailboxes WHERE local_part IN ('$LEAK','$PROBE'))" >/dev/null
    PG "DELETE FROM mail.folders WHERE mailbox_id IN (SELECT id FROM mail.mailboxes WHERE local_part IN ('$LEAK','$PROBE'))" >/dev/null
    PG "DELETE FROM mail.mailboxes WHERE local_part IN ('$LEAK','$PROBE')" >/dev/null
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
        fi
        kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

step "0. The database answers, and the fixtures go in ($TATVAOS_PG_HOST)"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
pass "psql answers"

TV_DOMAIN=$(PG "SELECT id FROM core.domains WHERE tenant_id='$TECHVEIN' ORDER BY (type='primary') DESC LIMIT 1")
TV_FQDN=$(PG "SELECT fqdn FROM core.domains WHERE id='$TV_DOMAIN'")
SC_DOMAIN=$(PG "SELECT id FROM core.domains WHERE tenant_id='$SCHOOL' ORDER BY (type='primary') DESC LIMIT 1")
SC_FQDN=$(PG "SELECT fqdn FROM core.domains WHERE id='$SC_DOMAIN'")
AMIT=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
[ -n "$TV_DOMAIN" ] && [ -n "$SC_DOMAIN" ] && [ -n "$AMIT" ] && pass "both seed organisations have a domain ($TV_FQDN, $SC_FQDN)" \
    || { fail "seed data missing"; exit 1; }

# In the SCHOOL: a personal-looking mail ID that must never surface on Techvein's page.
PG "INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part, type, quota_bytes)
    VALUES ('$SCHOOL', '$SC_DOMAIN', '$LEAK@$SC_FQDN', '$LEAK', 'shared', 1048576)" >/dev/null
# In TECHVEIN: a shared mailbox Amit can open, with an alias pointing at it.
PG "INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part, type, display_name, quota_bytes)
    VALUES ('$TECHVEIN', '$TV_DOMAIN', '$PROBE@$TV_FQDN', '$PROBE', 'shared', 'Probe $RUN', 1048576)" >/dev/null
PROBE_ID=$(PG "SELECT id FROM mail.mailboxes WHERE local_part='$PROBE'")
PG "INSERT INTO mail.mailbox_permissions (mailbox_id, user_id, permission) VALUES ('$PROBE_ID', '$AMIT', 'send_as')" >/dev/null
PG "INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address)
    VALUES ('$TECHVEIN', '$TV_DOMAIN', '$PROBE_ID', '$ALIAS@$TV_FQDN')" >/dev/null
same "the school's planted mail ID is in the database" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE local_part='$LEAK' AND tenant_id='$SCHOOL'")" "1"
same "Techvein's probe mailbox, its grant and its alias are in" \
    "$(PG "SELECT count(*) FROM mail.mailbox_permissions WHERE mailbox_id='$PROBE_ID'")/$(PG "SELECT count(*) FROM mail.aliases WHERE target_mailbox_id='$PROBE_ID'")" "1/1"

step "1. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }

PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as an operator who belongs to the SCHOOL" || { fail "operator sign-in failed"; exit 1; }

OV="/api/admin/organisations/$TECHVEIN/overview"
MB="/api/admin/organisations/$TECHVEIN/mailboxes"
T0=$(PG "SELECT now()")

step "2. The organisation's own owner has no route to it"
r=$(call "$OV" "$OWNER");  same "owner reading the overview" "$(status "$r")" "403"
r=$(call "$MB" "$OWNER");  same "owner reading the mail IDs" "$(status "$r")" "403"
r=$(curl -s -w "\n%{http_code}" "$API$OV"); same "nobody at all" "$(status "$r")" "401"

step "3. The operator's counts are Techvein's counts"
r=$(call "$OV" "$OPERATOR"); OVB=$(body "$r")
same "answers 200" "$(status "$r")" "200"
same "the name is Techvein's" "$(jq_ "$OVB" "d['org']['id']")" "$TECHVEIN"
same "personal mail IDs" "$(jq_ "$OVB" "d['counts']['personalMailboxes']")" \
    "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$TECHVEIN' AND type='user'")"
same "shared mail IDs (includes the probe)" "$(jq_ "$OVB" "d['counts']['sharedMailboxes']")" \
    "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$TECHVEIN' AND type='shared'")"
same "domains" "$(jq_ "$OVB" "d['counts']['domains']")" "$(PG "SELECT count(*) FROM core.domains WHERE tenant_id='$TECHVEIN'")"
same "people" "$(jq_ "$OVB" "d['counts']['users']")" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$TECHVEIN'")"
same "active aliases" "$(jq_ "$OVB" "d['counts']['aliases']")" \
    "$(PG "SELECT count(*) FROM mail.aliases WHERE tenant_id='$TECHVEIN' AND is_active")"
# The calibration: the school's numbers differ, so equal numbers above are not
# just "whatever tenant the operator is in".
r=$(call "/api/admin/organisations/$SCHOOL/overview" "$OPERATOR"); SCB=$(body "$r")
same "the school's own page counts ITS shared mail IDs" "$(jq_ "$SCB" "d['counts']['sharedMailboxes']")" \
    "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$SCHOOL' AND type='shared'")"

step "4. Nothing of the school's appears on Techvein's page"
hasnt "the school's domain is not among Techvein's" "$OVB" "\"$SC_FQDN\""
hasnt "the school's planted mail ID is not in Techvein's overview" "$OVB" "$LEAK"
r=$(call "$MB?q=$LEAK" "$OPERATOR")
same "searching Techvein for the school's address answers 200" "$(status "$r")" "200"
same "…and finds nothing" "$(jq_ "$(body "$r")" "d['total']")" "0"
r=$(call "/api/admin/organisations/$SCHOOL/mailboxes?q=$LEAK" "$OPERATOR")
same "the SAME search against the school finds it — so the 0 above is the guard, not the search" \
    "$(jq_ "$(body "$r")" "d['total']")" "1"
r=$(call "$MB?limit=200" "$OPERATOR"); ALLB=$(body "$r")
same "the full list's total is Techvein's mailbox count" "$(jq_ "$ALLB" "d['total']")" \
    "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$TECHVEIN'")"
hasnt "…and the school's address is not on it" "$ALLB" "$LEAK"

step "5. The shared mailbox says who can open it; the alias sits on its box"
same "the probe lists Amit with send-as" \
    "$(jq_ "$OVB" "[a['permission'] for s in d['sharedMailboxes'] if s['address'].startswith('$PROBE@') for a in s['access'] if a['email']=='amit@techvein.local'][0]")" "send_as"
r=$(call "$MB?q=$PROBE&type=shared" "$OPERATOR"); PB=$(body "$r")
same "searching for the probe finds exactly one" "$(jq_ "$PB" "d['total']")" "1"
same "…carrying its alias" "$(jq_ "$PB" "d['items'][0]['aliases'][0]")" "$ALIAS@$TV_FQDN"
same "…and its display name" "$(jq_ "$PB" "d['items'][0]['name']")" "Probe $RUN"
r=$(call "$MB?q=$PROBE&type=user" "$OPERATOR")
same "the type filter bites: as a personal mail ID it is not there" "$(jq_ "$(body "$r")" "d['total']")" "0"
hasnt "no message content is anywhere in the answers (no subject field)" "$OVB$ALLB" "\"subject\""

step "6. Nonsense is refused, and an unknown organisation is a 404"
r=$(call "$MB?type=admin" "$OPERATOR");   same "type=admin" "$(status "$r")" "400"
r=$(call "$MB?status=gone" "$OPERATOR");  same "status=gone" "$(status "$r")" "400"
r=$(call "/api/admin/organisations/00000000-0000-0000-0000-00000000dead/overview" "$OPERATOR")
same "an organisation that does not exist" "$(status "$r")" "404"
r=$(call "$MB?limit=100000" "$OPERATOR")
same "a huge page is clamped to 200" "$(jq_ "$(body "$r")" "d['limit']")" "200"

step "7. It is written down, in Techvein's own log, marked platform:"
# Techvein's overview was opened once (step 3); the owner's 403s wrote nothing.
same "one overview view for Techvein" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.detail_viewed' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")" "1"
BEFORE=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.mail_ids_viewed' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")
r=$(call "$MB?limit=1&offset=1" "$OPERATOR")
same "turning a page answers 200" "$(status "$r")" "200"
same "…and writes no new row" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.mail_ids_viewed' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")" "$BEFORE"
# Searches that reached the database under Techvein: steps 4 (x2), 5 (x2), 6
# (the clamp). The two 400s were refused before any read.
same "every new Techvein list or search is logged (5)" "$BEFORE" "5"
same "the school's search is in the SCHOOL's log, not Techvein's" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.mail_ids_viewed' AND tenant_id='$SCHOOL' AND occurred_at > '$T0'")" "1"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
