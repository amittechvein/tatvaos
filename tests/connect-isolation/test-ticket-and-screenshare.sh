#!/usr/bin/env bash
#
# TatvaOS Connect - the ticketed download and the screen-share event, walked
# (decision 0007 inventory, section 4 item 2).
#
# Both start with NO session and find the organisation some other way. Both
# have the shape that has already failed in this module more than once: scope
# set on the C# object and never pushed into the database, so every read comes
# back empty and nothing complains.
#
# A. GET /api/connect/recordings/file?t=<ticket>
#    The ticket is signed (Jwt:SigningKey) and names a tenant, meeting,
#    recording and person. The route trusts ONLY the tenant, then re-checks the
#    rest under row-level security. ConnectDownloadTicket says "a stolen ticket
#    buys what its holder could already have had". This tests that sentence:
#    tickets correctly SIGNED (the test holds the local key) but naming the
#    wrong organisation, a person who was not in the meeting, or the wrong
#    meeting, must all be refused - the signature is not the authorisation.
#    And a person removed from the meeting loses a ticket already issued.
#
# B. POST /api/connect/webhooks/livekit, track_published SCREEN_SHARE
#    The organisation comes from the room name (connect.webhook_meeting_tenant).
#    The handler answers 200 whatever happens, and returns silently when it
#    cannot read the meeting - so a 200 proves nothing. What does: in a
#    single-sharer meeting it goes on to ask LiveKit for the participant list.
#    There is no LiveKit here, so that ask fails and logs a warning NAMING THE
#    MEETING. The warning appears only if the meeting was read under the right
#    organisation. Controls: the same event in a multiple-sharer meeting, and a
#    camera track, must NOT reach it.
#
# Calibrated 28 Sept 2026 in a throwaway copy (not committed), 32 checks:
#   - participant re-check removed from DownloadTicketedAsync: 2 red (the
#     non-participant's forged ticket and the removed colleague's ticket both
#     fetch the file);
#   - EnterMeetingTenantAsync entering Techvein instead of the meeting's own
#     organisation: 2 more red (the screen share is never acted on - silently,
#     behind a 200).
# NOT a red, measured: removing SyncTenantAsync from HandleScreenShareAsync.
# EF closes the connection after the definer lookup, and the next query opens
# a new one, which the interceptor stamps with the tenant. The line is a
# safety net on this path today, not the thing holding it up.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_TICKET_WALK_TEST_PORT:-5104}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/ticket-walk-$$"
mkdir -p "$SCRATCH/recordings"
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
# An empty operand is REFUSED, not compared: [ "" = "" ] is true.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
call() {
    curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3"
}
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}
# fetch TICKET [RANGE] -> "status bytes-received"
fetch() {
    local out="$SCRATCH/got.bin" extra=()
    [ -n "${2:-}" ] && extra=(-H "Range: bytes=$2")
    local st; st=$(curl -s -o "$out" -w "%{http_code}" "${extra[@]}" "$API/api/connect/recordings/file?t=$1")
    printf "%s %s" "$st" "$(wc -c < "$out" | tr -d ' ')"
}

TICKET_KEY="dev-only-key-at-least-32-characters-long"   # test value, set below
export JWT_SIGNING_KEY="$TICKET_KEY" Jwt__SigningKey="$TICKET_KEY"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=$PGDB;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
REC_DIR="$SCRATCH/recordings"
command -v cygpath >/dev/null 2>&1 && REC_DIR_API="$(cygpath -w "$REC_DIR")" || REC_DIR_API="$REC_DIR"
export Connect__Recording__ReadDirectory="$REC_DIR_API"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
# LiveKit: test values, enough to verify webhooks. Nothing listens at the URL,
# which is what step B relies on.
LK_KEY="testkey"; LK_SECRET="test-secret-at-least-32-characters-long"
export LiveKit__ApiKey="$LK_KEY" LiveKit__ApiSecret="$LK_SECRET" LiveKit__InternalUrl="http://127.0.0.1:1"

API_PID=""; MEETINGS=()
cleanup() {
    for m in "${MEETINGS[@]}"; do PG "DELETE FROM connect.meetings WHERE id = '$m'" >/dev/null; done
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
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
printf "  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

HOST=$(signin "+919999900001"); HR=$(signin "+919999900002"); PRINCIPAL=$(signin "+919999900003")
[ -n "$HOST" ] && [ -n "$HR" ] && [ -n "$PRINCIPAL" ] && pass "host, colleague and another organisation's principal signed in" \
    || { fail "sign-in failed"; exit 1; }
HOST_ID=$(PG "SELECT id FROM core.users WHERE phone='+919999900001'")
HR_ID=$(PG "SELECT id FROM core.users WHERE phone='+919999900002'")

# ── Fixtures, planted and each one checked (a rolled-back batch has printed
#    false greens here before). ────────────────────────────────────────────
mk_meeting() {   # TENANT CREATOR TITLE -> id
    PG "WITH x AS (INSERT INTO connect.meetings (tenant_id, code, title, kind, created_by_user_id)
          VALUES ('$1', 'tw$RUN$RANDOM', '$3', 'instant', '$2') RETURNING id) SELECT id FROM x"
}

step "A. The ticketed download"
M1=$(mk_meeting "$TECHVEIN" "$HOST_ID" "Ticket walk $RUN"); MEETINGS+=("$M1")
M2=$(mk_meeting "$TECHVEIN" "$HOST_ID" "Ticket walk other $RUN"); MEETINGS+=("$M2")
[ -n "$M1" ] && [ -n "$M2" ] && pass "two Techvein meetings" || { fail "could not plant meetings"; exit 1; }
printf 'walk-%s-%0200d' "$RUN" 0 > "$REC_DIR/walk-$RUN.ogg"
SIZE=$(wc -c < "$REC_DIR/walk-$RUN.ogg" | tr -d ' ')
REC=$(PG "WITH x AS (INSERT INTO connect.recordings (meeting_id, egress_id, mode, status, file_name, size_bytes, content_type)
            VALUES ('$M1', 'EG_walk_$RUN', 'audio', 'ready', 'walk-$RUN.ogg', $SIZE, 'audio/ogg') RETURNING id) SELECT id FROM x")
[ -n "$REC" ] && pass "a ready recording with a real file ($SIZE bytes)" || { fail "could not plant the recording"; exit 1; }
PART=$(PG "WITH x AS (INSERT INTO connect.participants (meeting_id, tenant_id, user_id, display_name, identity)
             VALUES ('$M1', '$TECHVEIN', '$HR_ID', 'HR', 'u-$HR_ID') RETURNING id) SELECT id FROM x")
[ -n "$PART" ] && pass "the colleague was in the meeting" || { fail "could not plant the participant"; exit 1; }

r=$(call GET "/api/connect/meetings/$M1/recordings/$REC/ticket" "$HOST")
T_HOST=$(jq_ "$(body "$r")" "d.get('ticket') or ''")
same "the organiser is issued a ticket" "$(status "$r")/$([ -n "$T_HOST" ] && echo yes)" "200/yes"
same "...and it fetches the whole file" "$(fetch "$T_HOST")" "200 $SIZE"
same "...and a range of it (seeking works)" "$(fetch "$T_HOST" 0-9)" "206 10"

r=$(call GET "/api/connect/meetings/$M1/recordings/$REC/ticket" "$HR")
T_HR=$(jq_ "$(body "$r")" "d.get('ticket') or ''")
same "the colleague who was in it is issued one" "$(status "$r")/$([ -n "$T_HR" ] && echo yes)" "200/yes"
same "...and it fetches the file" "$(fetch "$T_HR")" "200 $SIZE"

r=$(call GET "/api/connect/meetings/$M1/recordings/$REC/ticket" "$PRINCIPAL")
same "another organisation's principal is NOT issued one (404, as if nothing were there)" "$(status "$r")" "404"

# Flip a character in the MIDDLE of the signature: the last base64 character
# of a 32-byte MAC carries two unused bits, so changing it can decode to the
# very same bytes and tamper nothing.
SIG=${T_HOST#*.}; MID=$(( ${#SIG} / 2 ))
FLIP=$([ "${SIG:$MID:1}" = A ] && echo B || echo A)
TAMPERED="${T_HOST%%.*}.${SIG:0:$MID}${FLIP}${SIG:$((MID+1))}"
same "(the tampered ticket really differs)" "$([ "$TAMPERED" != "$T_HOST" ] && [ ${#TAMPERED} -eq ${#T_HOST} ] && echo yes)" "yes"
same "a tampered signature is refused" "$(fetch "$TAMPERED" | cut -d' ' -f1)" "404"

# Correctly SIGNED tickets naming the wrong things: the test holds the key, as
# anyone who stole it would. The route must re-check, not trust.
cat > "$SCRATCH/forge.py" <<'PYEOF'
import os, sys, json, time, hmac, hashlib, base64
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
t, m, r, u, e = sys.argv[1:6]
# "Y": the token type every body signed with Jwt:SigningKey has carried since
# PR 346 (ConnectDownloadTicket.Type); Verify refuses any other. Without it this
# forger's "exact copy" was no copy at all, and the control failed (6 Oct 2026,
# CI run 37453497710). NO_TYPE=1 leaves it out, to prove that refusal.
claims = {"T": t, "M": m, "R": r, "U": u, "E": int(time.time()) + int(e)}
if os.environ.get("NO_TYPE") != "1":
    claims["Y"] = "connect-download"
body = b(json.dumps(claims, separators=(",", ":")).encode())
print(body + "." + b(hmac.new(os.environ["KEY"].encode(), body.encode(), hashlib.sha256).digest()))
PYEOF
FORGE="$SCRATCH/forge.py"; command -v cygpath >/dev/null 2>&1 && FORGE="$(cygpath -w "$FORGE")"
forge() { KEY="$TICKET_KEY" "$PY" "$FORGE" "$@" | tr -d "\r"; }

same "control: a forged ticket naming exactly what the organiser was issued works" \
    "$(fetch "$(forge "$TECHVEIN" "$M1" "$REC" "$HOST_ID" 300)")" "200 $SIZE"
same "signed, but naming ANOTHER ORGANISATION: refused" \
    "$(fetch "$(forge "$SCHOOL" "$M1" "$REC" "$HOST_ID" 300)" | cut -d' ' -f1)" "404"
PRINCIPAL_ID=$(PG "SELECT id FROM core.users WHERE phone='+919999900003'")
same "signed, naming a person who was NOT in the meeting: refused" \
    "$(fetch "$(forge "$TECHVEIN" "$M1" "$REC" "$PRINCIPAL_ID" 300)" | cut -d' ' -f1)" "404"
same "signed, naming ANOTHER MEETING the organiser also made: refused (the recording is not its)" \
    "$(fetch "$(forge "$TECHVEIN" "$M2" "$REC" "$HOST_ID" 300)" | cut -d' ' -f1)" "404"
same "signed, but expired: refused" \
    "$(fetch "$(forge "$TECHVEIN" "$M1" "$REC" "$HOST_ID" -5)" | cut -d' ' -f1)" "404"
same "signed and correct in every field, but with NO token type (the shape before PR 346): refused" \
    "$(fetch "$(NO_TYPE=1 forge "$TECHVEIN" "$M1" "$REC" "$HOST_ID" 300)" | cut -d' ' -f1)" "404"

PG "DELETE FROM connect.participants WHERE id = '$PART'" >/dev/null
same "(the colleague is removed from the meeting)" "$(PG "SELECT count(*) FROM connect.participants WHERE id = '$PART'")" "0"
same "...and the ticket they ALREADY HOLD stops working" "$(fetch "$T_HR" | cut -d' ' -f1)" "404"

step "B. The screen-share event"
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
SIGNER="$SCRATCH/sign.py"; command -v cygpath >/dev/null 2>&1 && SIGNER="$(cygpath -w "$SIGNER")"
# track EVENT MEETING SOURCE -> HTTP status
track() {
    local body="{\"event\":\"$1\",\"id\":\"tw-$RUN-$RANDOM\",\"createdAt\":\"$(date +%s)\",\"room\":{\"name\":\"m-$2\"},\"participant\":{\"identity\":\"u-walk-$RUN\"},\"track\":{\"sid\":\"TR_$RUN\",\"source\":\"$3\"}}"
    local jwt; jwt=$(BODY="$body" SECRET="$LK_SECRET" KEY="$LK_KEY" "$PY" "$SIGNER" | tr -d "\r")
    curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit" \
        -H "Authorization: $jwt" -H "Content-Type: application/webhook+json" --data-binary "$body"
}
# track_room EVENT ROOMNAME -> HTTP status, for a room that is not m-<id>
track_room() {
    local body="{\"event\":\"$1\",\"id\":\"tw-$RUN-$RANDOM\",\"createdAt\":\"$(date +%s)\",\"room\":{\"name\":\"$2\"},\"participant\":{\"identity\":\"u-walk-$RUN\"},\"track\":{\"sid\":\"TR_$RUN\",\"source\":\"SCREEN_SHARE\"}}"
    local jwt; jwt=$(BODY="$body" SECRET="$LK_SECRET" KEY="$LK_KEY" "$PY" "$SIGNER" | tr -d "\r")
    curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit"         -H "Authorization: $jwt" -H "Content-Type: application/webhook+json" --data-binary "$body"
}
reached() { grep -c "Share enforcement, meeting $1" "$LOG" | tr -d ' '; }

PRINCIPAL_ID=${PRINCIPAL_ID:-$(PG "SELECT id FROM core.users WHERE phone='+919999900003'")}
MS=$(mk_meeting "$SCHOOL" "$PRINCIPAL_ID" "Screen walk single $RUN"); MEETINGS+=("$MS")
MM=$(mk_meeting "$SCHOOL" "$PRINCIPAL_ID" "Screen walk multiple $RUN"); MEETINGS+=("$MM")
PG "UPDATE connect.meetings SET share_mode='single' WHERE id='$MS'" >/dev/null
same "two ABC School meetings, one single-sharer and one not" \
    "$(PG "SELECT string_agg(share_mode, ',' ORDER BY share_mode) FROM connect.meetings WHERE id IN ('$MS','$MM')")" "multiple,single"

same "an unsigned event is refused (the endpoint really verifies)" \
    "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/connect/webhooks/livekit" -d '{"event":"track_published"}')" "401"
same "a screen share starts in the single-sharer meeting: 200" "$(track track_published "$MS" SCREEN_SHARE)" "200"
same "a camera track in the single-sharer meeting: 200" "$(track track_published "$MS" CAMERA)" "200"
same "a screen share in the multiple-sharer meeting: 200" "$(track track_published "$MM" SCREEN_SHARE)" "200"
sleep 1
# The 200s above prove nothing on their own - the handler answers 200 always.
same "the screen share was acted on: the handler read the meeting under ABC School and went to LiveKit (once)" \
    "$(reached "$MS")" "1"
same "control: the multiple-sharer meeting was NOT acted on" "$(reached "$MM")" "0"
same "the screen share stopping is acted on too" "$(track track_unpublished "$MS" SCREEN_SHARE)/$(sleep 1; reached "$MS")" "200/2"

# Every 200 that does nothing names its reason (Mr. Singh, 1 Oct 2026). The
# multiple-sharer event above is one; two more that should not happen in life.
logged() { grep -c -- "$1" "$LOG" | tr -d ' '; }
same "...and the multiple-sharer event SAYS why it did nothing"     "$(logged "in meeting $MM: share mode is multiple, nothing to enforce")" "1"
GHOST="$("$PY" -c "import uuid; print(uuid.uuid4())" | tr -d "\r")"
same "a screen share for a meeting that does not exist: 200, and a warning naming it"     "$(track track_published "$GHOST" SCREEN_SHARE)/$(sleep 1; logged "for meeting $GHOST ignored: no such meeting")" "200/1"
same "a screen share in a room that is not a meeting room: 200, and a warning"     "$(track_room track_published "lobby-$RUN")/$(sleep 1; logged "the room is not a meeting room")" "200/1"
same "no screen share was read under the wrong organisation (the error line never appears)"     "$(logged "NOT ACTED ON: the meeting exists")" "0"

step "Nothing ran without an organisation"
if grep -q "Tenant context was not resolved" "$LOG"; then
    fail "a read ran with no tenant: $(grep -m1 "Tenant context was not resolved" "$LOG" | head -c 300)"
else
    pass "no read anywhere in this run hit a filter without a tenant"
fi
if grep -q "LiveKit webhook handler threw" "$LOG"; then
    fail "the webhook handler threw: $(grep -m1 -A2 "LiveKit webhook handler threw" "$LOG" | head -c 400)"
else
    pass "the webhook handler threw nothing"
fi

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
