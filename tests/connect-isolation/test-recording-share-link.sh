#!/usr/bin/env bash
#
# TatvaOS Connect - the anonymous recording-share link, walked (decision 0007).
#
# WHY. connect.recording_share_password_failures arrived on main with
# recording sharing and no EF filter; tests/tenant-filters caught it on the
# 27 Sept merge. It is read on a path that starts with NO session:
# POST /api/connect/shared/{token}. Mr. Singh, 27 Sept: "Walk it, then filter
# it." This is the walk, for real:
#
#   1. a host shares a READY recording as a password link
#   2. a stranger (no session) opens it: no password -> 401 needsPassword;
#      a wrong one -> 401 and ONE failure row counted, for the right
#      organisation; the right one -> 200 and a playback ticket
#   3. the ticket renews (POST /shared/renew, also anonymous)
#   4. the host's share list reports that one wrong password - the ONLY EF read
#      of the failures table, and the one the new filter guards
#   5. nothing anywhere read without a tenant ("Tenant context was not resolved")
#
# MUTATE_BYPASS_RLS=1 TATVAOS_SUPER_PW=<local postgres password> runs the API as
# a role that skips row-level security, and plants a failure row for the SAME
# share tagged as ANOTHER organisation. Then only the EF filter keeps it out of
# the host's count: with the filter the count stays 1; without it, 2.
#
# No media server: a ready recording is planted, and the ticket is only issued.
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_SHARE_WALK_TEST_PORT:-5103}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/share-walk-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

# TATVAOS_PG_DB: the database, tatvaos_mail unless set. Set it to run against a
# fresh database of your own when other sessions' APIs share tatvaos_mail
# (their workers take this test's rows; found 1 Oct 2026).
PGDB="${TATVAOS_PG_DB:-tatvaos_mail}"
WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d $PGDB -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d $PGDB -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }
# A whole SQL FILE on stdin: a /c/... path handed to wsl is mangled by Git Bash.
PGFILE() {
    local base="${TATVAOS_PSQL% -Atc}"
    base="${base/docker exec /docker exec -i }"
    $base -v ON_ERROR_STOP=1 -q < "$1" 2>&1 | grep -v "^wsl:" | grep -vE "^(psql:[^ ]*: )?NOTICE:" | grep -v "^$"
}

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
    elif printf "%s" "$2" | grep -qF "$3"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}
# call METHOD PATH TOKEN [JSON]
call() {
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3"
    fi
}
# signin PHONE -> access token
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=$PGDB;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

API_PID=""
cleanup() {

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



step "0. The database answers ($TATVAOS_PG_HOST)"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
pass "psql answers"
# The three test phones, made true every run (tests/support/test-phones.sh).
. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }

step "1. Start the API"
LK_KEY="testkey"; LK_SECRET="test-secret-at-least-32-characters-long"
export LiveKit__ApiKey="$LK_KEY" LiveKit__ApiSecret="$LK_SECRET"
# Sharing is switched on per server; open it for Techvein only, the narrowest
# way (ConnectShareEndpoints.SharingOpenFor). Configuration, nothing to restore.
export Connect__RecordingSharingTestTenants="11111111-1111-1111-1111-111111111111"
# The download ticket signs with Jwt:SigningKey from configuration (production
# sets it); JWT_SIGNING_KEY above is what token issuing reads. Test value.
export Jwt__SigningKey="dev-only-key-at-least-32-characters-long"
if [ "${MUTATE_BYPASS_RLS:-0}" = "1" ]; then
    export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=$PGDB;Username=postgres;Password=${TATVAOS_SUPER_PW:?set TATVAOS_SUPER_PW to the LOCAL postgres password};Pooling=true"
    printf "  *** RLS BYPASSED: only the EF filter keeps another organisation's failure rows out of step 4. ***\n"
fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
printf "  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

anon() { curl -s -w "\n%{http_code}" -X POST "$API/api/connect/shared/$1" -H "Content-Type: application/json" \
            -H "X-Forwarded-For: 10.11.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))" -d "$2"; }

step "2. A host shares a ready recording as a password link"
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
HOST=$(signin "+919999900001")
[ -n "$HOST" ] && pass "the host signed in" || { fail "host sign-in failed"; exit 1; }
r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"Share walk $RUN\",\"kind\":\"instant\",\"waitingRoom\":\"off\"}")
MEETING=$(jq_ "$(body "$r")" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
[ -n "$MEETING" ] && pass "the host made a meeting" || { fail "no meeting: $(brief "$r")"; exit 1; }
REC=$(PG "WITH x AS (INSERT INTO connect.recordings (meeting_id, egress_id, mode, status, file_name, size_bytes) VALUES ('$MEETING', 'EG_share_$RUN', 'audio', 'ready', 'share-$RUN.ogg', 1234) RETURNING id) SELECT id FROM x")
[ -n "$REC" ] && pass "a ready recording exists" || { fail "could not plant the recording"; exit 1; }
PW="Walk-$RUN-correct"
r=$(call POST "/api/connect/meetings/$MEETING/recordings/$REC/shares" "$HOST" "{\"level\":\"password\",\"days\":7,\"password\":\"$PW\"}")
URL=$(jq_ "$(body "$r")" "d.get('url') or ''")
TOKEN=${URL##*/connect/shared/}
[ -n "$URL" ] && [ "$TOKEN" != "$URL" ] && pass "a password link was made" || { fail "no link: $(brief "$r")"; exit 1; }
SHARE=$(jq_ "$(body "$r")" "d.get('id') or ''")

step "3. A stranger with no session opens it"
r=$(anon "$TOKEN" "{}")
same "no password: 401, asks for one" "$(status "$r")/$(jq_ "$(body "$r")" "d.get('needsPassword')")" "401/True"
r=$(anon "$TOKEN" "{\"password\":\"wrong-$RUN\"}")
same "a wrong password: 401" "$(status "$r")" "401"
same "...and ONE failure is counted, for Techvein" "$(PG "SELECT count(*) || '/' || count(*) FILTER (WHERE tenant_id = '11111111-1111-1111-1111-111111111111') FROM connect.recording_share_password_failures WHERE share_id = '$SHARE'")" "1/1"
r=$(anon "$TOKEN" "{\"password\":\"$PW\"}")
same "the right password: 200" "$(status "$r")" "200"
TICKET=$(jq_ "$(body "$r")" "d.get('ticket') or (d.get('playback') or {}).get('ticket') or ''")
[ -n "$TICKET" ] && pass "...with a playback ticket" || fail "no ticket in: $(brief "$r")"
r=$(curl -s -w "\n%{http_code}" -X POST "$API/api/connect/shared/renew" -H "Content-Type: application/json" -d "{\"ticket\":\"$TICKET\"}")
same "the ticket renews (anonymous too)" "$(status "$r")" "200"

step "4. The host's share list reports the wrong password (the filtered read)"
if [ "${MUTATE_BYPASS_RLS:-0}" = "1" ]; then
    PG "INSERT INTO connect.recording_share_password_failures (tenant_id, share_id, created_at) VALUES ('22222222-2222-2222-2222-222222222222', '$SHARE', now())" >/dev/null
    same "(a failure row tagged as ABC School is planted for the same share)" "$(PG "SELECT count(*) FROM connect.recording_share_password_failures WHERE share_id = '$SHARE'")" "2"
fi
LIST=$(body "$(call GET "/api/connect/meetings/$MEETING/recordings/$REC/shares" "$HOST")")
same "wrongPasswords24h is 1 - this organisation's failures only" \
    "$(printf '%s' "$LIST" | SID="$SHARE" "$PY" -c "import sys,json,os; d=json.load(sys.stdin); s=[x for x in d['shares'] if x['id']==os.environ['SID']][0]; print(s.get('wrongPasswords24h'))" | tr -d '\r')" "1"

if grep -q "Tenant context was not resolved" "$LOG"; then
    fail "a read ran with no tenant: $(grep -m1 "Tenant context was not resolved" "$LOG" | head -c 300)"
else
    pass "no read anywhere in this run hit a filter without a tenant"
fi
PG "DELETE FROM connect.meetings WHERE id = '$MEETING'" >/dev/null

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
