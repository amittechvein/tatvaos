#!/usr/bin/env bash
#
# TatvaOS Connect - the meeting reads that run WITHOUT a signed-in person still
# work under the ConnectMeeting query filter (decision 0007, step one).
#
# WHY. 0007 step one gave ConnectMeeting the codebase's EF filter,
# e => e.TenantId == tenant.TenantId. TenantId THROWS when no tenant is set,
# so any path that reads meetings before entering its organisation now fails.
# Every read was checked by eye (26 sites); these are the paths no other suite
# drives, run for real:
#
#   1. the LiveKit webhook, on ANOTHER organisation's meeting than any signed-in
#      person here: room_started makes it active, room_finished ends it.
#      THE TRAP: the webhook catches every exception and still answers 200.
#      A filter that broke it would be silent, so the checks read the meeting's
#      status in the database AND the log for the handler's "threw" line.
#   1b. the egress (recording) callback on that meeting: a recording in
#      progress finishes, and the row says ready with its file - not dropped.
#   2. the guest waiting room: knock, wait, admitted by the host, and the
#      admitted poll (which reads the meeting's policies) hands over a token.
#
# The guest door's straight-through join is tests/connect-guest-ceiling; the
# Meetings API is tests/orgapi. No media server: tokens are minted, not used.
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ISOLATION_TEST_PORT:-5087}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/connect-isolation-$$"
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

step "1. Start the API"
# Test values, not anybody's: enough to mint join tokens and verify webhooks.
LK_KEY="testkey"; LK_SECRET="test-secret-at-least-32-characters-long"
export LiveKit__ApiKey="$LK_KEY" LiveKit__ApiSecret="$LK_SECRET"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
printf "  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

# The signer lives in a file: an HS256 JWT whose sha256 claim is the base64
# SHA-256 of the body - exactly what LiveKitTokenService.VerifyWebhook checks.
cat > "$SCRATCH/sign.py" <<'PYEOF'
import os, json, time, hmac, hashlib, base64
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
body = os.environ["BODY"].encode()
h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
p = b(json.dumps({"iss": os.environ["KEY"], "exp": int(time.time()) + 300,
                  "sha256": base64.b64encode(hashlib.sha256(body).digest()).decode()}).encode())
s = b(hmac.new(os.environ["SECRET"].encode(), (h + "." + p).encode(), hashlib.sha256).digest())
print(h + "." + p + "." + s)
PYEOF
SIGNER="$SCRATCH/sign.py"
command -v cygpath >/dev/null 2>&1 && SIGNER="$(cygpath -w "$SIGNER")"

# signed BODY -> HTTP status of a LiveKit-signed event carrying exactly BODY
signed() {
    local body="$1" jwt
    jwt=$(BODY="$body" SECRET="$LK_SECRET" KEY="$LK_KEY" "$PY" "$SIGNER" | tr -d "")
    curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit"         -H "Authorization: $jwt" -H "Content-Type: application/webhook+json" --data-binary "$body"
}
# webhook EVENT MEETING_ID -> HTTP status of a signed room event
webhook() {
    local body="{\"event\":\"$1\",\"id\":\"iso-$RUN-$1\",\"createdAt\":\"$(date +%s)\",\"room\":{\"name\":\"m-$2\"}}"
    local jwt
    jwt=$(BODY="$body" SECRET="$LK_SECRET" KEY="$LK_KEY" "$PY" "$SIGNER" | tr -d "\r")
    curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit" \
        -H "Authorization: $jwt" -H "Content-Type: application/webhook+json" --data-binary "$body"
}

step "2. The LiveKit webhook, on the School's meeting"
PRINCIPAL=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
PG "INSERT INTO connect.meetings (tenant_id, code, title, kind, status, scheduled_start, scheduled_end, created_by_user_id) VALUES ('$SCHOOL', 'iso-school-$RUN', 'ISO $RUN', 'scheduled', 'scheduled', now(), now() + interval '1 hour', '$PRINCIPAL')" >/dev/null
MS=$(PG "SELECT id FROM connect.meetings WHERE code='iso-school-$RUN'")
[ -n "$MS" ] && pass "a scheduled School meeting exists" || { fail "could not plant the School meeting"; exit 1; }
mstatus() { PG "SELECT status FROM connect.meetings WHERE id='$MS'"; }

same "an unsigned webhook is refused (the endpoint really verifies)" \
    "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit" -d '{"event":"room_started"}')" "401"
same "room_started, signed, answered" "$(webhook room_started "$MS")" "200"
same "...and the School's meeting is now active (the filtered read found it)" "$(mstatus)" "active"
same "room_finished, signed, answered" "$(webhook room_finished "$MS")" "200"
same "...and the meeting has ended" "$(mstatus)" "ended"
same "both events were recorded against it" "$(PG "SELECT count(*) FROM connect.meeting_events WHERE meeting_id='$MS' AND webhook_id LIKE 'iso-$RUN-%'")" "2"
step "2b. The egress callback: a recording on the School's meeting finishes"
# Mr. Singh's ruling on 0007: "a webhook returning nothing is a silently dropped
# recording". The egress event carries no room object; the meeting is found from
# egressInfo.roomName, the tenant entered, the (filtered) meeting read, and the
# recording row updated by egress id.
EG="EG_iso_$RUN"
PG "INSERT INTO connect.recordings (meeting_id, egress_id, mode, status) VALUES ('$MS', '$EG', 'audio', 'recording')" >/dev/null
same "a School recording is in progress" "$(PG "SELECT status FROM connect.recordings WHERE egress_id='$EG'")" "recording"
EBODY="{\"event\":\"egress_ended\",\"id\":\"iso-$RUN-egress\",\"createdAt\":\"$(date +%s)\",\"egressInfo\":{\"egressId\":\"$EG\",\"roomName\":\"m-$MS\",\"status\":\"EGRESS_COMPLETE\",\"fileResults\":[{\"filename\":\"/out/iso-$RUN.ogg\",\"size\":\"12345\",\"duration\":\"5000000000\"}]}}"
same "egress_ended, signed, answered" "$(signed "$EBODY")" "200"
same "...and the recording is ready, with the file and its size (the callback was not dropped)"     "$(PG "SELECT status || '/' || coalesce(file_name,'-') || '/' || size_bytes FROM connect.recordings WHERE egress_id='$EG'")" "ready/iso-$RUN.ogg/12345"

if grep -q "LiveKit webhook handler threw" "$LOG"; then
    fail "the webhook handler threw (its 200 hid it): $(grep -m1 -A2 "handler threw" "$LOG" | tr '\n' ' ' | head -c 300)"
else
    pass "the webhook handler threw nothing (its 200 hides throws, so the log is read)"
fi

step "3. The guest waiting room"
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
HOST=$(signin "+919999900001")
[ -n "$HOST" ] && pass "signed in as the host" || { fail "host sign-in failed"; exit 1; }
r=$(call POST "/api/connect/meetings" "$HOST" "{\"title\":\"Iso lobby $RUN\",\"kind\":\"instant\",\"waitingRoom\":\"guests\",\"allowGuests\":true}")
b=$(body "$r")
MEETING=$(jq_ "$b" "d.get('id') or (d.get('meeting') or {}).get('id') or ''")
CODE=$(jq_ "$b" "d.get('code') or (d.get('meeting') or {}).get('code') or ''")
[ -n "$MEETING" ] && [ -n "$CODE" ] && pass "the host made a meeting with a waiting room for guests" || { fail "no meeting: $(brief "$r")"; exit 1; }

same "the guest door opens (GET /g/{code})" "$(status "$(curl -s -w "\n%{http_code}" "$API/api/connect/g/$CODE")")" "200"
r=$(curl -s -w "\n%{http_code}" -X POST "$API/api/connect/g/$CODE/join" -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 10.9.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))" -d "{\"displayName\":\"Lobby guest $RUN\"}")
same "the guest knocks and is told to wait" "$(jq_ "$(body "$r")" "d.get('status') or ''")" "waiting"
WT=$(jq_ "$(body "$r")" "d.get('waitToken') or ''")
same "a poll while waiting says waiting" "$(jq_ "$(body "$(curl -s -w "\n%{http_code}" "$API/api/connect/g/wait/$WT")")" "d.get('status') or ''")" "waiting"

LOBBY=$(body "$(call GET "/api/connect/meetings/$MEETING/lobby" "$HOST")")
REQ=$(jq_ "$LOBBY" "next((x.get('requestId') for x in (d.get('waiting') or []) if x.get('displayName') == 'Lobby guest $RUN'), '')")
[ -n "$REQ" ] && pass "the host sees the knock" || fail "the host's lobby list has no knock: $(brief "$LOBBY")"
same "the host admits the guest (204, no body)" "$(status "$(call POST "/api/connect/meetings/$MEETING/lobby/$REQ/admit" "$HOST" "{}")")" "204"
r=$(curl -s -w "\n%{http_code}" "$API/api/connect/g/wait/$WT")
same "the admitted poll (reads the meeting's policies) answers admitted" "$(jq_ "$(body "$r")" "d.get('status') or ''")" "admitted"
same "...with a join token" "$(jq_ "$(body "$r")" "'yes' if (d.get('token') or '').count('.') == 2 else 'no'")" "yes"

if grep -q "Tenant context was not resolved" "$LOG"; then
    fail "a read ran with no tenant: $(grep -m1 "Tenant context was not resolved" "$LOG" | head -c 300)"
else
    pass "no read anywhere in this run hit the filter without a tenant"
fi

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
