#!/usr/bin/env bash
#
# TatvaOS Connect - a guest proves a mobile number at the door (19 Sept 2026).
#
# Amit: "if any guest join give mobile verification via otp and if he join back
# to same meeting with same no direct entry count that person one time entry".
#
#   3. switch OFF: nothing has changed for anybody
#   4. switch ON, with no restart: the door asks, and a name alone is refused
#   5. only Indian mobile numbers are ever texted
#   6. a guest proves a number and gets in; the NUMBER is in neither table;
#      a code works once
#   7. coming back: the pass alone is direct entry, ANOTHER device proves the
#      number again - and both are the same ONE row
#   8. somebody else is somebody else, and one person's code is not another's
#   9. a code that is guessed at five times dies
#  10. a pass opens one meeting only
#  11. removed means removed, now for a guest too - by pass or by fresh code
#  12. one address cannot ask for texts all day (6 per 10 minutes)
#  13. five texts to one number for one meeting, ever
#
# No text is sent and no media server is used: sms.show_otp_on_screen puts the
# code in the answer, as the sign-in suites do. Both settings this suite
# touches are PUT BACK on exit, whatever happens.
#
# WHAT THIS CANNOT PROVE: that a real text arrives on a real phone, and that
# the page asks for the number. Both are Amit's to see.
#
# Setup is tests/orgapi/test-org-api.sh's. Build first:
#   dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_GUESTPHONE_TEST_PORT:-5086}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/guest-phone-$$"
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

SWITCH="connect.guest_phone_otp"
SHOW="sms.show_otp_on_screen"
setting() { PG "SELECT coalesce((SELECT value FROM core.platform_settings WHERE key='$1'),'<unset>')"; }
set_setting() { PG "INSERT INTO core.platform_settings (key, value) VALUES ('$1','$2') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null; }
restore_setting() {
    if [ "$2" = "<unset>" ]; then PG "DELETE FROM core.platform_settings WHERE key='$1'" >/dev/null
    else set_setting "$1" "$2"; fi
}
SWITCH_WAS=$(setting "$SWITCH"); SHOW_WAS=$(setting "$SHOW")
restore_all() { restore_setting "$SWITCH" "$SWITCH_WAS"; restore_setting "$SHOW" "$SHOW_WAS"; }
trap 'restore_all; cleanup' EXIT

# Every request from its own address unless a step says otherwise: the text
# route allows six per address per ten minutes, and this suite asks more often.
addr() { printf '10.8.%d.%d' $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
gpost() { # gpost PATH JSON [ADDRESS]
    curl -s -w "\n%{http_code}" -X POST "$API/api/connect/g/$1" -H "Content-Type: application/json" \
         -H "X-Forwarded-For: ${3:-$(addr)}" -d "$2"
}
rows()   { PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$MEETING' AND is_guest"; }
proved() { PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$MEETING' AND is_guest AND guest_phone_hash IS NOT NULL"; }
ago()    { PG "UPDATE connect.guest_otps SET sent_at = now() - interval '2 minutes' WHERE meeting_id='$MEETING'" >/dev/null; }
code_for() { # code_for PHONE -> the on-screen code (testing mode), after stepping past the resend wait
    ago
    local r; r=$(gpost "$CODE/otp" "{\"phone\":\"$1\"}")
    jq_ "$(body "$r")" "d.get('devCode') or ''"
}

step "0. The database answers ($TATVAOS_PG_HOST)"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
pass "psql answers"

step "1. The migration applies, and applies again"
out=$(PGFILE "$ROOT/local/postgres/init/20260919-b-connect-guest-phone.sql")
[ -z "$out" ] && pass "first run clean" || fail "first run said: $(brief "$out")"
out=$(PGFILE "$ROOT/local/postgres/init/20260919-b-connect-guest-phone.sql")
[ -z "$out" ] && pass "second run prints nothing but notices" || fail "the re-run said: $(brief "$out")"

step "2. Start the API and make a meeting"
export LiveKit__ApiKey="testkey" LiveKit__ApiSecret="test-secret-at-least-32-characters-long"
set_setting "$SWITCH" "false"; set_setting "$SHOW" "true"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
HOST=$(signin "+919999900001")
[ -n "$HOST" ] && pass "signed in as the host" || { fail "host sign-in failed"; exit 1; }
mk() { # mk TITLE -> "id code"
    local r b; r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"$1 $RUN\",\"kind\":\"instant\",\"waitingRoom\":\"off\",\"allowGuests\":true}"); b=$(body "$r")
    printf '%s %s' "$(jq_ "$b" "d.get('id') or ''")" "$(jq_ "$b" "d.get('code') or ''")"
}
read -r MEETING CODE <<<"$(mk "Guest phone")"
[ -n "$MEETING" ] && [ -n "$CODE" ] && pass "the host made a meeting" || { fail "no meeting"; exit 1; }

step "3. Switch OFF: nothing has changed for anybody"
r=$(curl -s -w "\n%{http_code}" "$API/api/connect/g/$CODE")
same "the door does not ask for a number" "$(jq_ "$(body "$r")" "d.get('phoneRequired')")" "False"
r=$(gpost "$CODE/join" '{"displayName":"Old-style guest"}')
same "a name alone still joins" "$(status "$r")" "200"
same "…with no pass handed out" "$(jq_ "$(body "$r")" "d.get('guestPass')")" "None"
same "…as one row with no number behind it" "$(rows)/$(proved)" "1/0"
r=$(gpost "$CODE/otp" '{"phone":"9876500001"}')
same "asking for a code while it is off is the one sentence" "$(status "$r")" "404"

step "4. Switch ON: the door asks, and a name alone is not enough"
set_setting "$SWITCH" "true"
r=$(curl -s -w "\n%{http_code}" "$API/api/connect/g/$CODE")
same "the door says a number is needed, with NO restart" "$(jq_ "$(body "$r")" "d.get('phoneRequired')")" "True"
r=$(gpost "$CODE/join" '{"displayName":"No number"}')
same "a name alone is refused" "$(status "$r")" "400"
same "…and told why, in a field a client can read" "$(jq_ "$(body "$r")" "d.get('phoneRequired')")" "True"
same "…and wrote no row" "$(rows)" "1"

step "5. Which numbers may be texted"
for bad in '12345' '5876543210' '+1 415 555 0100' '+44 7700 900123' ''; do
    r=$(gpost "$CODE/otp" "{\"phone\":\"$bad\"}"); same "refused: '$bad'" "$(status "$r")" "400"
done
same "none of those made a row to text" "$(PG "SELECT count(*) FROM connect.guest_otps WHERE meeting_id='$MEETING'")" "0"

step "6. A guest proves a number and gets in"
r=$(gpost "$CODE/otp" '{"phone":"98765 00001"}'); b=$(body "$r")
same "the code is sent" "$(status "$r")" "200"
has  "…and says where, four digits only" "$b" "ending 0001"
C1=$(jq_ "$b" "d.get('devCode') or ''")
[ ${#C1} -eq 6 ] && pass "testing mode shows a six-digit code" || fail "no code on screen: $(brief "$b")"
r=$(gpost "$CODE/otp" '{"phone":"9876500001"}')
same "asking again at once is told to wait" "$(status "$r")" "429"
r=$(gpost "$CODE/join" '{"displayName":"Ravi","phone":"9876500001","otp":"000000"}')
same "a wrong code is refused" "$(status "$r")" "400"
same "…and wrote no row" "$(rows)" "1"
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi\",\"phone\":\"+91 98765 00001\",\"otp\":\"$C1\"}"); b=$(body "$r")
same "the right code joins, however the number was typed" "$(status "$r")" "200"
PASS1=$(jq_ "$b" "d.get('guestPass') or ''")
[ -n "$PASS1" ] && pass "a rejoin pass is handed over" || fail "no pass: $(brief "$b")"
has  "the connection has its own identity (guest:{row}#{device})" "$(jq_ "$b" "d.get('identity')")" "#"
same "one new row, with a number behind it" "$(rows)/$(proved)" "2/1"
RAVI=$(PG "SELECT id FROM connect.participants WHERE meeting_id='$MEETING' AND guest_phone_hash IS NOT NULL")
same "THE NUMBER IS NOWHERE in either table" \
    "$(PG "SELECT (SELECT count(*) FROM connect.participants p WHERE p.meeting_id='$MEETING' AND p::text LIKE '%98765%') + (SELECT count(*) FROM connect.guest_otps o WHERE o.meeting_id='$MEETING' AND o::text LIKE '%98765%')")" "0"
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi\",\"phone\":\"9876500001\",\"otp\":\"$C1\"}")
same "the same code a second time is refused: single use" "$(status "$r")" "400"

step "7. Coming back: direct entry, and counted once"
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi K\",\"pass\":\"$PASS1\"}"); b=$(body "$r")
same "the pass alone joins: no number, no code, no text" "$(status "$r")" "200"
same "…still two rows: he is not counted again" "$(rows)" "2"
same "…on HIS row, with the name he gave this time" "$(PG "SELECT display_name FROM connect.participants WHERE id='$RAVI'")" "Ravi K"
C1B=$(code_for "9876500001")
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi (phone)\",\"phone\":\"9876500001\",\"otp\":\"$C1B\"}")
same "ANOTHER DEVICE, same number, proves it again and joins" "$(status "$r")" "200"
same "…and is still the same one row" "$(rows)/$(PG "SELECT count(*) FROM connect.participants WHERE id='$RAVI' AND display_name='Ravi (phone)'")" "2/1"

step "8. Somebody else is somebody else"
C2=$(code_for "9876500002")
r=$(gpost "$CODE/join" "{\"displayName\":\"Sita\",\"phone\":\"9876500002\",\"otp\":\"$C2\"}")
same "a second number joins" "$(status "$r")" "200"
same "…as a second proved row" "$(rows)/$(proved)" "3/2"
r=$(gpost "$CODE/join" "{\"displayName\":\"Thief\",\"phone\":\"9876500002\",\"otp\":\"$C1B\"}")
same "Ravi's code does not open Sita's number" "$(status "$r")" "400"

step "9. A code that is guessed at dies"
C3=$(code_for "9876500003")
for n in 1 2 3 4 5; do r=$(gpost "$CODE/join" '{"displayName":"Guesser","phone":"9876500003","otp":"111111"}'); done
same "the fifth wrong guess is refused like the first" "$(status "$r")" "400"
r=$(gpost "$CODE/join" "{\"displayName\":\"Guesser\",\"phone\":\"9876500003\",\"otp\":\"$C3\"}")
same "…and now even the RIGHT code is dead" "$(status "$r")" "400"
same "…no row was ever written for that number" "$(rows)" "3"

step "10. A pass is for one meeting"
read -r M2 CODE2 <<<"$(mk "Other meeting")"
r=$(gpost "$CODE2/join" "{\"displayName\":\"Ravi\",\"pass\":\"$PASS1\"}")
same "Ravi's pass does not open another meeting" "$(status "$r")" "400"
same "…which still has no guests" "$(PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$M2' AND is_guest")" "0"

step "11. Removed means removed, now for a guest too"
PG "INSERT INTO connect.meeting_blocks (id, meeting_id, user_id, identity, display_name) VALUES (gen_random_uuid(), '$MEETING', NULL, 'guest:$RAVI', 'Ravi')" >/dev/null
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi\",\"pass\":\"$PASS1\"}")
same "his pass no longer opens the meeting" "$(status "$r")" "409"
has  "…and he is told why" "$(body "$r")" "removed from this meeting"
C1C=$(code_for "9876500001")
r=$(gpost "$CODE/join" "{\"displayName\":\"Ravi again\",\"phone\":\"9876500001\",\"otp\":\"$C1C\"}")
same "…nor does proving the number afresh" "$(status "$r")" "409"
same "…and he did not become a new row to get round it" "$(rows)" "3"

step "12. One address cannot ask for texts all day"
ONE="10.9.9.9"
for n in 1 2 3 4 5 6; do r=$(gpost "$CODE/otp" "{\"phone\":\"98765001$(printf '%02d' $n)\"}" "$ONE"); done
same "the sixth request from one address still goes" "$(status "$r")" "200"
r=$(gpost "$CODE/otp" '{"phone":"9876500199"}' "$ONE")
same "the seventh is refused by the limiter" "$(status "$r")" "429"

step "13. Five texts to one number, ever"
for n in 1 2 3 4; do C=$(code_for "9876500002"); done
ago; r=$(gpost "$CODE/otp" '{"phone":"9876500002"}')
same "the sixth text to Sita's number is refused" "$(status "$r")" "429"
same "…her count stands at five" "$(PG "SELECT max(sends) FROM connect.guest_otps WHERE meeting_id='$MEETING'")" "5"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
