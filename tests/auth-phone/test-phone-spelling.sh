#!/usr/bin/env bash
#
# Issue #327: a phone number stored in one spelling and typed in another must
# still sign in (OTP), and must be stored in ONE spelling from now on.
#
# Proved:
#   1. stored +91XXXXXXXXXX, typed as "XXXXX XXXXX", "0XXXXXXXXXX",
#      "91XXXXXXXXXX", "+91 XXXXX XXXXX": the OTP is issued and verifies
#   2. the migration (20261009-z-phone-canonical.sql) rewrites bare rows to
#      +91 form, re-runs with 0 changes, and LEAVES a colliding pair alone
#      with a WARNING naming the count
#   3. after it, the rewritten person signs in by the bare spelling; the
#      colliding pair fails closed whichever spelling is typed (a lookup
#      matches EVERY spelling of a number, so two live rows = two matches)
#   4. an administrator typing "98765 43210" as a recovery phone stores
#      +919876543210; an 8-digit landline is stored as before (not refused)
#
# RED FIRST: with Stored() swapped back to Normalise() in AuthEndpoints (a
# mutation build, not committed), section 1 fails on every spelling but the
# canonical one. Recorded on the PR.
#
# Setup as tests/invitations/test-send-to-pending.sh: WSL or Docker Postgres,
# the API built in Release; rule 13 - run under tests/lib/throwaway-db.sh.
#   dotnet build apps/api -c Release
#   bash tests/auth-phone/test-phone-spelling.sh
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_PHONE_TEST_PORT:-5096}"
API="http://localhost:$PORT"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/phone-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
MIG="$ROOT/local/postgres/init/20261009-z-phone-canonical.sql"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 & WSL_KEEPALIVE=$!; sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }
# The migration file on stdin (a /c/... path handed to wsl is mangled), stderr kept: WARNING lines are asserted.
PGFILE() { ${TATVAOS_PSQL% -Atc} -v ON_ERROR_STOP=1 -q < "$1" 2>&1 | grep -v "^wsl:" | tr -d "\r"; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  ok    %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  FAIL  %s\n' "$1"; }
step() { printf '\n>> %s\n' "$1"; }
same() { if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"; elif [ "$2" = "$3" ]; then pass "$1  [got $2]"; else fail "$1 - got [$2], wanted [$3]"; fi; }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 - '$3' not in [$(printf '%s' "$2" | head -c 240)]"; fi; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
col() { PG "SELECT coalesce($2::text,'none') FROM core.users WHERE email='$1'"; }
kill_port() { "$PY" - "$1" <<'PYEOF' 2>/dev/null
import subprocess, sys
port = sys.argv[1]
out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
for line in out.splitlines():
    if f":{port} " in line and "LISTENING" in line:
        subprocess.run(["taskkill", "/F", "/PID", line.split()[-1]], capture_output=True)
PYEOF
}
API_PID=""; MADE=""
cleanup() {
    [ -n "$MADE" ] && PG "DELETE FROM core.users WHERE email IN ($MADE)" >/dev/null
    PG "UPDATE core.users SET login_otp_sent_at = NULL, login_otp_attempts = 0 WHERE email IN ('amit@techvein.local','hr@techvein.local','principal@abcschool.local')" >/dev/null
    [ -n "$API_PID" ] && { kill_port "$PORT"; kill "$API_PID" >/dev/null 2>&1 || true; }
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Phone spelling at sign-in (#327)\n  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. Database, test phones, API"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
same "core.phone_canonical exists (the migration ran)" "$(PG "SELECT count(*) FROM pg_proc WHERE proname='phone_canonical'")" "1"
. "$HERE/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="${TDB_CONN:-Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true}"
export Smtp__Host=127.0.0.1 Smtp__Port=1
kill_port "$PORT"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

# One OTP per spelling: the resend throttle hides the devCode on a second
# request inside 60 s, so the row's clock is cleared before each one.
otp_signs_in() { # otp_signs_in EMAIL TYPED -> "yes"|"no:<why>"
    PG "UPDATE core.users SET login_otp_sent_at = NULL, login_otp_attempts = 0 WHERE email='$1'" >/dev/null
    local r code t
    r=$(post /api/auth/otp/request "{\"phone\":\"$2\"}")
    code=$(body "$r" | j "d.get('devCode') or ''")
    [ -n "$code" ] || { echo "no:request gave no code ($(status "$r"): $(body "$r" | head -c 120))"; return; }
    r=$(post /api/auth/otp/verify "{\"phone\":\"$2\",\"code\":\"$code\"}")
    t=$(body "$r" | j "d.get('accessToken') or ''")
    [ -n "$t" ] && echo yes || echo "no:verify $(status "$r")"
}

step "1. Stored +919999900001; typed four other ways"
same "stored canonical" "$(col amit@techvein.local phone)" "+919999900001"
for typed in "+91 99999 00001" "99999 00001" "09999900001" "91 9999900001"; do
    same "typed [$typed] signs in" "$(otp_signs_in amit@techvein.local "$typed")" "yes"
done
same "a different number does not" "$(otp_signs_in amit@techvein.local "99999 00009" | cut -c1-2)" "no"

step "2. The migration rewrites bare rows, re-runs clean, leaves a colliding pair"
PG "UPDATE core.users SET phone='9999900002' WHERE email='hr@techvein.local'" >/dev/null
PG "UPDATE core.users SET phone='09999900003' WHERE email='principal@abcschool.local'" >/dev/null
# A colliding pair: two live copies of hr with one number in two spellings.
PA="pair-a-$RUN@techvein.local"; PB="pair-b-$RUN@techvein.local"; MADE="'$PA','$PB'"
PG "CREATE TEMP TABLE t AS SELECT * FROM core.users WHERE email='hr@techvein.local'; UPDATE t SET id=gen_random_uuid(), email='$PA', phone='9999900077'; INSERT INTO core.users SELECT * FROM t; UPDATE t SET id=gen_random_uuid(), email='$PB', phone='+919999900077'; INSERT INTO core.users SELECT * FROM t;" >/dev/null
same "pair seeded" "$(PG "SELECT count(*) FROM core.users WHERE email IN ($MADE) AND status='active'")" "2"
out=$(PGFILE "$MIG")
same "hr rewritten to +91" "$(col hr@techvein.local phone)" "+919999900002"
same "principal's leading 0 dropped" "$(col principal@abcschool.local phone)" "+919999900003"
same "pair A untouched" "$(col "$PA" phone)" "9999900077"
same "pair B untouched" "$(col "$PB" phone)" "+919999900077"
has  "…and WARNED, naming two" "$out" "WARNING:  phone canonical: 2 live account(s)"
has  "the rewrite was reported" "$out" "2 row(s) rewritten"
out2=$(PGFILE "$MIG")
same "re-run: nothing left to rewrite (no NOTICE)" "$(printf '%s' "$out2" | grep -c 'rewritten')" "0"
has  "re-run: the pair is still warned about" "$out2" "2 live account(s)"
same "a landline is not touched by the rule" "$(PG "SELECT coalesce(core.phone_canonical('02212345678'),'null')")" "null"
same "a +44 number is kept" "$(PG "SELECT core.phone_canonical('+44 7700 900123')")" "+447700900123"

step "3. After the rewrite: the bare spelling signs hr in; the pair fails closed"
same "hr typed bare" "$(otp_signs_in hr@techvein.local "9999900002")" "yes"
same "principal typed with 0" "$(otp_signs_in principal@abcschool.local "0 99999 00003")" "yes"
PG "UPDATE core.users SET login_otp_sent_at = NULL WHERE email IN ($MADE)" >/dev/null
# Both spellings: the first run (25/26) found the +91 one reached pair B
# alone, so A was silently unreachable by phone; now both are two matches.
for typed in "9999900077" "+919999900077"; do
    PG "UPDATE core.users SET login_otp_sent_at = NULL WHERE email IN ($MADE)" >/dev/null
    r=$(post /api/auth/otp/request "{\"phone\":\"$typed\"}")
    same "the pair's number typed [$typed]: 200 but no code for anyone" "$(status "$r")/$(body "$r" | j "d.get('devCode') or 'none'")" "200/none"
done

step "4. An administrator's typed recovery phone is stored canonical"
code=$(otp_signs_in amit@techvein.local "+919999900001" >/dev/null; PG "SELECT 1")  # ensure clock cleared
PG "UPDATE core.users SET login_otp_sent_at = NULL WHERE email='amit@techvein.local'" >/dev/null
r=$(post /api/auth/otp/request '{"phone":"+919999900001"}'); code=$(body "$r" | j "d.get('devCode') or ''")
r=$(post /api/auth/otp/verify "{\"phone\":\"+919999900001\",\"code\":\"$code\"}"); OWNER=$(body "$r" | j "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "owner sign-in failed"; exit 1; }
DOMAIN_ID=$(PG "SELECT id FROM core.domains WHERE fqdn='techvein.local'")
mk() { # mk LOCALPART PHONE -> stored phone
    local e="$1@techvein.local"; MADE="$MADE,'$e'"
    post /api/org/users "{\"localPart\":\"$1\",\"displayName\":\"Phone Test\",\"domainId\":\"$DOMAIN_ID\",\"password\":\"Typed-by-admin-$RUN!\",\"recoveryPhone\":\"$2\"}" "$OWNER" >/dev/null
    col "$e" phone
}
same "\"98765 43210\" stored as +919876543210" "$(mk "ph-a-$RUN" "98765 43210")" "+919876543210"
same "\"0 98765 43211\" stored as +919876543211" "$(mk "ph-b-$RUN" "0 98765 43211")" "+919876543211"
same "an 8-digit landline is stored as before, not refused" "$(mk "ph-c-$RUN" "2212 3456")" "22123456"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
