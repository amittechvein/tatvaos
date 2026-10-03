#!/usr/bin/env bash
# ============================================================================
#  Recording sharing — the nine-case matrix, run rather than reasoned about
# ============================================================================
#
#  docs/CONNECT_DECISIONS.md §3 made this matrix the condition for switching
#  recording sharing on: "run, against a deployed system, with the output
#  kept". This script is that run for a LOCAL API against a database built
#  from local/postgres/init. It is not the production run — that is still owed
#  and is what §3 asks for — but it is the same nine cases, and it is how the
#  production run should be done.
#
#  Every case asserts the thing happening, not only its aftermath: a refusal
#  is checked beside a control that succeeds under the same conditions, so a
#  route that refuses EVERYTHING cannot pass (the empty=empty trap in
#  docs/HOUSE_RULES.md). Calibrated by breaking the code on purpose — see the
#  PR for which mutations turned which checks red.
#
#  Needs: the API built (dotnet build -c Release apps/api/TatvaOS.Api.csproj),
#  a Postgres with every init file applied, python, curl.
#
#  Environment:
#    TATVAOS_TEST_DB     database name              (default tatvaos_mail)
#    TATVAOS_PSQL        how to run psql -Atc       (default: WSL's psql)
#    TATVAOS_SHARE_PORT  API port                   (default 5141)
# ============================================================================

set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_SHARE_PORT:-5141}"
SMTP_PORT=$((PORT + 20000))
API="http://localhost:$PORT"
DB="${TATVAOS_TEST_DB:-tatvaos_mail}"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/recording-share-$$"
mkdir -p "$SCRATCH/recordings" "$SCRATCH/mail"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # WSL stops its VM seconds after the last wsl process exits, and Postgres
    # with it. Hold one open for the whole run.
    wsl -e sleep 3600 >/dev/null 2>&1 &
    WSL_KEEPALIVE=$!
    sleep 2
    TATVAOS_PSQL="wsl -u postgres -e psql -d $DB -Atc"
    TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | awk '{print $1}' | tr -d '\r\n')}"
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
# same/has/hasnt refuse an empty comparison: "" = "" is not a pass.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif printf "%s" "$2" | grep -qF -- "$3"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}
hasnt() {
    if [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif printf "%s" "$2" | grep -qF -- "$3"; then fail "$1 — found [$3]"
    else pass "$1"; fi
}
CALLS=0
call() {   # METHOD PATH TOKEN [JSON]
    local auth=()
    [ -n "$3" ] && auth=(-H "Authorization: Bearer $3")
    # A fresh client address per request, so connect-shared-links (20/min
    # per address) never stands in for the check a case is really making.
    # The limiter itself is checked on its own, in section 10.
    CALLS=$((CALLS + 1))
    auth+=(-H "X-Forwarded-For: 192.0.2.$((CALLS % 250 + 1))")
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" "${auth[@]}" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" "${auth[@]}"
    fi
}
# The file behind a ticket: prints "<status> <body>".
fetch() { curl -s -w " %{http_code}" "$API/api/connect/recordings/file?t=$1"; }
fetch_status() { fetch "$1" | awk '{print $NF}'; }
signin() {
    # Up to three tries. The OTP request intermittently answers without a
    # devCode on a local stack (seen twice in ~15 runs, cause not found — it is
    # Core's code, outside this test). Each retry is SAID, on stderr, so a
    # stack where it never works still shows up rather than hiding behind this.
    local t tok
    for t in 1 2 3; do
        tok=$(signin_once "$1")
        [ -n "$tok" ] && { printf "%s" "$tok"; return; }
        printf "    sign-in for %s: retry %s\n" "$1" "$t" >&2
        sleep 2
    done
}
signin_once() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code req ver
    req=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}")
    code=$(jq_ "$req" "d.get('devCode') or ''")
    ver=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}")
    # Said out loud when it fails: the OTP throttle returns no devCode and
    # verify then answers with a PASSWORD error, which points the wrong way.
    [ -z "$(jq_ "$ver" "d.get('accessToken') or ''")" ] \
        && printf "    sign-in for %s: request said %s / verify said %s\n" "$1" "$(brief "$req")" "$(brief "$ver")" >&2
    jq_ "$ver" "d.get('accessToken') or ''"
}
token_of() { jq_ "$1" "d['url'].rsplit('/',1)[1]"; }
access_rows() { PG "SELECT count(*) FROM connect.recording_access_log WHERE share_id='$1'"; }

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf "%s" "$1"; fi; }

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
# The ticket signer reads Jwt:SigningKey and nothing else; production sets it
# as Jwt__SigningKey (docker-compose.base.yml). Without it every ticket is a 500.
export Jwt__SigningKey="$JWT_SIGNING_KEY"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=$DB;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=127.0.0.1 Smtp__Port=$SMTP_PORT
export Connect__PublicBaseUrl="http://localhost:3141"
export Connect__Recording__Enabled=true
# Sharing's own switch, OFF — the way production will be when the matrix
# runs there — with this run's organisation on the test allow-list, which is
# what lets it share at all (Mr. Singh's fix 2). The last section restarts the
# API with the allow-list empty and checks the routes refuse.
export Connect__RecordingSharingOffered="${TATVAOS_SHARING_OFFERED:-false}"
export Connect__RecordingSharingTestTenants="${TATVAOS_SHARING_TEST_TENANTS-$TECHVEIN}"
export Connect__Recording__OutputDirectory="$(winpath "$SCRATCH/recordings")"
export Connect__Recording__ReadDirectory="$(winpath "$SCRATCH/recordings")"
export Oidc__KeyDirectory="$(winpath "$SCRATCH")\\keys"

API_PID=""; SINK_PID=""; MEETING=""
cleanup() {
    # Put back everything this run changed, whatever happened above.
    PG "UPDATE core.tenants SET status='active' WHERE id='$TECHVEIN'" >/dev/null
    PG "UPDATE connect.tenant_settings SET allow_public_recording_links=false WHERE tenant_id='$TECHVEIN'" >/dev/null
    [ -n "$MEETING" ] && PG "UPDATE connect.recording_shares SET revoked_at=now() WHERE meeting_id='$MEETING' AND revoked_at IS NULL" >/dev/null
    for p in "$API_PID" "$SINK_PID"; do [ -n "$p" ] && kill "$p" >/dev/null 2>&1; done
    if command -v powershell.exe >/dev/null 2>&1; then
        for port in "$PORT" "$SMTP_PORT"; do
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; foreach (\$x in \$c) { Stop-Process -Id \$x.OwningProcess -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
        done
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
step "0. Set up: the API, four people, one meeting, two recordings"
# ----------------------------------------------------------------------------
"$PY" "$HERE/smtp-sink.py" "$SMTP_PORT" "$SCRATCH/mail" &
SINK_PID=$!
start_api() {
    dotnet run --no-build -c Release --project "$PROJ" >> "$LOG" 2>&1 &
    API_PID=$!
    for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
    curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200
}
stop_api() {
    kill "$API_PID" >/dev/null 2>&1
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue; foreach (\$x in \$c) { Stop-Process -Id \$x.OwningProcess -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
    fi
    for _ in $(seq 1 30); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
}
# REFUSE TO START ON AN OCCUPIED PORT. A stray API left by an earlier run
# held this port once (26 Sept): this run's own API could not bind, the old
# one answered with other settings, and the results — sign-ins failing,
# "Jwt:SigningKey is required" — pointed everywhere but at the cause.
if curl -s -o /dev/null --max-time 2 "$API/health" 2>/dev/null; then
    fail "something is already listening on $PORT — stop it (or set TATVAOS_SHARE_PORT) and run again"
    trap - EXIT; exit 1
fi
start_api && pass "API up" || { fail "API did not start"; tail -20 "$LOG"; exit 1; }

# The lookup limit counts this host's lookups over the last hour from the
# audit log, so a second run inside the hour would start near the limit. Age
# earlier runs' rows out of the window — as the database owner; the app role
# cannot touch the audit log, which is the point of it.
PG "UPDATE core.audit_logs SET occurred_at = occurred_at - interval '2 hours'
    WHERE action='connect.recording.share_lookup' AND occurred_at > now() - interval '1 hour'" >/dev/null

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
# The three test phones, made true every run (tests/support/test-phones.sh).
. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
PG "INSERT INTO core.users (tenant_id, email, display_name, role, status, phone)
    SELECT '$TECHVEIN', 'attendee@techvein.local', 'Attendee', 'employee', 'active', '+919999900004'
    WHERE NOT EXISTS (SELECT 1 FROM core.users WHERE email='attendee@techvein.local')" >/dev/null
PG "INSERT INTO connect.tenant_settings (tenant_id) VALUES ('$TECHVEIN') ON CONFLICT DO NOTHING" >/dev/null
PG "UPDATE connect.tenant_settings SET allow_public_recording_links=false WHERE tenant_id='$TECHVEIN'" >/dev/null

HOST=$(signin "+919999900001");      [ -n "$HOST" ]      && pass "host (Techvein owner) signed in"         || { fail "host sign-in"; exit 1; }
COLLEAGUE=$(signin "+919999900002"); [ -n "$COLLEAGUE" ] && pass "colleague (Techvein, not in the meeting)" || { fail "colleague sign-in"; exit 1; }
OUTSIDER=$(signin "+919999900003");  [ -n "$OUTSIDER" ]  && pass "outsider (another organisation)"         || { fail "outsider sign-in"; exit 1; }
ATTENDEE=$(signin "+919999900004");  [ -n "$ATTENDEE" ]  && pass "attendee (Techvein, in the meeting)"      || { fail "attendee sign-in"; exit 1; }

r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"Board review $RUN\",\"kind\":\"instant\"}")
MEETING=$(jq_ "$(body "$r")" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
[ -n "$MEETING" ] && pass "host made a meeting" || { fail "no meeting: $(brief "$r")"; exit 1; }

ATTENDEE_ID=$(PG "SELECT id FROM core.users WHERE email='attendee@techvein.local'")
HOST_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
PG "INSERT INTO connect.participants (meeting_id, user_id, display_name, identity, role)
    VALUES ('$MEETING', '$ATTENDEE_ID', 'Attendee', 'u-attendee-$RUN', 'participant')" >/dev/null
same "the attendee is in the room" "$(PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$MEETING' AND user_id='$ATTENDEE_ID'")" "1"

R1=$(PG "SELECT gen_random_uuid()"); R2=$(PG "SELECT gen_random_uuid()")
for R in "$R1" "$R2"; do
    printf "RECORDING-%s-%s" "$R" "$RUN" > "$SCRATCH/recordings/$R.mp4"
    PG "INSERT INTO connect.recordings (id, meeting_id, egress_id, mode, status, file_name, content_type, requested_by_user_id, size_bytes, started_at, ended_at)
        VALUES ('$R', '$MEETING', 'EG_$R', 'video', 'ready', '$R.mp4', 'video/mp4', '$HOST_ID', 60, now()-interval '1 hour', now())" >/dev/null
done
same "two ready recordings" "$(PG "SELECT count(*) FROM connect.recordings WHERE meeting_id='$MEETING' AND status='ready'")" "2"
R1_BYTES="RECORDING-$R1-$RUN"

SHARES="/api/connect/meetings/$MEETING/recordings/$R1/shares"

# ----------------------------------------------------------------------------
step "Capability: the Share button is offered to the host and nobody else"
# ----------------------------------------------------------------------------
r=$(call GET "/api/connect/meetings/$MEETING/recordings" "$HOST"); b=$(body "$r")
same "host's list carries the capability" "$(jq_ "$b" "','.join(d['sharing']['levels'])")" "organisation,named,password"
same "…with days left on each recording" "$(jq_ "$b" "str(d['items'][0]['shareDaysLeft'] >= 29)")" "True"
r=$(call GET "/api/connect/meetings/$MEETING/recordings" "$ATTENDEE"); b=$(body "$r")
same "a participant's list does not (control: same list, 200)" "$(status "$r"):$(jq_ "$b" "d.get('sharing')")" "200:None"

# ----------------------------------------------------------------------------
step "6. A participant with no share at all still reads the recording"
# ----------------------------------------------------------------------------
same "no share exists yet" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE recording_id='$R1'")" "0"
r=$(call GET "/api/connect/recordings/$R1/view" "$ATTENDEE"); b=$(body "$r")
same "the attendee opens it" "$(status "$r")" "200"
same "…as a participant, not through a share" "$(jq_ "$b" "d['via']")" "meeting"
T=$(jq_ "$b" "d['ticket']")
same "…and the bytes come back" "$(fetch "$T")" "$R1_BYTES 200"
r=$(call GET "/api/connect/recordings/$R1/view" "$COLLEAGUE")
same "control: a colleague who was NOT in the room is refused" "$(status "$r")" "404"
same "no access row for a participant" "$(PG "SELECT count(*) FROM connect.recording_access_log WHERE recording_id='$R1'")" "0"

# ----------------------------------------------------------------------------
step "1. A link holder with no session"
# ----------------------------------------------------------------------------
r=$(call POST "$SHARES" "$HOST" '{"level":"public","days":7}')
same "public refused while the organisation's switch is off" "$(status "$r")" "403"
r=$(call PUT "/api/connect/settings" "$COLLEAGUE" '{"allowPublicRecordingLinks":true}')
same "an employee cannot turn the switch on" "$(status "$r")" "403"
r=$(call PUT "/api/connect/settings" "$HOST" '{"allowPublicRecordingLinks":true}')
same "the owner can" "$(status "$r")" "200"
r=$(call POST "$SHARES" "$HOST" '{"level":"public","days":7}'); PUB=$(body "$r")
same "public share made (the expiry trigger no longer throws)" "$(status "$r")" "200"
PUB_ID=$(jq_ "$PUB" "d['id']"); PUB_TOKEN=$(token_of "$PUB")
has "its link is a /connect/shared/ URL" "$(jq_ "$PUB" "d['url']")" "/connect/shared/"

r=$(call POST "/api/connect/shared/$PUB_TOKEN" ""); b=$(body "$r")
same "public: opens with no session" "$(status "$r")" "200"
same "…as a link" "$(jq_ "$b" "d['via']+'/'+d['level']")" "link/public"
has "…with the meeting's title" "$(jq_ "$b" "d['title']")" "Board review $RUN"
PUB_TICKET=$(jq_ "$b" "d['ticket']")
same "…and the file behind it" "$(fetch "$PUB_TICKET")" "$R1_BYTES 200"

r=$(call POST "$SHARES" "$HOST" '{"level":"password","days":7,"password":"correct-horse"}'); PW=$(body "$r")
same "password share made" "$(status "$r")" "200"
PW_ID=$(jq_ "$PW" "d['id']"); PW_TOKEN=$(token_of "$PW")
r=$(call POST "/api/connect/shared/$PW_TOKEN" "")
same "password: no password asks for one" "$(status "$r"):$(jq_ "$(body "$r")" "d.get('needsPassword')")" "401:True"
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"wrong-horse"}')
same "password: the wrong one is refused" "$(status "$r")" "401"
has  "…saying so" "$(body "$r")" "did not open"
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"correct-horse"}'); b=$(body "$r")
same "password: the right one opens it" "$(status "$r")" "200"
same "…and the file behind it" "$(fetch "$(jq_ "$b" "d['ticket']")")" "$R1_BYTES 200"

r=$(call POST "$SHARES" "$HOST" '{"level":"organisation"}'); ORG=$(body "$r")
same "organisation share made" "$(status "$r")" "200"
ORG_ID=$(jq_ "$ORG" "d['id']")
has "its address is the recording's own page, not a token" "$(jq_ "$ORG" "d['url']")" "/connect/recordings/$R1"
r=$(call GET "/api/connect/recordings/$R1/view" "")
same "organisation: nothing without a session" "$(status "$r")" "401"
r=$(call POST "/api/connect/shared/AAAAAAAAAAAAAAAAAAAAAA" "")
same "a well-formed token that names nothing" "$(status "$r")" "404"
DEAD=$(body "$r")

r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST" '{"level":"password","days":7,"password":"short77"}')
same "a 7-character share password is refused" "$(status "$r")" "400"
has  "…saying eight" "$(body "$r")" "between 8 and 100"

# ----------------------------------------------------------------------------
step "10. Guessing a password link from many addresses (Mr. Singh, fix 1)"
# ----------------------------------------------------------------------------
# Every guess from a DIFFERENT address, so the per-address rate limit
# (connect-shared-links, 20/min) never sees more than one. Only a count kept
# against the LINK can stop this. Red first: with that count removed, all 25
# guesses answer 401 and the right password then opens the recording.
r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST" '{"level":"password","days":7,"password":"guess-me-if-you-can"}')
same "a password link on R2 (8 characters or more is fine)" "$(status "$r")" "200"
GUESS=$(body "$r"); GUESS_ID=$(jq_ "$GUESS" "d['id']"); GUESS_TOKEN=$(token_of "$GUESS")
codes=""
for i in $(seq 1 25); do
    c=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/shared/$GUESS_TOKEN" \
        -H "Content-Type: application/json" -H "X-Forwarded-For: 198.51.100.$i" \
        -d "{\"password\":\"guess-$i\"}")
    codes="$codes $c"
done
codes="${codes# }"
same "the first ten wrong guesses are simply wrong" "$(printf "%s" "$codes" | cut -d' ' -f1-10 | tr ' ' '\n' | sort -u)" "401"
same "the next fifteen, from fifteen new addresses, are refused" "$(printf "%s" "$codes" | cut -d' ' -f11-25 | tr ' ' '\n' | sort -u)" "429"
r=$(curl -s -w "\n%{http_code}" -X POST "$API/api/connect/shared/$GUESS_TOKEN" -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 203.0.113.9" -d '{"password":"guess-me-if-you-can"}')
same "the RIGHT password is refused too, from yet another address" "$(status "$r")" "429"
has  "…as a pause, not a dead link" "$(body "$r")" "paused"
same "only the ten guesses that reached the password were counted" "$(PG "SELECT count(*) FROM connect.recording_share_password_failures WHERE share_id='$GUESS_ID'")" "10"
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"correct-horse"}')
same "control: another password link, same caller, still opens — the pause is per link" "$(status "$r")" "200"
r=$(call GET "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST"); b=$(body "$r")
same "the host is told: paused" "$(jq_ "$b" "str(d['shares'][0]['passwordPausedUntil'] is not None)")" "True"
same "…and how many wrong passwords" "$(jq_ "$b" "d['shares'][0]['wrongPasswords24h']")" "10"
last=""
for i in $(seq 1 21); do
    last=$(curl -s -w "\n%{http_code}" -X POST "$API/api/connect/shared/AAAAAAAAAAAAAAAAAAAAAA" \
        -H "X-Forwarded-For: 203.0.113.77" -H "Content-Type: application/json" -d '{}')
done
same "the per-address limit still stands: a 21st request in the minute from one address" "$(status "$last")" "429"
hasnt "…and that refusal is the limiter, not a pause" "$(body "$last") " "paused"
same "a guess at an already-paused link writes nothing (still ten)" "$(PG "SELECT count(*) FROM connect.recording_share_password_failures WHERE share_id='$GUESS_ID'")" "10"
PG "UPDATE connect.recording_share_password_failures SET created_at = created_at - interval '61 minutes' WHERE share_id='$GUESS_ID'" >/dev/null
r=$(call POST "/api/connect/shared/$GUESS_TOKEN" "" '{"password":"guess-me-if-you-can"}')
same "an hour later the right password opens it again" "$(status "$r")" "200"
# The 30-day sweep. Age five of the ten past it and five just inside it.
PG "UPDATE connect.recording_share_password_failures SET created_at = now() - interval '31 days'
     WHERE id IN (SELECT id FROM connect.recording_share_password_failures WHERE share_id='$GUESS_ID' ORDER BY id LIMIT 5)" >/dev/null
PG "UPDATE connect.recording_share_password_failures SET created_at = now() - interval '29 days'
     WHERE share_id='$GUESS_ID' AND created_at > now() - interval '30 days'" >/dev/null
same "the sweep removes what is older than 30 days" "$(PG "SET ROLE tatvaos_app; SELECT connect.sweep_share_password_failures()")" "5"
same "…and keeps what is not" "$(PG "SELECT count(*) FROM connect.recording_share_password_failures WHERE share_id='$GUESS_ID'")" "5"

# ----------------------------------------------------------------------------
step "9. An anonymous read is logged — once per opening"
# ----------------------------------------------------------------------------
before=$(access_rows "$PUB_ID")
r=$(call POST "/api/connect/shared/$PUB_TOKEN" ""); T9=$(jq_ "$(body "$r")" "d['ticket']")
same "one opening adds one row" "$(access_rows "$PUB_ID")" "$((before + 1))"
row=$(PG "SELECT tenant_id||'|'||recording_id||'|'||level||'|'||coalesce(subject_user_id::text,'NULL')
            FROM connect.recording_access_log WHERE share_id='$PUB_ID' ORDER BY created_at DESC LIMIT 1")
same "…tenant, recording and level from the share, no person" "$row" "$TECHVEIN|$R1|public|NULL"
fetch "$T9" >/dev/null; fetch "$T9" >/dev/null
r=$(call POST "/api/connect/shared/renew" "" "{\"ticket\":\"$T9\"}")
same "renewing a share ticket works" "$(status "$r")" "200"
same "…and neither the file reads nor the renewal wrote a row" "$(access_rows "$PUB_ID")" "$((before + 1))"
r=$(call POST "/api/connect/shared/renew" "" "{\"ticket\":\"$T\"}")
same "a participant's ticket cannot be renewed here" "$(status "$r")" "404"

# ----------------------------------------------------------------------------
step "7. Named, across organisations"
# ----------------------------------------------------------------------------
r=$(call GET "/api/connect/recordings/$R1/view" "$OUTSIDER")
same "before any named share, the outsider is refused" "$(status "$r")" "404"
mails_before=$(ls "$SCRATCH/mail" | wc -l)
r=$(call POST "$SHARES" "$HOST" '{"level":"named","userIds":["principal@abcschool.local"]}'); NAMED=$(body "$r")
same "named share made" "$(status "$r")" "200"
NAMED_ID=$(jq_ "$NAMED" "d['id']")
same "…the person is marked as outside the organisation" "$(jq_ "$NAMED" "str(d['people'][0]['external'])")" "True"
same "…and no mail problem was reported" "$(status "$r"):$(jq_ "$NAMED" "str(d.get('mailNote'))")" "200:None"
sleep 1
mail=$(ls -t "$SCRATCH/mail" | head -1)
same "one email went out" "$(ls "$SCRATCH/mail" | wc -l | tr -d ' ')" "$((mails_before + 1))"
m=$(cat "$SCRATCH/mail/$mail" 2>/dev/null | tr -d '\r')
has "…to the named person" "$m" "principal@abcschool.local"
has "…carrying the recording's address" "$m" "/connect/recordings/$R1"
hasnt "…and no link token" "$m" "/connect/shared/"

r=$(call GET "/api/connect/recordings/$R1/view" "$OUTSIDER"); b=$(body "$r")
same "the outsider opens it" "$(status "$r")" "200"
same "…through the named share" "$(jq_ "$b" "d['via']+'/'+d['level']")" "share/named"
OUT_TICKET=$(jq_ "$b" "d['ticket']")
same "…and gets the bytes" "$(fetch "$OUT_TICKET")" "$R1_BYTES 200"
same "…logged with who they are" "$(PG "SELECT count(*) FROM connect.recording_access_log WHERE share_id='$NAMED_ID' AND subject_tenant_id='$SCHOOL'")" "1"
r=$(call GET "$SHARES" "$OUTSIDER")
same "the outsider cannot list who else it is shared with (API)" "$(status "$r")" "403"
r=$(call GET "$SHARES" "$HOST")
same "control: the host can, and sees four shares" "$(status "$r"):$(jq_ "$(body "$r")" "len(d['shares'])")" "200:4"
seen=$(PG "SET ROLE tatvaos_app; SELECT set_config('app.tenant_id','$SCHOOL',false); SELECT count(*) FROM connect.recording_share_grants WHERE share_id='$NAMED_ID'")
same "…nor as their own organisation in the database" "$seen" "0"
seen=$(PG "SET ROLE tatvaos_app; SELECT set_config('app.tenant_id','$TECHVEIN',false); SELECT count(*) FROM connect.recording_share_grants WHERE share_id='$NAMED_ID'")
same "control: the recording's organisation sees the grant" "$seen" "1"

r=$(call GET "/api/connect/recordings/$R1/view" "$COLLEAGUE"); b=$(body "$r")
same "the colleague now gets in through the organisation share" "$(status "$r"):$(jq_ "$b" "d['level']")" "200:organisation"
# Mr. Singh's point 4: the function reads the reader's organisation itself.
# There is no argument left that could claim the outsider is in Techvein.
same "the database will not match the outsider to the organisation share" \
    "$(PG "SELECT count(*) FROM connect.share_access_for_user('$R1', (SELECT id FROM core.users WHERE email='principal@abcschool.local')) WHERE level='organisation'")" "0"
same "control: …and does match the colleague" \
    "$(PG "SELECT count(*) FROM connect.share_access_for_user('$R1', (SELECT id FROM core.users WHERE email='hr@techvein.local')) WHERE level='organisation'")" "1"

r=$(call PUT "$SHARES/$NAMED_ID/people" "$HOST" '{"userIds":[]}')
same "the host removes the outsider from the list" "$(status "$r")" "200"
same "the outsider's ticket stops at once" "$(fetch_status "$OUT_TICKET")" "404"
r=$(call GET "/api/connect/recordings/$R1/view" "$OUTSIDER")
same "…and they can no longer open it" "$(status "$r")" "404"

# ----------------------------------------------------------------------------
step "11. Looking people up is limited and audited (Mr. Singh, point 2)"
# ----------------------------------------------------------------------------
lookups() { PG "SELECT count(DISTINCT target_id) FROM core.audit_logs WHERE action='connect.recording.share_lookup' AND actor_user_id='$HOST_ID' AND occurred_at > now() - interval '1 hour'"; }
same "the outsider's lookup is in the host organisation's audit log" \
    "$(PG "SELECT tenant_id||'|'||(after_state::jsonb->>'found') FROM core.audit_logs WHERE action='connect.recording.share_lookup' AND target_id='principal@abcschool.local' AND occurred_at > now() - interval '1 hour' ORDER BY occurred_at DESC LIMIT 1")" "$TECHVEIN|true"
r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST" "{\"level\":\"named\",\"userIds\":[\"nobody-$RUN@example.com\"]}")
same "a named share naming nobody real is refused" "$(status "$r")" "400"
same "…and left no share behind (lookups save as they go)" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE recording_id='$R2' AND level='named'")" "0"
same "…but the lookup was recorded, not-found" \
    "$(PG "SELECT after_state::jsonb->>'found' FROM core.audit_logs WHERE target_id='nobody-$RUN@example.com'")" "false"
used=$(lookups); need=$((30 - used))
batch=$("$PY" -c "import json; print(json.dumps({'userIds':['bulk-$RUN-%d@example.com' % i for i in range($need)]}))")
r=$(call PUT "$SHARES/$NAMED_ID/people" "$HOST" "$batch")
same "up to thirty new addresses in the hour are looked up (unknown, so 400)" "$(status "$r")" "400"
same "…thirty now on record" "$(lookups)" "30"
r=$(call PUT "$SHARES/$NAMED_ID/people" "$HOST" "{\"userIds\":[\"one-more-$RUN@example.com\"]}")
same "the thirty-first new address is refused" "$(status "$r")" "429"
same "…before it was looked up" "$(PG "SELECT count(*) FROM core.audit_logs WHERE target_id='one-more-$RUN@example.com'")" "0"
r=$(call PUT "$SHARES/$NAMED_ID/people" "$HOST" '{"userIds":["principal@abcschool.local"]}')
same "control: an address already looked up this hour costs nothing" "$(status "$r")" "200"
r=$(call PUT "$SHARES/$NAMED_ID/people" "$HOST" '{"userIds":["PRINCIPAL@abcschool.local","principal@abcschool.local"]}')
same "…and neither does somebody already on the share, in any case" "$(status "$r")" "200"
same "still thirty" "$(lookups)" "30"

# ----------------------------------------------------------------------------
step "5. A share for one recording never opens another"
# ----------------------------------------------------------------------------
r=$(call GET "/api/connect/recordings/$R2/view" "$COLLEAGUE")
same "colleague, organisation share on R1, asks for R2" "$(status "$r")" "404"
same "the ticket re-check says no for R2" "$(PG "SELECT connect.share_still_allows('$PUB_ID','$R2',NULL)")" "f"
same "control: …and yes for R1" "$(PG "SELECT connect.share_still_allows('$PUB_ID','$R1',NULL)")" "t"

# ----------------------------------------------------------------------------
step "8. Public links switched off while one is live"
# ----------------------------------------------------------------------------
r=$(call POST "/api/connect/shared/$PUB_TOKEN" ""); LIVE=$(jq_ "$(body "$r")" "d['ticket']")
same "control: the link works" "$(status "$r")" "200"
call PUT "/api/connect/settings" "$HOST" '{"allowPublicRecordingLinks":false}' >/dev/null
r=$(call POST "/api/connect/shared/$PUB_TOKEN" "")
same "switched off: the link stops" "$(status "$r")" "404"
same "…a ticket already in a player stops too" "$(fetch_status "$LIVE")" "404"
same "…the row is not deleted or revoked" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE id='$PUB_ID' AND revoked_at IS NULL")" "1"
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"correct-horse"}')
same "…and the password link is untouched by the switch" "$(status "$r")" "200"
call PUT "/api/connect/settings" "$HOST" '{"allowPublicRecordingLinks":true}' >/dev/null
r=$(call POST "/api/connect/shared/$PUB_TOKEN" "")
same "switched back on: it resumes" "$(status "$r")" "200"

# ----------------------------------------------------------------------------
step "4. A suspended organisation"
# ----------------------------------------------------------------------------
r=$(call POST "/api/connect/shared/$PUB_TOKEN" ""); SUSP=$(jq_ "$(body "$r")" "d['ticket']")
PG "UPDATE core.tenants SET status='suspended' WHERE id='$TECHVEIN'" >/dev/null
r=$(call POST "/api/connect/shared/$PUB_TOKEN" "")
same "public link refused" "$(status "$r")" "404"
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"correct-horse"}')
same "password link refused" "$(status "$r")" "404"
same "a ticket in a player refused" "$(fetch_status "$SUSP")" "404"
same "the organisation share refused (database)" "$(PG "SELECT count(*) FROM connect.share_access_for_user('$R1', (SELECT id FROM core.users WHERE email='hr@techvein.local'))")" "0"
PG "UPDATE core.tenants SET status='active' WHERE id='$TECHVEIN'" >/dev/null
r=$(call POST "/api/connect/shared/$PUB_TOKEN" "")
same "control: active again, the same link opens" "$(status "$r")" "200"

# ----------------------------------------------------------------------------
step "3. An expired share"
# ----------------------------------------------------------------------------
PG "UPDATE connect.recording_shares SET expires_at = now() - interval '1 minute' WHERE id='$PW_ID'" >/dev/null
r=$(call POST "/api/connect/shared/$PW_TOKEN" "" '{"password":"correct-horse"}')
same "refused, even with the right password" "$(status "$r")" "404"
same "…in exactly the words of a link that never existed" "$(body "$r")" "$DEAD"

# ----------------------------------------------------------------------------
step "2. A revoked share"
# ----------------------------------------------------------------------------
r=$(call POST "/api/connect/shared/$PUB_TOKEN" ""); REV=$(jq_ "$(body "$r")" "d['ticket']")
same "control: the link works before revoking" "$(fetch_status "$REV")" "200"
r=$(call DELETE "$SHARES/$PUB_ID" "$HOST")
same "the host stops sharing" "$(status "$r")" "204"
r=$(call POST "/api/connect/shared/$PUB_TOKEN" "")
same "refused" "$(status "$r")" "404"
same "…in the same words" "$(body "$r")" "$DEAD"
same "…a ticket in a player stops at once" "$(fetch_status "$REV")" "404"
r=$(call POST "/api/connect/shared/renew" "" "{\"ticket\":\"$REV\"}")
same "…and cannot be renewed" "$(status "$r")" "404"
same "revoking kept the row" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE id='$PUB_ID' AND revoked_at IS NOT NULL")" "1"

# ----------------------------------------------------------------------------
step "6, again. With every share gone, the participant is unaffected"
# ----------------------------------------------------------------------------
PG "UPDATE connect.recording_shares SET revoked_at=now() WHERE recording_id='$R1' AND revoked_at IS NULL" >/dev/null
r=$(call GET "/api/connect/recordings/$R1/view" "$ATTENDEE")
same "the attendee still opens it" "$(status "$r"):$(jq_ "$(body "$r")" "d['via']")" "200:meeting"
r=$(call GET "/api/connect/recordings/$R1/view" "$COLLEAGUE")
same "control: the colleague's organisation share is gone" "$(status "$r")" "404"

# ----------------------------------------------------------------------------
step "12. Dark means the routes refuse (Mr. Singh, fix 2)"
# ----------------------------------------------------------------------------
# The same API restarted as production will first run: switch off, nobody on
# the allow-list. Nothing may create a share; nothing that ENDS one may break.
r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST" '{"level":"organisation"}')
same "control: with Techvein on the allow-list, sharing works" "$(status "$r")" "200"
DARK_ORG=$(jq_ "$(body "$r")" "d['id']")
r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R2/shares" "$HOST" '{"level":"named","userIds":["principal@abcschool.local"]}')
same "…and a named share to change once it is dark" "$(status "$r")" "200"
DARK_NAMED="/api/connect/meetings/$MEETING/recordings/$R2/shares/$(jq_ "$(body "$r")" "d['id']")/people"
stop_api
# EMPTY MEANS NOBODY. Set to the empty string, as a blank line in the server's
# .env produces — not merely unset — so the check covers the value the server
# will actually carry. TATVAOS_DARK_TENANTS exists only to calibrate this.
export Connect__RecordingSharingOffered=false Connect__RecordingSharingTestTenants="${TATVAOS_DARK_TENANTS-}"
start_api && pass "API restarted: sharing off, allow-list set to [$Connect__RecordingSharingTestTenants]" || { fail "API did not restart"; exit 1; }
HOST=$(signin "+919999900001")
r=$(call GET "/api/connect/meetings/$MEETING/recordings" "$HOST")
same "no Share button for the host" "$(status "$r"):$(jq_ "$(body "$r")" "d.get('sharing')")" "200:None"
for lvl in organisation named password public; do
    case $lvl in
        named)    req='{"level":"named","userIds":["principal@abcschool.local"]}' ;;
        password) req='{"level":"password","days":7,"password":"long-enough-1"}' ;;
        public)   req='{"level":"public","days":7}' ;;
        *)        req='{"level":"organisation"}' ;;
    esac
    r=$(call POST "/api/connect/meetings/$MEETING/recordings/$R1/shares" "$HOST" "$req")
    same "creating a $lvl share is refused" "$(status "$r")" "403"
done
has "…in words" "$(body "$r")" "not switched on"
same "…and none was made" "$(PG "SELECT count(*) FROM connect.recording_shares WHERE recording_id='$R1' AND revoked_at IS NULL")" "0"
r=$(call PUT "$DARK_NAMED" "$HOST" '{"userIds":["principal@abcschool.local","hr@techvein.local"]}')
same "adding somebody new to an existing share is refused" "$(status "$r")" "403"
same "…before they were looked up (a dark server answers no questions about accounts)"     "$(PG "SELECT count(*) FROM core.audit_logs WHERE target_id='hr@techvein.local' AND occurred_at > now() - interval '1 hour'")" "0"
r=$(call PUT "$DARK_NAMED" "$HOST" '{"userIds":[]}')
same "control: removing people still works" "$(status "$r")" "200"
r=$(call DELETE "/api/connect/meetings/$MEETING/recordings/$R2/shares/$DARK_ORG" "$HOST")
same "control: stopping a share still works" "$(status "$r")" "204"
r=$(call GET "/api/connect/recordings/$R1/view" "$ATTENDEE")
same "control: the participant still watches" "$(status "$r")" "200"

printf "\n%s passed, %s failed\n" "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] && { printf "PASS %s\n" "$PASSED"; exit 0; } || exit 1
