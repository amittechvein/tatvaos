#!/usr/bin/env bash
#
# TatvaOS - the SMS sender must never write a phone number into the log.
#
# FOUND 19 Sept 2026 while writing an evidence pack, not by a test: every failure
# path in Shared/Notify/Notify.cs logged the full number - "SMS not configured;
# OTP for 919876543210 not sent", "Infobip rejected send to 9198...", "MSG91 send
# to 9198... failed". Until then the only numbers reaching it were our own
# signed-in users'. PR 184 would have sent strangers' numbers through it while
# telling them "the number itself is not kept". Mr. Singh, 20 Sept: redact first.
#
# What this can prove locally: the "not configured" path, which is the one a
# laptop and CI actually take. The two provider paths need a provider; their
# masking and the scrubbing of a provider's error body are proved as pure rules
# in tests/mask.
#
#   1. asking for a sign-in code makes the sender log that nothing was sent
#      (asserted FIRST: a redaction check that passes because nothing was logged
#      at all is a false green)
#   2. that line does not contain the number
#   3. it does contain the last four digits, so a person can still find the event
#   4. no line from the sender's log category contains the number
#
# Only the SENDER's lines are examined. In Development, EF prints SQL parameters
# (EnableSensitiveDataLogging, Development only; Program.cs refuses to start with
# it on anywhere else), so the number does appear elsewhere in a LOCAL log. That
# is a different, deliberate, development-only thing and not what this guards.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_REDACTION_TEST_PORT:-5089}"
API="http://localhost:$PORT"
PHONE="+919999900001"; DIGITS="9999900001"; TAIL="0001"
SCRATCH="$ROOT/.tmp/sms-redaction-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

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

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }

API_PID=""
cleanup() {
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

printf "\n  SMS sender log redaction\n  tree under test: %s\n\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
# The path under test is "no provider configured". Refuse to run otherwise: with a
# provider set this would send a real text to a seed number.
CONFIGURED=$(PG "SELECT count(*) FROM core.platform_settings WHERE key IN ('sms.infobip.username','sms.msg91.auth_key') AND coalesce(value,'') <> ''")
[ "$CONFIGURED" = "0" ] || { fail "an SMS provider is configured locally; this test must not send real texts"; exit 1; }

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET phone='$PHONE' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$PHONE'" >/dev/null
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$PHONE\"}")
[ "$code" = "200" ] && pass "a sign-in code was asked for [got 200]" || fail "otp/request answered $code"
sleep 1

# The console logger prints the category on one line and the message on the next.
SENDER=$(awk '/TatvaOS\.Api\.Shared\.Notify\.SmsSender/ { getline; print }' "$LOG")
LINE=$(printf "%s\n" "$SENDER" | grep -F "SMS not configured" | head -n1)

if [ -n "$LINE" ]; then pass "1. the sender logged that nothing was sent: $(printf '%s' "$LINE" | sed 's/^ *//')"
else fail "1. the sender logged nothing at all - the checks below would be a false green"; fi

if [ -n "$LINE" ] && ! printf "%s" "$LINE" | grep -qF "$DIGITS"; then pass "2. that line does not contain the number"
else fail "2. THE NUMBER IS IN THE LOG: $(printf '%s' "$LINE" | sed 's/^ *//')"; fi

if printf "%s" "$LINE" | grep -qF "$TAIL"; then pass "3. it keeps the last four digits, so the event can still be found"
else fail "3. the last four digits are gone too; the line is now useless for support"; fi

N=$(printf "%s\n" "$SENDER" | grep -cF "$DIGITS")
[ "$N" = "0" ] && pass "4. no line from the sender's category contains the number [got 0]" || fail "4. $N sender line(s) contain the number"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
