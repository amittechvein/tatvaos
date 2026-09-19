#!/usr/bin/env bash
#
# TatvaOS Connect - "Mute all guests" / "Mute everyone" (Amit, 19 Sept 2026).
#
# WHAT THIS CAN AND CANNOT PROVE. There is no LiveKit on the laptop or in CI,
# so nothing here mutes a microphone. WHO a press reaches is proved in
# tests/connect-devices (MuteAllTargets). This file proves the door:
#
#   2. who may press it: nobody 401, a colleague with no role 403, no meeting 404
#   3. an unknown 'who' is refused in words, never guessed at
#   4. with the media server unreachable the answer is 502 "nobody was muted",
#      and NO audit row claims a mute. "0 muted" there would tell a host the
#      room was already quiet.
#
# The real thing - a room, a guest talking, one press - is a phone test with
# Amit, and is listed as not done until it is.
#
# Setup is tests/orgapi/test-org-api.sh's. Build first:
#   dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_MUTEALL_TEST_PORT:-5084}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/mute-all-$$"
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
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
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

step "1. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
HOST=$(signin "+919999900001")
[ -n "$HOST" ] && pass "signed in as the person who will host" || { fail "host sign-in failed"; exit 1; }
OTHER=$(signin "+919999900002")
[ -n "$OTHER" ] && pass "signed in as a colleague who holds no role in the meeting" || { fail "colleague sign-in failed"; exit 1; }

r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"Mute all $RUN\",\"kind\":\"instant\"}")
MEETING=$(jq_ "$(body "$r")" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
[ -n "$MEETING" ] && pass "the host made a meeting" || { fail "no meeting: $(brief "$r")"; exit 1; }
MUTE="/api/connect/meetings/$MEETING/mute-all"
T0=$(PG "SELECT now()")
audits() { PG "SELECT count(*) FROM core.audit_logs WHERE action='connect.participants.muted_all' AND target_id='$MEETING' AND occurred_at > '$T0'"; }

step "2. Who may press it"
r=$(curl -s -w "\n%{http_code}" -X POST "$API$MUTE" -H "Content-Type: application/json" -d '{"who":"guests"}')
same "nobody at all" "$(status "$r")" "401"
r=$(call POST "$MUTE" "$OTHER" '{"who":"guests"}')
same "a colleague with no role in the meeting" "$(status "$r")" "403"
r=$(call POST "/api/connect/meetings/00000000-0000-0000-0000-00000000dead/mute-all" "$HOST" '{"who":"guests"}')
same "a meeting that does not exist" "$(status "$r")" "404"

step "3. What it may be asked"
r=$(call POST "$MUTE" "$HOST" '{"who":"cohosts"}')
same "an unknown 'who' is refused, not guessed at" "$(status "$r")" "400"
has  "…in words" "$(body "$r")" "Mute the guests, or everyone."

step "4. With no media server, it says so instead of saying 'done'"
# This laptop runs no LiveKit. The honest answer is 502 and NO audit row:
# "0 muted" here would tell a host the room was already quiet.
r=$(call POST "$MUTE" "$HOST" '{"who":"guests"}')
same "the host, guests: the media server did not answer" "$(status "$r")" "502"
has  "…and it says nobody was muted" "$(body "$r")" "nobody was muted"
r=$(call POST "$MUTE" "$HOST" '{"who":"everyone"}')
same "the host, everyone: the same" "$(status "$r")" "502"
r=$(call POST "$MUTE" "$HOST" '{}')
same "no 'who' at all means guests, and reaches the same place" "$(status "$r")" "502"
same "nothing above wrote an audit row claiming a mute" "$(audits)" "0"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
