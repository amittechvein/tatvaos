#!/usr/bin/env bash
#
# TatvaOS Connect — email-invitation caps, per organisation (Amit, 19 Sept 2026).
#
# A 300-person meeting met "Invite at most 50 people at a time". The caps are
# now per organisation, and Amit's ruling is that ONLY the platform operator
# turns the dial. So, like the organisation API's suite, this one is mostly
# about what is REFUSED.
#
#   1. the migration re-runs clean (a deploy re-runs every file), and the
#      database's own CHECK refuses a number over the ceiling
#   2. an organisation's own owner cannot read or write the caps      -> 403
#   3. the operator reads the defaults for an organisation with no numbers
#   4. numbers that make no sense are refused, and nothing is stored
#   5. the operator's numbers are stored, and ENFORCED on the next invitation:
#      one over per-send is refused, exactly per-send is accepted, and the
#      per-meeting cap then refuses the rest
#   6. the organisation flipping its OWN Connect switch does not wipe the caps,
#      and making the caps row did not turn public recording links on
#   7. empty again means the default again
#   8. the other organisation was never touched, and it is in the audit trail
#
# Setup is tests/orgapi/test-org-api.sh's, deliberately the same: WSL Postgres
# (no Docker on the laptop), the API run from the Release build, OTP sign-in
# with the dev code. The operator is the seed school's principal, made
# super_admin for the run and put back on exit. There is no seeded operator,
# because a real one can only be made by BootstrapAdmin.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_CAPS_TEST_PORT:-5083}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/invitation-caps-$$"
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
# addresses N TAG -> {"emails":[N distinct addresses]}
addresses() {
    "$PY" -c "import json; print(json.dumps({'emails':['cap-$2-$RUN-%d@example.com' % i for i in range($1)]}))"
}
caps_row() {
    PG "SELECT coalesce(invite_max_per_request::text,'null')||'/'||coalesce(invite_max_per_meeting::text,'null') FROM connect.tenant_settings WHERE tenant_id='$TECHVEIN'"
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

API_PID=""; PRINCIPAL_WAS=""
cleanup() {
    # Put back everything this run arranged, whatever happened above.
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    PG "UPDATE connect.tenant_settings SET invite_max_per_request=NULL, invite_max_per_meeting=NULL WHERE tenant_id='$TECHVEIN'" >/dev/null
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

step "1. The migration re-runs clean"
out=$(PGFILE "$ROOT/local/postgres/init/20260919-connect-invitation-caps.sql")
[ -z "$out" ] && pass "a second run prints nothing but notices" || fail "the re-run said: $(brief "$out")"
same "both columns are there" \
    "$(PG "SELECT count(*) FROM information_schema.columns WHERE table_schema='connect' AND table_name='tenant_settings' AND column_name IN ('invite_max_per_request','invite_max_per_meeting')")" "2"
# The backstop itself, asked directly: the database refuses 2001 whoever asks.
PG "INSERT INTO connect.tenant_settings (tenant_id) VALUES ('$TECHVEIN') ON CONFLICT DO NOTHING" >/dev/null
PG "UPDATE connect.tenant_settings SET invite_max_per_request=NULL, invite_max_per_meeting=NULL WHERE tenant_id='$TECHVEIN'" >/dev/null
PG "UPDATE connect.tenant_settings SET invite_max_per_request=2001 WHERE tenant_id='$TECHVEIN'" >/dev/null
same "the CHECK refused 2001 on its own" "$(caps_row)" "null/null"
PG "UPDATE connect.tenant_settings SET invite_max_per_request=2000 WHERE tenant_id='$TECHVEIN'" >/dev/null
same "…and let 2000 through, so it is the CHECK and not a dead UPDATE" "$(caps_row)" "2000/null"
PG "UPDATE connect.tenant_settings SET invite_max_per_request=NULL WHERE tenant_id='$TECHVEIN'" >/dev/null

step "2. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }

PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as an operator who belongs to ANOTHER organisation" || { fail "operator sign-in failed"; exit 1; }

CAPS="/api/admin/organisations/$TECHVEIN/connect-invitation-caps"
# The database clock at the start, so step 9 counts THIS run's audit rows only.
T0=$(PG "SELECT now()")

step "3. The organisation's own owner has no route to the caps"
r=$(call GET "$CAPS" "$OWNER");                                         same "owner reading them" "$(status "$r")" "403"
r=$(call PUT "$CAPS" "$OWNER" '{"perRequest":2000,"perMeeting":2000}'); same "owner raising them" "$(status "$r")" "403"
same "…and nothing was stored" "$(caps_row)" "null/null"
r=$(curl -s -w "\n%{http_code}" "$API$CAPS");                           same "nobody at all" "$(status "$r")" "401"

step "4. The operator reads the defaults"
r=$(call GET "$CAPS" "$OPERATOR"); b=$(body "$r")
same "answers 200" "$(status "$r")" "200"
same "nothing stored per send"    "$(jq_ "$b" "d['perRequest']")" "None"
same "nothing stored per meeting" "$(jq_ "$b" "d['perMeeting']")" "None"
same "in force per send = the default"    "$(jq_ "$b" "d['effectivePerRequest']")" "$(jq_ "$b" "d['defaultPerRequest']")"
same "in force per meeting = the default" "$(jq_ "$b" "d['effectivePerMeeting']")" "$(jq_ "$b" "d['defaultPerMeeting']")"
r=$(call GET "/api/admin/organisations/00000000-0000-0000-0000-00000000dead/connect-invitation-caps" "$OPERATOR")
same "an organisation that does not exist" "$(status "$r")" "404"

step "5. Numbers that make no sense are refused, and nothing is stored"
for bad in '{"perRequest":0,"perMeeting":null}' '{"perRequest":null,"perMeeting":-1}' \
           '{"perRequest":2001,"perMeeting":null}' '{"perRequest":null,"perMeeting":2001}' \
           '{"perRequest":30,"perMeeting":20}'; do
    r=$(call PUT "$CAPS" "$OPERATOR" "$bad"); same "refused: $bad" "$(status "$r")" "400"
done
same "the row still holds no numbers" "$(caps_row)" "null/null"

step "6. The operator's numbers are stored and enforced"
r=$(call PUT "$CAPS" "$OPERATOR" '{"perRequest":3,"perMeeting":5}')
same "answers 200" "$(status "$r")" "200"
same "the database holds 3/5" "$(caps_row)" "3/5"

r=$(call POST "/api/connect/meetings" "$OWNER" "{\"title\":\"Caps $RUN\",\"kind\":\"instant\"}")
MEETING=$(jq_ "$(body "$r")" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
[ -n "$MEETING" ] && pass "the owner made a meeting" || { fail "no meeting: $(brief "$r")"; exit 1; }
INV="/api/connect/meetings/$MEETING/invitations"
count() { PG "SELECT count(*) FROM connect.meeting_invitations WHERE meeting_id='$MEETING'"; }

r=$(call POST "$INV" "$OWNER" "$(addresses 4 a)")
same "four in one send is refused" "$(status "$r")" "400"
has  "…and the refusal names THIS organisation's number" "$(body "$r")" "at most 3 people"
same "…and nobody was recorded" "$(count)" "0"

r=$(call POST "$INV" "$OWNER" "$(addresses 3 b)")
same "exactly three is accepted" "$(status "$r")" "200"
same "…and three were recorded" "$(count)" "3"

r=$(call POST "$INV" "$OWNER" "$(addresses 3 c)")
same "three more would make six: refused by the per-meeting cap" "$(status "$r")" "400"
has  "…naming 5" "$(body "$r")" "at most 5 email invitations"
same "…and still three recorded" "$(count)" "3"
r=$(call POST "$INV" "$OWNER" "$(addresses 2 d)")
same "two more makes exactly five: accepted" "$(status "$r")" "200"
same "…and five are recorded" "$(count)" "5"

step "7. The organisation's own Connect switch leaves the caps alone"
same "making the caps row did not turn public links on" \
    "$(PG "SELECT allow_public_recording_links FROM connect.tenant_settings WHERE tenant_id='$TECHVEIN'")" "f"
r=$(call PUT "/api/connect/settings" "$OWNER" '{"allowPublicRecordingLinks":false}')
same "the owner's own settings PUT still works" "$(status "$r")" "200"
same "…and the caps are still 3/5" "$(caps_row)" "3/5"

step "8. Empty again means the default again"
r=$(call PUT "$CAPS" "$OPERATOR" '{"perRequest":null,"perMeeting":null}'); b=$(body "$r")
same "answers 200" "$(status "$r")" "200"
same "in force per send is the default again" "$(jq_ "$b" "d['effectivePerRequest']")" "$(jq_ "$b" "d['defaultPerRequest']")"
r=$(call POST "$INV" "$OWNER" "$(addresses 4 e)")
same "four in one send, refused in step 6, is accepted now" "$(status "$r")" "200"
same "…and nine are recorded, past the old cap of five" "$(count)" "9"

step "9. Nobody else was touched, and it is written down"
same "the school holds no numbers from any of this" \
    "$(PG "SELECT count(*) FROM connect.tenant_settings WHERE tenant_id='$SCHOOL' AND (invite_max_per_request IS NOT NULL OR invite_max_per_meeting IS NOT NULL)")" "0"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:connect.settings.invitation_caps' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")
# Exactly two: the two PUTs that were accepted. The five refused ones and the
# owner's 403s must have written nothing under this action.
if [ "${n:-}" = "2" ]; then pass "the audit trail has them under Techvein, marked platform: as an operator act ($n rows)"
else fail "audit rows: [${n:-}] (wanted exactly 2)"; fi

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
