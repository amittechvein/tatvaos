#!/usr/bin/env bash
#
# TatvaOS Connect - the minutes worker, run for real (decision 0007).
#
# WHY. ConnectNotesWorker is the widest tenantless path in Connect: it finds
# work across every organisation through definer functions, then enters one
# organisation at a time to read participants, captions, transcripts and
# recordings and to write notes. Until this file NO TEST DROVE IT
# (docs/decisions/0007-tenantless-paths.md, open item 1). Step two (PR 332)
# put EF filters on every table it reads - a read made before its tenant is
# entered now throws. The calendar reminder worker showed what an untested
# tenantless worker looks like: it did nothing for six weeks and said nothing.
#
# So this runs the real worker and asserts on what it DID:
#   1. an ENDED meeting in Techvein AND in ABC School, each with one attendee
#      who has an account; both organisations have "email minutes" on
#   2. notes are written for both, each row carrying its own organisation
#   3. the minutes email reaches each attendee, once, and never the other
#      organisation's attendee
#   4. nothing read without a tenant, and the worker logged no failure
#
# Needs the SMTP sink (tests/support/smtp-sink.mjs, PR 290 - it decodes the
# minutes subject, which arrives encoded and folded). The worker waits a minute after start and
# ticks every minute: allow ~3 minutes. Leaves both organisations' "email
# minutes" switch as it found it.
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_MINUTES_TEST_PORT:-5105}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/minutes-walk-$$"
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
    type restore_minutes >/dev/null 2>&1 && restore_minutes

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



SINK="${TATVAOS_MAIL_SINK:-http://127.0.0.1:5198/mail}"
TV="11111111-1111-1111-1111-111111111111"; SC="22222222-2222-2222-2222-222222222222"
TV_USER="d1111111-1111-1111-1111-111111111112"; TV_MAIL="hr@techvein.local"
SC_USER="d2222222-2222-2222-2222-222222222222"; SC_MAIL="principal@abcschool.local"
# mail_to ADDRESS SUBJECT -> messages the sink saw to ADDRESS with exactly SUBJECT
mail_to() { curl -s "$SINK" | ADDR="$1" SUBJ="$2" "$PY" -c "import sys,json,os; print(sum(1 for m in json.load(sys.stdin) if os.environ['ADDR'] in m.get('to', []) and m.get('subject','').startswith(os.environ['SUBJ'])))" | tr -d "\r"; }

step "0. The sink and the database"
same "the local mail sink answers" "$(curl -s -o /dev/null -w "%{http_code}" "$SINK")" "200"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
TV_WAS=$(PG "SELECT connect_email_minutes FROM core.tenants WHERE id = '$TV'")
SC_WAS=$(PG "SELECT connect_email_minutes FROM core.tenants WHERE id = '$SC'")
# Quoted and cast: psql prints a boolean as t/f, and a bare t is not SQL - the
# first run's restore failed silently and left the switch on.
restore_minutes() { PG "UPDATE core.tenants SET connect_email_minutes = '${TV_WAS:-f}'::boolean WHERE id = '$TV'; UPDATE core.tenants SET connect_email_minutes = '${SC_WAS:-f}'::boolean WHERE id = '$SC'" >/dev/null; }
PG "UPDATE core.tenants SET connect_email_minutes = true WHERE id IN ('$TV', '$SC')" >/dev/null
pass "both organisations have \"email minutes\" on (was Techvein=${TV_WAS}, School=${SC_WAS})"

step "1. Plant: an ended meeting in each organisation, one attendee each"
# ended_at in 2000, so these sort first in pending_notes (ORDER BY ended_at).
plant() { # plant TENANT USER TAG DAY -> meeting id
    local m
    m=$(PG "WITH x AS (INSERT INTO connect.meetings (tenant_id, code, title, kind, status, started_at, ended_at)
            VALUES ('$1', 'min-$3-$RUN', 'Minutes walk $3 $RUN', 'instant', 'ended', timestamptz '2000-01-0$4 09:00Z', timestamptz '2000-01-0$4 10:00Z')
            RETURNING id) SELECT id FROM x")
    PG "INSERT INTO connect.participants (meeting_id, user_id, identity, display_name, role, is_guest, first_joined_at, last_seen_at)
        VALUES ('$m', '$2', 'min-$3-$RUN', 'Attendee $3', 'participant', false, timestamptz '2000-01-0$4 09:05Z', timestamptz '2000-01-0$4 09:55Z')" >/dev/null
    printf '%s' "$m"
}
M_TV=$(plant "$TV" "$TV_USER" techvein 1)
M_SC=$(plant "$SC" "$SC_USER" school 2)
[ -n "$M_TV" ] && [ -n "$M_SC" ] && pass "an ended meeting in each organisation" || { fail "could not plant the meetings"; exit 1; }
same "each has its attendee (the trigger set their organisation)" \
    "$(PG "SELECT count(*) FROM connect.participants WHERE (meeting_id = '$M_TV' AND tenant_id = '$TV') OR (meeting_id = '$M_SC' AND tenant_id = '$SC')")" "2"

step "2. Start the API and let the real worker run"
export Smtp__Host=localhost Smtp__Port=5871
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
printf "  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
notes_ready() { PG "SELECT count(*) FROM connect.meeting_notes WHERE meeting_id IN ('$M_TV', '$M_SC') AND status = 'ready'"; }
for _ in $(seq 1 240); do [ "$(notes_ready)" = "2" ] && break; sleep 1; done
# Minutes go on a later pass of the same tick loop; wait for both.
for _ in $(seq 1 120); do
    [ "$(mail_to "$TV_MAIL" "Minutes: Minutes walk techvein $RUN")" = "1" ] && [ "$(mail_to "$SC_MAIL" "Minutes: Minutes walk school $RUN")" = "1" ] && break
    sleep 1
done

step "3. What the worker did"
same "notes written for both meetings" "$(notes_ready)" "2"
same "...each carrying its own organisation" \
    "$(PG "SELECT count(*) FROM connect.meeting_notes WHERE (meeting_id = '$M_TV' AND tenant_id = '$TV') OR (meeting_id = '$M_SC' AND tenant_id = '$SC')")" "2"
same "the Techvein attendee got the Techvein minutes, once" "$(mail_to "$TV_MAIL" "Minutes: Minutes walk techvein $RUN")" "1"
same "the School attendee got the School minutes, once" "$(mail_to "$SC_MAIL" "Minutes: Minutes walk school $RUN")" "1"
same "neither got the other organisation's minutes" \
    "$(( $(mail_to "$TV_MAIL" "Minutes: Minutes walk school $RUN") + $(mail_to "$SC_MAIL" "Minutes: Minutes walk techvein $RUN") ))" "0"
same "both are marked emailed" "$(PG "SELECT count(*) FROM connect.meeting_notes WHERE meeting_id IN ('$M_TV', '$M_SC') AND emailed_at IS NOT NULL")" "2"
if grep -q "Tenant context was not resolved" "$LOG"; then
    fail "a read ran with no tenant: $(grep -m1 "Tenant context was not resolved" "$LOG" | head -c 300)"
else
    pass "no read anywhere in this run hit a filter without a tenant"
fi
if grep -qiE "notes worker.*(fail|threw|error)|Connect notes.*(fail|error)" "$LOG"; then
    fail "the worker logged a failure: $(grep -m1 -iE "notes worker.*(fail|threw|error)|Connect notes.*(fail|error)" "$LOG" | head -c 300)"
else
    pass "the worker logged no failure"
fi

PG "DELETE FROM connect.meetings WHERE id IN ('$M_TV', '$M_SC')" >/dev/null
restore_minutes
same "\"email minutes\" is back as it was" "$(PG "SELECT connect_email_minutes FROM core.tenants WHERE id = '$TV'")/$(PG "SELECT connect_email_minutes FROM core.tenants WHERE id = '$SC'")" "${TV_WAS}/${SC_WAS}"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
