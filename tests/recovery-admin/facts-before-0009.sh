#!/usr/bin/env bash
#
# TatvaOS - what the code does TODAY that decision 0009 (an administrator sets a
# person's recovery email) has to build on. Written 24 Sept 2026 while preparing
# 0009 for Mr. Singh's ruling; NOTHING of 0009 is built. Each check pins a fact
# the design depends on, run rather than read:
#
#   A. Send sign-in link mails an UNCONFIRMED recovery address. The rescue
#      buttons check only that recovery_email is set, not recovery_email_
#      verified_at. So under 0009 an address an administrator types must not
#      sit in recovery_email until it is confirmed, or it is usable at once.
#   B. The public "Forgot password -> recovery email" route mails a reset link
#      to a CONFIRMED recovery address, with no administrator in the loop. 0009's
#      48-hour hold covers only the two administrator buttons, so this route
#      must be held too, or an administrator who typed their own address and
#      confirmed it can reset the password from the sign-in page.
#   C. The person's own change OVERWRITES recovery_email at once: the previous
#      address is kept nowhere. 0009's "this was not me" restores the previous
#      address, so it needs somewhere to keep it.
#
# 0009 IS BUILT (27 Sept 2026, PR 290). This file now asserts the OLD
# behaviour and is the red half of the evidence: it passes on main (c7cb110)
# and its step A FAILS on the 0009 branch by design - a sign-in link to an
# unconfirmed address is now refused. Run it with TATVAOS_ROOT pointing at a
# main checkout. The test of the built feature is test-admin-recovery-email.sh.
#
# Needs the local SMTP sink (tatvaos-ai-metering/.tmp/fake-ai-and-mail.mjs:
# SMTP :5871, recipients at http://127.0.0.1:5198/mail).
# WSL Postgres as tests/orgapi. Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_RECOVERY_ADMIN_TEST_PORT:-5093}"
API="http://localhost:$PORT"
SINK="${TATVAOS_MAIL_SINK:-http://127.0.0.1:5198/mail}"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/recovery-admin-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

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
step() { printf "\n>> %s\n" "$1"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
xff() { printf "10.5.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" -H "X-Forwarded-For: $(xff)" ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
login() { post "/api/auth/login" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
# mail_to ADDRESS -> how many messages the sink has seen addressed to it
mail_to() { curl -s "$SINK" | ADDR="$1" "$PY" -c "import sys,json,os; print(sum(1 for m in json.load(sys.stdin) if os.environ['ADDR'] in m.get('to', [])))" | tr -d "\r"; }

HR="hr@techvein.local"
API_PID=""
cleanup() {
    PG "UPDATE core.users SET recovery_email=NULL, recovery_email_verified_at=NULL, recovery_email_token_hash=NULL, recovery_email_token_sent_at=NULL, invite_token_hash=NULL, password_reset_hash=NULL, password_reset_sent_at=NULL, password_reset_attempts=0 WHERE email='$HR'" >/dev/null
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

printf "\n  Recovery email today - the facts 0009 builds on\n  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. The mail sink, the API, the owner, and a colleague with a password"
same "the local mail sink answers" "$(curl -s -o /dev/null -w "%{http_code}" "$SINK")" "200"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5871
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
OWNER=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "owner sign-in failed"; exit 1; }
HR_ID=$(PG "SELECT id FROM core.users WHERE email='$HR'")
PG "UPDATE core.users SET recovery_email=NULL, recovery_email_verified_at=NULL, mfa_enabled=false, mfa_secret_ref=NULL, locked_until=NULL, failed_login_count=0, status='active', password_reset_hash=NULL, password_reset_sent_at=NULL, password_reset_attempts=0 WHERE id='$HR_ID'" >/dev/null
r=$(post "/api/org/users/$HR_ID/reset-password" "{}" "$OWNER")
PW=$(body "$r" | j "d.get('temporaryPassword') or ''")
[ -n "$PW" ] && pass "the colleague has a password" || { fail "no password: $(body "$r" | head -c 160)"; exit 1; }

step "A. Send sign-in link mails an address nobody has confirmed"
UNCONF="unconfirmed-$RUN@example.test"
PG "UPDATE core.users SET recovery_email='$UNCONF', recovery_email_verified_at=NULL WHERE id='$HR_ID'" >/dev/null
same "(the row really holds an UNconfirmed address)" "$(PG "SELECT recovery_email_verified_at IS NULL FROM core.users WHERE id='$HR_ID'")" "t"
r=$(post "/api/org/users/$HR_ID/signin-link" "{}" "$OWNER")
same "Send sign-in link is accepted" "$(status "$r")" "200"
same "...and the link is mailed to the unconfirmed address" "$(mail_to "$UNCONF")" "1"

step "B. Forgot password -> recovery email mails a CONFIRMED address, no administrator involved"
CONF="confirmed-$RUN@example.test"
PG "UPDATE core.users SET recovery_email='$CONF', recovery_email_verified_at=now(), invite_token_hash=NULL WHERE id='$HR_ID'" >/dev/null
r=$(post "/api/auth/password/forgot-recovery" "{\"recoveryEmail\":\"$CONF\"}")
same "the public route answers" "$(status "$r")" "200"
same "...and a reset link is mailed to the confirmed address" "$(mail_to "$CONF")" "1"
same "...with no signed-in person at all (the route is anonymous)" "$(PG "SELECT count(*) FROM core.users WHERE id='$HR_ID' AND password_reset_hash IS NOT NULL")" "1"

step "C. The person's own change keeps no previous address"
r=$(login "$HR" "$PW")
HRTOKEN=$(body "$r" | j "d.get('accessToken') or ''")
[ -n "$HRTOKEN" ] && pass "the colleague signs in" || { fail "colleague sign-in failed: $(body "$r" | head -c 160)"; exit 1; }
NEWADDR="changed-$RUN@example.test"
# Calibrates the last check below: the same query must FIND the old address
# while it is still on the row, or its later 0 would prove nothing.
same "(before the change, the row query finds the confirmed address)"     "$(PG "SELECT count(*) FROM core.users u WHERE u.id='$HR_ID' AND to_jsonb(u)::text LIKE '%$CONF%'")" "1"
r=$(post "/api/auth/recovery-email" "{\"email\":\"$NEWADDR\",\"currentPassword\":\"$PW\"}" "$HRTOKEN")
same "they change their recovery email" "$(status "$r")" "200"
same "...recovery_email is the NEW address at once, before it is confirmed" "$(PG "SELECT recovery_email || '/' || (recovery_email_verified_at IS NULL) FROM core.users WHERE id='$HR_ID'")" "$NEWADDR/true"
same "...and the previous confirmed address is in no column of the row" \
    "$(PG "SELECT count(*) FROM core.users u WHERE u.id='$HR_ID' AND to_jsonb(u)::text LIKE '%$CONF%'")" "0"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
