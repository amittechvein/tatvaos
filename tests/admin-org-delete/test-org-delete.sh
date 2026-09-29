#!/usr/bin/env bash
#
# Deleting an organisation for good (Amit, 29 Sept 2026). What is proved:
#
#   * only a platform operator has the route; the organisation's owner does not
#   * REFUSED unless suspended first, and suspended at least 24 hours (a
#     setting that can be raised, never lowered below 24); unless the name
#     typed is the name; if it
#     was ever invoiced; if an operator belongs to it; if it is the operator's
#     own; if it is the house personal accounts live in — by the API, and by
#     the database function when called directly
#   * the numbers shown before are the numbers in the database
#   * afterwards NOTHING names the organisation: rows that cascade, rows a
#     cascade could trip over (job openings), rows a cascade never reaches
#     (share grants with no foreign key), and the sign-up it came from
#   * the app's own role cannot DELETE an organisation directly; only the
#     function can (Mr. Singh, 29 Sept 2026)
#   * a table nobody handled STOPS the deletion and rolls all of it back
#     (a probe table with no foreign key is made for the purpose)
#   * the two other organisations are untouched, and a line in ANOTHER
#     organisation's access log stays
#   * files: Space folder, recording and DKIM key removed; another
#     organisation's recording and a look-alike key (a.com vs a.com.au) are
#     NOT; the mail folder is left, recorded, and the domain cannot be
#     registered again until it is marked removed
#
# Setup as tests/admin-org-detail: WSL or Docker Postgres with the seed, the
# API built in Release, the operator is principal@abcschool.local made
# super_admin for the run and put back on exit.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ORGDELETE_TEST_PORT:-5094}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/org-delete-$$"
mkdir -p "$SCRATCH/blobs" "$SCRATCH/vmail" "$SCRATCH/dkim" "$SCRATCH/recordings"
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
# PGE keeps what the database SAID when it refused, which PG throws away.
PGE() { $TATVAOS_PSQL "$1" 2>&1 | grep -v "^wsl:" | tr -d "\r" | tr "\n" " "; }

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
there()  { if [ -e "$2" ]; then pass "$1"; else fail "$1 — not on disk: $2"; fi; }
gone()   { if [ -e "$2" ]; then fail "$1 — STILL on disk: $2"; else pass "$1"; fi; }
call() { curl -s -w "\n%{http_code}" -X GET "$API$1" -H "Authorization: Bearer $2"; }
# callm METHOD PATH TOKEN [JSON]
callm() {
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3"
    fi
}
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
# House rule 13: a run through tests/lib/throwaway-db.sh (PR 359) supplies
# its own database as TDB_CONN; the shared tatvaos_mail is only the fallback.
export ConnectionStrings__Postgres="${TDB_CONN:-Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true}"
export Smtp__Host=localhost Smtp__Port=5870
export Personal__PhoneHashKey="test-only-phone-hash-key-at-least-32-characters"
export Oidc__KeyDirectory="$(winpath "$SCRATCH/keys")"
# Every folder the deletion touches is a folder of this run's own.
export Space__BlobRoot="$(winpath "$SCRATCH/blobs")"
export Mail__VmailRoot="$(winpath "$SCRATCH/vmail")"
export Dkim__KeyDirectory="$(winpath "$SCRATCH/dkim")"
export Connect__Recording__OutputDirectory="$(winpath "$SCRATCH/recordings")"
export Connect__Recording__ReadDirectory="$(winpath "$SCRATCH/recordings")"

NAME="Delete Me $RUN"
NAME2="Delete Me Again $RUN"
FQDN="delete-me-$RUN.test"
API_PID=""; PRINCIPAL_WAS=""; ORG=""; ORG2=""
WAIT_WAS=""
cleanup() {
    if [ -n "$WAIT_WAS" ]; then
        PG "UPDATE core.platform_settings SET value='$WAIT_WAS' WHERE key='organisations.delete_after_suspended_hours'" >/dev/null
    fi
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    PG "DROP TABLE IF EXISTS core.zz_delete_probe" >/dev/null
    # Whatever the run left: its organisations (the invoice first, which is
    # RESTRICT), the rows planted in Techvein, and its deletion records.
    for o in "$ORG" "$ORG2"; do
        [ -z "$o" ] && continue
        PG "DELETE FROM core.invoices WHERE tenant_id='$o'" >/dev/null
        PG "DELETE FROM hire.job_openings WHERE tenant_id='$o'" >/dev/null
        PG "DELETE FROM core.tenants WHERE id='$o'" >/dev/null
        PG "DELETE FROM connect.recording_share_grants WHERE subject_tenant_id='$o'" >/dev/null
        PG "DELETE FROM connect.recording_access_log WHERE subject_tenant_id='$o'" >/dev/null
    done
    PG "DELETE FROM connect.meetings WHERE code='tvdel-$RUN'" >/dev/null
    PG "DELETE FROM core.signup_drafts WHERE org_name IN ('$NAME','$NAME2')" >/dev/null
    PG "DELETE FROM core.organisation_deletions WHERE name IN ('$NAME','$NAME2')" >/dev/null
    PG "DELETE FROM core.audit_logs WHERE action='platform:organisation.deleted' AND after_state::text LIKE '%tvdel-$RUN%'" >/dev/null
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

step "0. The database answers, and has the deletion functions (${TDB_NAME:-${TATVAOS_PG_HOST:-}})"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
pass "psql answers"
same "core.delete_organisation exists" "$(PG "SELECT count(*) FROM pg_proc WHERE proname='delete_organisation'")" "1"
same "…and nobody but the app's role may call it" \
    "$(PG "SELECT has_function_privilege('public', 'core.delete_organisation(uuid,text,uuid,text,text[])', 'EXECUTE')")" "f"
same "the app cannot write a deletion record of its own" \
    "$(PG "SELECT has_table_privilege('tatvaos_app', 'core.organisation_deletions', 'INSERT')")/$(PG "SELECT has_table_privilege('tatvaos_app', 'core.organisation_deletions', 'DELETE')")" "f/f"
PLAN=$(PG "SELECT id FROM core.plans ORDER BY name LIMIT 1")
AMIT=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
PRINCIPAL=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
[ -n "$PLAN" ] && [ -n "$AMIT" ] && [ -n "$PRINCIPAL" ] && pass "seed data is here" || { fail "seed data missing"; exit 1; }

step "1. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
# A fresh database (rule 13) has the operator-to-be without a phone number.
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as an operator who belongs to the SCHOOL" || { fail "operator sign-in failed"; exit 1; }

step "2. An organisation is made, and filled with one of everything"
r=$(callm POST "/api/admin/organisations" "$OPERATOR" "{\"name\":\"$NAME\",\"type\":\"business\",\"country\":\"IN\",\"adminName\":\"Test Admin\",\"adminEmail\":\"admin@$FQDN\",\"primaryDomain\":\"$FQDN\",\"planId\":\"$PLAN\",\"storageModel\":\"pooled\",\"maxUsers\":5,\"pooledStorageBytes\":1073741824}")
same "the operator creates it" "$(status "$r")" "201"
ORG=$(PG "SELECT id FROM core.tenants WHERE name='$NAME'")
[ -n "$ORG" ] || { fail "the organisation is not in the database"; exit 1; }
DOMAIN=$(PG "SELECT id FROM core.domains WHERE tenant_id='$ORG' AND fqdn='$FQDN'")
PLATFORM_FQDN=$(PG "SELECT fqdn FROM core.domains WHERE tenant_id='$ORG' AND is_platform")
same "it has its own domain and a platform one" "$(PG "SELECT count(*) FROM core.domains WHERE tenant_id='$ORG'")" "2"

PG "INSERT INTO core.users (tenant_id, domain_id, email, display_name, role, status) VALUES ('$ORG','$DOMAIN','person@$FQDN','Test Person','org_owner','active')" >/dev/null
PERSON=$(PG "SELECT id FROM core.users WHERE email='person@$FQDN'")
PG "INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part, type, quota_bytes) VALUES ('$ORG','$DOMAIN','person@$FQDN','person','user',1048576)" >/dev/null
PG "INSERT INTO connect.meetings (tenant_id, code, title, created_by_user_id) VALUES ('$ORG','tvdel-$RUN-a','Probe','$PERSON')" >/dev/null
MEETING=$(PG "SELECT id FROM connect.meetings WHERE code='tvdel-$RUN-a'")
PG "INSERT INTO connect.recordings (meeting_id, egress_id, status, file_name) VALUES ('$MEETING','EG_del_$RUN','ready','del-$RUN.mp4')" >/dev/null
printf "x" > "$SCRATCH/recordings/del-$RUN.mp4"

# In TECHVEIN: a meeting and a recording of its own, shared WITH the new
# organisation's person. The grant has no foreign key to tenants or users.
PG "INSERT INTO connect.meetings (tenant_id, code, title, created_by_user_id) VALUES ('$TECHVEIN','tvdel-$RUN','Techvein probe','$AMIT')" >/dev/null
TV_MEETING=$(PG "SELECT id FROM connect.meetings WHERE code='tvdel-$RUN'")
PG "INSERT INTO connect.recordings (meeting_id, egress_id, status, file_name) VALUES ('$TV_MEETING','EG_keep_$RUN','ready','keep-$RUN.mp4')" >/dev/null
TV_REC=$(PG "SELECT id FROM connect.recordings WHERE egress_id='EG_keep_$RUN'")
printf "x" > "$SCRATCH/recordings/keep-$RUN.mp4"
PG "INSERT INTO connect.recording_shares (tenant_id, recording_id, meeting_id, level, created_by_user_id) VALUES ('$TECHVEIN','$TV_REC','$TV_MEETING','named','$AMIT')" >/dev/null
TV_SHARE=$(PG "SELECT id FROM connect.recording_shares WHERE recording_id='$TV_REC'")
PG "INSERT INTO connect.recording_share_grants (tenant_id, share_id, subject_user_id, subject_tenant_id) VALUES ('$TECHVEIN','$TV_SHARE','$PERSON','$ORG')" >/dev/null
PG "INSERT INTO connect.recording_access_log (tenant_id, recording_id, share_id, level, subject_user_id, subject_tenant_id) VALUES ('$TECHVEIN','$TV_REC','$TV_SHARE','named','$PERSON','$ORG')" >/dev/null
same "Techvein's grant TO the new organisation is in" "$(PG "SELECT count(*) FROM connect.recording_share_grants WHERE subject_tenant_id='$ORG'")" "1"
same "…and Techvein's access-log line about its person" "$(PG "SELECT count(*) FROM connect.recording_access_log WHERE subject_tenant_id='$ORG'")" "1"

# What a cascade could trip over: an opening held by RESTRICT to a location.
PG "INSERT INTO core.locations (tenant_id, name) VALUES ('$ORG','Probe office')" >/dev/null
PG "INSERT INTO core.designations (tenant_id, title) VALUES ('$ORG','Probe role')" >/dev/null
PG "INSERT INTO hire.job_openings (tenant_id, title, location_id, designation_id)
    VALUES ('$ORG','Probe opening',(SELECT id FROM core.locations WHERE tenant_id='$ORG' LIMIT 1),(SELECT id FROM core.designations WHERE tenant_id='$ORG' LIMIT 1))" >/dev/null
same "a job opening tied to a location" "$(PG "SELECT count(*) FROM hire.job_openings WHERE tenant_id='$ORG' AND location_id IS NOT NULL")" "1"

# The sign-up it came from.
PG "INSERT INTO core.signup_drafts (org_name, admin_name, admin_email, verification_token, converted_tenant_id, completed_at)
    VALUES ('$NAME','Test Admin','admin@$FQDN','tok-$RUN','$ORG', now())" >/dev/null
same "its sign-up draft" "$(PG "SELECT count(*) FROM core.signup_drafts WHERE converted_tenant_id='$ORG'")" "1"

# Files.
mkdir -p "$SCRATCH/blobs/$ORG/2026/09" "$SCRATCH/blobs/$TECHVEIN/2026/09" "$SCRATCH/vmail/$FQDN/person/cur"
printf "x" > "$SCRATCH/blobs/$ORG/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
printf "x" > "$SCRATCH/blobs/$TECHVEIN/2026/09/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
printf "x" > "$SCRATCH/vmail/$FQDN/person/cur/1.eml"
printf "k" > "$SCRATCH/dkim/$FQDN.tv2026a.key"
printf "k" > "$SCRATCH/dkim/$FQDN.au.tv2026a.key"      # another domain's: $FQDN.au
printf "k" > "$SCRATCH/dkim/other-$RUN.test.tv2026a.key"

USERS_TV=$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$TECHVEIN'")
USERS_SC=$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$SCHOOL'")
BOXES_TV=$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$TECHVEIN'")
MEET_TV=$(PG "SELECT count(*) FROM connect.meetings WHERE tenant_id='$TECHVEIN'")
AUDIT_TV=$(PG "SELECT count(*) FROM core.audit_logs WHERE tenant_id='$TECHVEIN'")
RECORDS0=$(PG "SELECT count(*) FROM core.organisation_deletions")

step "2b. The app's own role cannot delete an organisation directly"
# As the API's database role, not the owner. Before 29 Sept it could: any
# bug that reached a tenant DELETE removed an organisation with every check
# in core.delete_organisation skipped.
e=$(PGE "SET ROLE tatvaos_app; DELETE FROM core.tenants WHERE id='$ORG'")
has  "a direct DELETE as tatvaos_app is refused" "$e" "permission denied"
same "…and the organisation is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"
same "the app role holds no DELETE on core.tenants" "$(PG "SELECT has_table_privilege('tatvaos_app','core.tenants','DELETE')")" "f"
same "…while the function it calls runs as its owner (SECURITY DEFINER)" \
    "$(PG "SELECT prosecdef FROM pg_proc WHERE proname='delete_organisation'")" "t"

step "3. Who may even ask"
PV="/api/admin/organisations/$ORG/deletion-preview"
DEL="/api/admin/organisations/$ORG/delete"
GOOD="{\"typedName\":\"$NAME\",\"reason\":\"tvdel-$RUN\"}"
r=$(call "$PV" "$OWNER");              same "an organisation's owner reading the preview" "$(status "$r")" "403"
r=$(callm POST "$DEL" "$OWNER" "$GOOD"); same "an organisation's owner pressing delete" "$(status "$r")" "403"
r=$(call "/api/admin/organisation-deletions" "$OWNER"); same "an organisation's owner reading the records" "$(status "$r")" "403"
r=$(curl -s -w "\n%{http_code}" -X POST "$API$DEL" -H "Content-Type: application/json" -d "$GOOD"); same "nobody at all" "$(status "$r")" "401"
same "after all that, it is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"

step "4. Refused: not suspended"
r=$(call "$PV" "$OPERATOR"); B=$(body "$r")
same "the preview answers 200" "$(status "$r")" "200"
same "…and says it cannot be deleted" "$(jq_ "$B" "d['canDelete']")" "False"
has  "…because it is not suspended" "$B" "TVD03"
r=$(callm POST "$DEL" "$OPERATOR" "$GOOD")
same "pressing delete anyway answers 409" "$(status "$r")" "409"
has  "…with the reason" "$(body "$r")" "Suspend the organisation first"
same "it is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"
r=$(callm POST "/api/admin/organisations/$ORG/suspend" "$OPERATOR"); same "suspended" "$(status "$r")" "200"

step "4b. Refused: suspended less than 24 hours ago"
WAIT_WAS=$(PG "SELECT value FROM core.platform_settings WHERE key='organisations.delete_after_suspended_hours'")
same "the wait is a setting, 24 by default" "$WAIT_WAS" "24"
r=$(call "$PV" "$OPERATOR"); B=$(body "$r")
same "just suspended: the preview says it cannot be deleted" "$(jq_ "$B" "d['canDelete']")" "False"
has  "…because of the wait" "$B" "TVD10"
has  "…and says from when it can" "$B" "It can be deleted from"
r=$(callm POST "$DEL" "$OPERATOR" "$GOOD")
same "pressing delete anyway answers 409" "$(status "$r")" "409"
same "it is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"
e=$(PGE "SELECT core.delete_organisation('$ORG','$NAME','$PRINCIPAL',NULL,'{}')")
has  "the database function refuses by itself" "$e" "It can be deleted from"
# 23 hours: still refused. 25: allowed (checked in step 8).
PG "UPDATE core.tenants SET suspended_at = now() - interval '23 hours' WHERE id='$ORG'" >/dev/null
r=$(call "$PV" "$OPERATOR"); has "suspended 23 hours ago: still refused" "$(body "$r")" "TVD10"
# The setting RAISES the wait...
PG "UPDATE core.tenants SET suspended_at = now() - interval '30 hours' WHERE id='$ORG'" >/dev/null
PG "UPDATE core.platform_settings SET value='48' WHERE key='organisations.delete_after_suspended_hours'" >/dev/null
r=$(call "$PV" "$OPERATOR"); has "raised to 48, suspended 30 hours ago: refused" "$(body "$r")" "TVD10"
# ...and cannot LOWER it below 24.
PG "UPDATE core.tenants SET suspended_at = now() - interval '2 hours' WHERE id='$ORG'" >/dev/null
PG "UPDATE core.platform_settings SET value='1' WHERE key='organisations.delete_after_suspended_hours'" >/dev/null
r=$(call "$PV" "$OPERATOR"); has "set to 1, suspended 2 hours ago: still refused (24 is the floor)" "$(body "$r")" "TVD10"
PG "UPDATE core.platform_settings SET value='soon' WHERE key='organisations.delete_after_suspended_hours'" >/dev/null
r=$(call "$PV" "$OPERATOR"); has "set to nonsense: read as 24, still refused" "$(body "$r")" "TVD10"
PG "DELETE FROM core.platform_settings WHERE key='organisations.delete_after_suspended_hours'" >/dev/null
r=$(call "$PV" "$OPERATOR"); has "setting missing altogether: 24, still refused" "$(body "$r")" "TVD10"
PG "INSERT INTO core.platform_settings (key, value) VALUES ('organisations.delete_after_suspended_hours', '$WAIT_WAS')" >/dev/null
# From here the organisation has waited its day.
PG "UPDATE core.tenants SET suspended_at = now() - interval '25 hours' WHERE id='$ORG'" >/dev/null
r=$(call "$PV" "$OPERATOR"); hasnt "suspended 25 hours ago: the wait no longer stands in the way" "$(body "$r")" "TVD10"

step "5. Refused: the name"
r=$(callm POST "$DEL" "$OPERATOR" "{\"typedName\":\"Delete Me\"}")
same "a name that is nearly right answers 400" "$(status "$r")" "400"
r=$(callm POST "$DEL" "$OPERATOR" "{}")
same "no name at all answers 400" "$(status "$r")" "400"
e=$(PGE "SELECT core.delete_organisation('$ORG','nearly','$PRINCIPAL',NULL,'{}')")
has  "the database function refuses a wrong name by itself" "$e" "does not match"
e=$(PGE "SELECT core.delete_organisation('$ORG','$NAME','$AMIT',NULL,'{}')")
has  "…and refuses a caller who is not an operator" "$e" "Only an active platform operator"
e=$(PGE "SELECT core.delete_organisation('$ORG','$NAME','$PRINCIPAL',NULL,ARRAY['techvein.local'])")
has  "…and refuses mail folders named for somebody else's domain" "$e" "does not hold"
same "it is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"

step "6. Refused: invoiced, the operator's own, the personal house"
PG "INSERT INTO core.invoices (tenant_id, number, financial_year, seq, issued_on, due_on, seller, buyer, place_of_supply, subtotal, total, created_by)
    VALUES ('$ORG','ZZ/2026-27/9999','2026-27',9999,current_date,current_date,'{}','{}','10',100,100,'$PRINCIPAL')" >/dev/null
same "an invoice is planted" "$(PG "SELECT count(*) FROM core.invoices WHERE tenant_id='$ORG'")" "1"
r=$(call "$PV" "$OPERATOR"); has "the preview names the invoice" "$(body "$r")" "TVD07"
r=$(callm POST "$DEL" "$OPERATOR" "$GOOD")
same "delete answers 409" "$(status "$r")" "409"
has  "…because invoices are kept" "$(body "$r")" "tax records"
same "it is still there, with its people" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$ORG'")" "1"
PG "DELETE FROM core.invoices WHERE tenant_id='$ORG'" >/dev/null
same "the planted invoice is taken away again" "$(PG "SELECT count(*) FROM core.invoices WHERE tenant_id='$ORG'")" "0"

r=$(call "/api/admin/organisations/$SCHOOL/deletion-preview" "$OPERATOR"); B=$(body "$r")
has  "the school holds an operator" "$B" "TVD05"
has  "…and is the operator's own" "$B" "TVD06"
r=$(callm POST "/api/admin/organisations/$SCHOOL/delete" "$OPERATOR" "{\"typedName\":\"ABC School\"}")
same "deleting it answers 409" "$(status "$r")" "409"
same "the school is still there" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$SCHOOL'")" "1"
HOUSE=$(PG "SELECT id FROM core.tenants WHERE kind='personal_house'")
if [ -n "$HOUSE" ]; then
    r=$(call "/api/admin/organisations/$HOUSE/deletion-preview" "$OPERATOR")
    has "the personal house can never be deleted" "$(body "$r")" "TVD02"
else
    fail "there is no personal house in this database, so that refusal was not tried"
fi

step "7. A table nobody handled stops everything"
PG "CREATE TABLE core.zz_delete_probe (tenant_id uuid NOT NULL)" >/dev/null
PG "GRANT SELECT ON core.zz_delete_probe TO tatvaos_app" >/dev/null
PG "INSERT INTO core.zz_delete_probe VALUES ('$ORG')" >/dev/null
r=$(callm POST "$DEL" "$OPERATOR" "$GOOD")
same "delete answers 500" "$(status "$r")" "500"
has  "…naming the table left behind" "$(body "$r")" "core.zz_delete_probe.tenant_id"
same "NOTHING was deleted: the organisation" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")" "1"
same "…its person" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$ORG'")" "1"
same "…its job opening" "$(PG "SELECT count(*) FROM hire.job_openings WHERE tenant_id='$ORG'")" "1"
same "…Techvein's grant to it" "$(PG "SELECT count(*) FROM connect.recording_share_grants WHERE subject_tenant_id='$ORG'")" "1"
same "…and no record was written" "$(PG "SELECT count(*) FROM core.organisation_deletions")" "$RECORDS0"
there "its recording is still on disk" "$SCRATCH/recordings/del-$RUN.mp4"
there "its Space file is still on disk" "$SCRATCH/blobs/$ORG/2026/09/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PG "DROP TABLE core.zz_delete_probe" >/dev/null

step "8. What the screen shows before"
r=$(call "$PV" "$OPERATOR"); B=$(body "$r")
same "it can be deleted now" "$(jq_ "$B" "d['canDelete']")" "True"
same "people" "$(jq_ "$B" "d['counts']['people']")" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$ORG'")"
same "domains" "$(jq_ "$B" "d['counts']['domains']")" "2"
same "mail IDs" "$(jq_ "$B" "d['counts']['mailboxes']")" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$ORG'")"
same "meetings" "$(jq_ "$B" "d['counts']['meetings']")" "1"
same "recordings" "$(jq_ "$B" "d['counts']['recordings']")" "1"
same "the mail folder on disk is named" "$(jq_ "$B" "','.join(d['mailFolders'])")" "$FQDN"
same "…because the mail store was looked at, not out of caution" "$(jq_ "$B" "d['mailStoreSeen']")" "True"
same "the Space folder on disk is seen" "$(jq_ "$B" "d['spaceFolderOnDisk']")" "True"
has  "the full table list is there too" "$B" "core.subscriptions.tenant_id"
hasnt "no address of a person is in the preview" "$B" "person@$FQDN"

step "9. Deleted"
r=$(callm POST "$DEL" "$OPERATOR" "$GOOD"); B=$(body "$r")
same "delete answers 200" "$(status "$r")" "200"
same "…and says so" "$(jq_ "$B" "d['deleted']")" "True"
RECORD=$(jq_ "$B" "d['record']")
same "the organisation" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG'")0" "00"
same "its people" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$ORG'")0" "00"
same "its domains" "$(PG "SELECT count(*) FROM core.domains WHERE tenant_id='$ORG'")0" "00"
same "its mail IDs" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$ORG'")0" "00"
same "its meeting" "$(PG "SELECT count(*) FROM connect.meetings WHERE id='$MEETING'")0" "00"
same "its recording's row" "$(PG "SELECT count(*) FROM connect.recordings WHERE meeting_id='$MEETING'")0" "00"
same "its job opening, location and designation" \
    "$(PG "SELECT (SELECT count(*) FROM hire.job_openings WHERE tenant_id='$ORG') + (SELECT count(*) FROM core.locations WHERE tenant_id='$ORG') + (SELECT count(*) FROM core.designations WHERE tenant_id='$ORG')")0" "00"
same "its own audit log" "$(PG "SELECT count(*) FROM core.audit_logs WHERE tenant_id='$ORG'")0" "00"
same "its sign-up draft" "$(PG "SELECT count(*) FROM core.signup_drafts WHERE org_name='$NAME'")0" "00"
same "Techvein's grant to its person (no foreign key)" "$(PG "SELECT count(*) FROM connect.recording_share_grants WHERE subject_tenant_id='$ORG' OR subject_user_id='$PERSON'")0" "00"
same "nothing anywhere names it, except the one line kept on purpose" \
    "$(PG "SELECT core.organisation_row_counts('$ORG')::text")" '{"connect.recording_access_log.subject_tenant_id": 1}'

step "10. Everybody else is untouched"
same "Techvein's people" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$TECHVEIN'")" "$USERS_TV"
same "the school's people" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$SCHOOL'")" "$USERS_SC"
same "Techvein's mail IDs" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE tenant_id='$TECHVEIN'")" "$BOXES_TV"
same "Techvein's meetings" "$(PG "SELECT count(*) FROM connect.meetings WHERE tenant_id='$TECHVEIN'")" "$MEET_TV"
same "Techvein's audit log" "$(PG "SELECT count(*) FROM core.audit_logs WHERE tenant_id='$TECHVEIN'")" "$AUDIT_TV"
same "Techvein's recording and its share" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE id='$TV_SHARE'")" "1"
same "the line in Techvein's access log stays" "$(PG "SELECT count(*) FROM connect.recording_access_log WHERE tenant_id='$TECHVEIN' AND subject_tenant_id='$ORG'")" "1"

step "11. What is left to say it happened"
same "one record" "$(PG "SELECT count(*) FROM core.organisation_deletions WHERE id='$RECORD'")" "1"
same "…with the name" "$(PG "SELECT name FROM core.organisation_deletions WHERE id='$RECORD'")" "$NAME"
same "…who pressed it" "$(PG "SELECT deleted_by_email FROM core.organisation_deletions WHERE id='$RECORD'")" "principal@abcschool.local"
same "…both domains" "$(PG "SELECT cardinality(domains) FROM core.organisation_deletions WHERE id='$RECORD'")" "2"
same "…how many people there were" "$(PG "SELECT counts->>'core.users.tenant_id' FROM core.organisation_deletions WHERE id='$RECORD'")" "1"
same "…the reason given" "$(PG "SELECT reason FROM core.organisation_deletions WHERE id='$RECORD'")" "tvdel-$RUN"
hasnt "…and no person's address" "$(PG "SELECT row_to_json(d)::text FROM core.organisation_deletions d WHERE id='$RECORD'")" "person@$FQDN"
same "a line in the OPERATOR'S organisation's audit log" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE tenant_id='$SCHOOL' AND action='platform:organisation.deleted' AND target_id='$ORG'")" "1"
r=$(call "/api/admin/organisation-deletions" "$OPERATOR"); B=$(body "$r")
same "the records list answers 200" "$(status "$r")" "200"
has  "…and holds this one" "$B" "$RECORD"

step "12. Files"
gone  "its Space folder" "$SCRATCH/blobs/$ORG"
there "Techvein's Space file" "$SCRATCH/blobs/$TECHVEIN/2026/09/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
gone  "its recording" "$SCRATCH/recordings/del-$RUN.mp4"
there "Techvein's recording" "$SCRATCH/recordings/keep-$RUN.mp4"
gone  "its DKIM key" "$SCRATCH/dkim/$FQDN.tv2026a.key"
there "the key of $FQDN.au, which is somebody else's" "$SCRATCH/dkim/$FQDN.au.tv2026a.key"
there "an unrelated key" "$SCRATCH/dkim/other-$RUN.test.tv2026a.key"
there "its MAIL is still on disk (the API cannot remove it)" "$SCRATCH/vmail/$FQDN/person/cur/1.eml"
same  "…and the record says which folder" "$(PG "SELECT array_to_string(mail_dirs_pending, ',') FROM core.organisation_deletions WHERE id='$RECORD'")" "$FQDN"
same  "the record says the files were removed" "$(PG "SELECT (files_removed_at IS NOT NULL)::text FROM core.organisation_deletions WHERE id='$RECORD'")" "true"
same  "…one recording" "$(PG "SELECT files_removed->'recordings'->>'removed' FROM core.organisation_deletions WHERE id='$RECORD'")" "1"
r=$(callm POST "/api/admin/organisation-deletions/$RECORD/remove-files" "$OPERATOR"); B=$(body "$r")
same  "pressing remove-files again answers 200" "$(status "$r")" "200"
same  "…and finds the recording already gone" "$(jq_ "$B" "d['files']['recordings']['alreadyGone']")" "1"
there "Techvein's recording, still" "$SCRATCH/recordings/keep-$RUN.mp4"

step "13. The domain cannot come back while its mail is on disk"
NEW="{\"name\":\"$NAME2\",\"type\":\"business\",\"country\":\"IN\",\"adminName\":\"Test Admin\",\"adminEmail\":\"admin@$FQDN\",\"primaryDomain\":\"$FQDN\",\"planId\":\"$PLAN\",\"storageModel\":\"pooled\",\"maxUsers\":5,\"pooledStorageBytes\":1073741824}"
r=$(callm POST "/api/admin/organisations" "$OPERATOR" "$NEW")
same "registering it again answers 409" "$(status "$r")" "409"
has  "…and says why" "$(body "$r")" "was deleted"
same "no organisation was made" "$(PG "SELECT count(*) FROM core.tenants WHERE name='$NAME2'")0" "00"
e=$(PGE "INSERT INTO core.domains (tenant_id, fqdn, type) VALUES ('$TECHVEIN','$FQDN','alias')")
has  "the database refuses it by itself, whoever asks" "$e" "its mail is still on the server"
same "the platform name was free to reuse: it had no mail folder" \
    "$(PG "SELECT count(*) FROM core.organisation_deletions WHERE id='$RECORD' AND mail_dirs_pending @> ARRAY['$PLATFORM_FQDN']")0" "00"
# The mail server's job removes the folder and lists the domain as removed
# (infra/scripts/maildir-removals.sh --domain, PR 321). Listing it is enough
# for that one domain, before the record as a whole is done.
rm -rf "$SCRATCH/vmail/$FQDN"
same "held while pending and not removed" "$(PG "SELECT core.domain_mail_held('$FQDN')")" "t"
same "…held whatever the case it is asked in" "$(PG "SELECT core.domain_mail_held(upper('$FQDN'))")" "t"
PG "UPDATE core.organisation_deletions SET mail_dirs_removed = array_append(mail_dirs_removed, '$FQDN') WHERE id='$RECORD'" >/dev/null
same "once listed as removed: no longer held" "$(PG "SELECT core.domain_mail_held('$FQDN')")" "f"
same "…though the record as a whole is not marked done"     "$(PG "SELECT (mail_dirs_purged_at IS NULL)::text FROM core.organisation_deletions WHERE id='$RECORD'")" "true"
r=$(callm POST "/api/admin/organisations" "$OPERATOR" "$NEW")
same "once marked removed, the domain can be registered" "$(status "$r")" "201"
ORG2=$(PG "SELECT id FROM core.tenants WHERE name='$NAME2'")

step "14. The second one goes too, with no mail folder to leave"
r=$(callm POST "/api/admin/organisations/$ORG2/suspend" "$OPERATOR"); same "suspended" "$(status "$r")" "200"
PG "UPDATE core.tenants SET suspended_at = now() - interval '25 hours' WHERE id='$ORG2'" >/dev/null
r=$(callm POST "/api/admin/organisations/$ORG2/delete" "$OPERATOR" "{\"typedName\":\"  $NAME2  \",\"reason\":\"tvdel-$RUN\"}"); B=$(body "$r")
same "deleted (spaces around the typed name are forgiven)" "$(status "$r")" "200"
same "no mail folder is left pending" "$(jq_ "$B" "len(d['mailFoldersLeft'])")" "0"
same "gone" "$(PG "SELECT count(*) FROM core.tenants WHERE id='$ORG2'")0" "00"
r=$(call "/api/admin/organisations/$ORG2/deletion-preview" "$OPERATOR")
same "asking about it afterwards answers 404" "$(status "$r")" "404"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
