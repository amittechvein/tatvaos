#!/usr/bin/env bash
#
# TatvaOS Calendar - the reminder worker actually sends a reminder.
#
# THE INCIDENT. CalendarReminderWorker shipped with the calendar on 16 Aug 2026
# and never sent one reminder. It read FORCED-RLS tables with no tenant set, saw
# nothing, and "nothing due" is not an error. Confirmed on production 27 Sept:
# 7 reminders set, 1 due in the past week, calendar.reminder_sends empty.
#
# Mr. Singh, 27 Sept: "The test must run the job with a real reminder due and
# see the send recorded, because 'the job ran without error' is the exact false
# green that hid this for a month." So this starts the real API, lets the real
# worker run, and asserts on what it DID:
#
#   1. a reminder due now in Techvein AND one in ABC School (two organisations:
#      the fix enters each in turn)
#   2. both sends recorded in calendar.reminder_sends
#   3. both emails arrive at the local SMTP sink, each to its own person
#   4. a reminder not yet due is NOT sent, and nothing is sent twice
#   5. the worker logged no sweep failure
#
# Needs the local SMTP sink (tatvaos-ai-metering/.tmp/fake-ai-and-mail.mjs:
# SMTP :5871, recipients at http://127.0.0.1:5198/mail). The worker waits a
# minute after start, then ticks every minute: allow ~3 minutes.
# WSL Postgres as tests/orgapi. Build first:  dotnet build apps/api -c Release
# TATVAOS_ROOT=<another checkout> runs it against that build (the red run).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${TATVAOS_ROOT:-$HERE}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_REMINDER_TEST_PORT:-5097}"
API="http://localhost:$PORT"
SINK="${TATVAOS_MAIL_SINK:-http://127.0.0.1:5198/mail}"
RUN=$(date +%s)
SCRATCH="$HERE/.tmp/calendar-reminders-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN="11111111-1111-1111-1111-111111111111"; SCHOOL="22222222-2222-2222-2222-222222222222"
HR_ID="d1111111-1111-1111-1111-111111111112"; HR_MAIL="hr@techvein.local"
PR_ID="d2222222-2222-2222-2222-222222222222"; PR_MAIL="principal@abcschool.local"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 1800 >/dev/null 2>&1 & WSL_KEEPALIVE=$!
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
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
# mail_to ADDRESS SUBJECT -> how many messages the sink has seen to ADDRESS with SUBJECT
mail_to() { curl -s "$SINK" | ADDR="$1" SUBJ="$2" "$PY" -c "import sys,json,os; print(sum(1 for m in json.load(sys.stdin) if os.environ['ADDR'] in m.get('to', []) and m.get('subject') == os.environ['SUBJ']))" | tr -d "\r"; }

API_PID=""
cleanup() {
    PG "DELETE FROM calendar.events WHERE title LIKE 'Reminder test $RUN%'" >/dev/null
    PG "DELETE FROM calendar.calendars WHERE name = 'Reminder test $RUN'" >/dev/null
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Calendar reminders\n  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. The mail sink and the database; the definer function is in place"
same "the local mail sink answers" "$(curl -s -o /dev/null -w "%{http_code}" "$SINK")" "200"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
PGFILE "$HERE/local/postgres/init/20260927-calendar-reminder-tenants.sql"
same "calendar.reminder_tenants() exists" "$(PG "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='calendar' AND p.proname='reminder_tenants' AND p.prosecdef")" "1"

step "1. Plant: one reminder due now in each organisation, one not yet due"
# Due now: the event starts in 5 minutes and the reminder is 10 minutes before,
# so its time was 5 minutes ago - inside the worker's 15-minute grace.
plant() { # plant TENANT USER TAG STARTS_IN_MINUTES -> reminder id
    local cal ev
    cal=$(PG "WITH x AS (INSERT INTO calendar.calendars (tenant_id, name, owner_user_id) VALUES ('$1', 'Reminder test $RUN', '$2') RETURNING id) SELECT id FROM x")
    ev=$(PG "WITH x AS (INSERT INTO calendar.events (tenant_id, calendar_id, uid, title, starts_at, ends_at) VALUES ('$1', '$cal', 'rt-$RUN-$3@test', 'Reminder test $RUN $3', now() + interval '$4 minutes', now() + interval '$4 minutes' + interval '30 minutes') RETURNING id) SELECT id FROM x")
    PG "WITH x AS (INSERT INTO calendar.event_reminders (event_id, user_id, minutes_before, method) VALUES ('$ev', '$2', 10, 'email') RETURNING id) SELECT id FROM x"
}
R_TV=$(plant "$TECHVEIN" "$HR_ID" techvein 5)
R_SC=$(plant "$SCHOOL" "$PR_ID" school 5)
R_LATER=$(plant "$TECHVEIN" "$HR_ID" later 180)
[ -n "$R_TV" ] && [ -n "$R_SC" ] && [ -n "$R_LATER" ] && pass "three reminders planted (Techvein due, School due, Techvein in 3 hours)" || { fail "could not plant reminders"; exit 1; }

step "2. Start the API and let the real worker run"
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5871
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
sent() { PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id IN ('$R_TV', '$R_SC')"; }
for _ in $(seq 1 200); do [ "$(sent)" = "2" ] && break; sleep 1; done
# One more tick after both are recorded, to catch a second send.
sleep 65

step "3. What the worker did"
same "the Techvein reminder's send is recorded" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id='$R_TV'")" "1"
same "the School reminder's send is recorded (a second organisation)" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id='$R_SC'")" "1"
same "the Techvein email arrived, once, to its person" "$(mail_to "$HR_MAIL" "Reminder: Reminder test $RUN techvein")" "1"
same "the School email arrived, once, to its person" "$(mail_to "$PR_MAIL" "Reminder: Reminder test $RUN school")" "1"
same "neither person got the other organisation's reminder" "$(( $(mail_to "$HR_MAIL" "Reminder: Reminder test $RUN school") + $(mail_to "$PR_MAIL" "Reminder: Reminder test $RUN techvein") ))" "0"
same "the reminder not yet due was not sent" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id='$R_LATER'")" "0"
if grep -q "Calendar reminder sweep failed" "$LOG"; then fail "the worker logged a sweep failure: $(grep -m1 -A2 "sweep failed" "$LOG" | tr '\n' ' ' | head -c 300)"
else pass "the worker logged no sweep failure"; fi

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
