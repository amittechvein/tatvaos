#!/usr/bin/env bash
#
# TatvaOS Connect - the per-meeting guest ceiling (19 Sept 2026).
#
# THE INCIDENT THIS REPRODUCES. During a live company-wide meeting, people
# opening the link were told "This meeting link does not work." The meeting was
# active and unlocked and the door (GET /api/connect/g/{code}) answered 200.
# The cause was PerMeetingGuestCeiling = 200 in ConnectGuestEndpoints: it
# counts guest ROWS, every join or reload writes one, and past 200 every new
# guest got the one sentence - with nothing logged anywhere.
#
#   2. an ordinary guest gets in
#   3. a meeting holding 200 guest rows still admits the next person, while the
#      door answers 200 as it did in production
#   4. the ceiling is still a ceiling: one over it is refused with the one
#      sentence, writes no row - and now writes a WARNING saying why
#
# No media server is needed: a join MINTS a token, it does not connect.
# Setup is tests/orgapi/test-org-api.sh's. Build first:
#   dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_CEILING_TEST_PORT:-5085}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/guest-ceiling-$$"
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

# What the code under test is expected to do. Overridable only so the red can
# be produced on purpose (house rule 6): with the constant put back to 200,
# run with nothing changed here and step 3 must fail.
CEILING="${TATVAOS_GUEST_CEILING:-2000}"
WANT_AT_200="200"
ROWS_AFTER_200="201"

step "0. The database answers ($TATVAOS_PG_HOST)"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
pass "psql answers"

step "1. Start the API and make a meeting"
# A key and a secret so a join token can be MINTED; no media server is needed
# for that, and nothing here connects to one. Test values, not anybody's.
export LiveKit__ApiKey="testkey" LiveKit__ApiSecret="test-secret-at-least-32-characters-long"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
HOST=$(signin "+919999900001")
[ -n "$HOST" ] && pass "signed in as the host" || { fail "host sign-in failed"; exit 1; }

r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"Ceiling $RUN\",\"kind\":\"instant\",\"waitingRoom\":\"off\",\"allowGuests\":true}")
b=$(body "$r")
MEETING=$(jq_ "$b" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
CODE=$(jq_ "$b" "d.get('code') or (d.get('meeting') or {}).get('code') or ''")
[ -n "$MEETING" ] && [ -n "$CODE" ] && pass "the host made a meeting with a code" || { fail "no meeting: $(brief "$r")"; exit 1; }
guests() { PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$MEETING' AND is_guest"; }
gjoin() { curl -s -w "\n%{http_code}" -X POST "$API/api/connect/g/$CODE/join" -H "Content-Type: application/json" -H "X-Forwarded-For: 10.7.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))" -d "{\"displayName\":\"$1\"}"; }
fill() { # fill TO -> top the meeting up to TO guest rows, straight in the table
    PG "INSERT INTO connect.participants (id, meeting_id, user_id, display_name, role, is_guest, identity, created_at)
        SELECT g, '$MEETING', NULL, 'filler', 'participant', true, 'guest:'||g, now()
          FROM (SELECT gen_random_uuid() AS g FROM generate_series(1, greatest(0, $1 - (SELECT count(*) FROM connect.participants WHERE meeting_id='$MEETING' AND is_guest))::int)) x" >/dev/null
}

step "2. An ordinary guest gets in"
r=$(gjoin "First guest")
same "the first guest joins" "$(status "$r")" "200"
same "…and is one row" "$(guests)" "1"

step "3. The 19 September meeting: 200 guest rows, and the 201st person"
fill 200
same "the meeting holds 200 guest rows" "$(guests)" "200"
r=$(curl -s -w "\n%{http_code}" "$API/api/connect/g/$CODE")
same "the DOOR still answers 200, exactly as production did" "$(status "$r")" "200"
r=$(gjoin "Person 201")
same "the 201st guest now JOINS (this is the fix; it was 404)" "$(status "$r")" "$WANT_AT_200"
same "…and the row count says so" "$(guests)" "$ROWS_AFTER_200"

step "4. The ceiling is still a ceiling"
fill "$CEILING"
same "topped up to the ceiling" "$(guests)" "$CEILING"
r=$(gjoin "One too many")
same "one over the ceiling is refused" "$(status "$r")" "404"
has  "…with the one sentence a stranger ever hears" "$(body "$r")" "This meeting link does not work."
same "…and no row was written for them" "$(guests)" "$CEILING"
if grep -q "guest join REFUSED by the per-meeting ceiling" "$LOG"; then pass "…and THIS time the log says why"
else fail "the refusal wrote no warning: the silence that cost a live meeting is back"; fi

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
