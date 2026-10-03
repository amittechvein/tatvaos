#!/usr/bin/env bash
#
# TatvaOS - two-step verification recovery codes, as the API issues them.
#
# WHY THIS EXISTS. 0024-mfa.sql stores recovery codes as a fast, unsalted
# SHA-256 on the argument that they are "80 bits of our own randomness, so
# there is nothing to brute-force". Until 27 Sept 2026 they were 10 symbols
# from a 32-symbol alphabet: 50 bits. A leaked table was about a GPU-day from
# every code in it, and nothing checked the claim. Mr. Singh, 27 Sept: "fix the
# entropy now, and it costs nothing" - nobody had MFA on. This file makes the
# claim a check.
#
#   1. a person enrols (begin -> a real TOTP code -> confirm) and gets codes
#   2. every code is >= 80 bits: 16 symbols from the 32-symbol alphabet
#      (measured from the codes, not read from the source), all distinct
#   3. only the hash is stored: 10 rows, 64 hex characters each, and no row
#      holds any code's text
#   4. a code signs in (typed in lower case, without dashes: normalised)
#   5. the same code a second time is refused
#
# No test existed for MFA before this one. No mail server, no SMS.
# Its own throwaway database on the WSL Postgres (tests/lib/throwaway-db.sh).
# Build first:  dotnet build apps/api -c Release
# TATVAOS_ROOT=<another checkout> runs the same checks against that build
# (how the red run on main was taken).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_MFA_TEST_PORT:-5095}"
API="http://localhost:$PORT"
SCRATCH="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/mfa-codes-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

# ITS OWN DATABASE (house rule 13; Mr. Singh, 29 Sept 2026). Until then this
# ran in the shared local database, where another session's unmerged change
# could make it fail - or pass for the wrong reason. tests/lib/throwaway-db.sh
# builds a new one from every file in local/postgres/init/ (applied twice: the
# re-run check), and cleanup() drops it, pass or fail. A caller that sets
# TATVAOS_PSQL (CI, with its own fresh database) is still obeyed.
TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create mfa || exit 2
    TDB_USED=1
    TATVAOS_PG_HOST="$TDB_HOST"
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
xff() { printf "10.6.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" -H "X-Forwarded-For: $(xff)" ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
login() { post "/api/auth/login" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
# totp BASE32_SECRET -> the current six-digit code (RFC 6238, SHA-1, 30 s)
totp() { SECRET="$1" "$PY" -c '
import os, time, hmac, hashlib, base64, struct
s = os.environ["SECRET"].upper(); s += "=" * (-len(s) % 8)
key = base64.b32decode(s)
h = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
o = h[-1] & 15
print("%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7fffffff) % 1000000))' | tr -d "\r"; }

HR="hr@techvein.local"
reset_mfa() { PG "UPDATE core.users SET mfa_enabled=false, mfa_secret_ref=NULL, mfa_pending_secret=NULL, mfa_last_step=NULL, locked_until=NULL, failed_login_count=0 WHERE email='$HR'" >/dev/null
              PG "DELETE FROM core.mfa_recovery_codes WHERE user_id=(SELECT id FROM core.users WHERE email='$HR')" >/dev/null; }
API_PID=""
cleanup() {
    # A throwaway database is dropped below; resetting it first is pointless.
    [ -z "$TDB_USED" ] && reset_mfa
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    # AFTER the API has stopped, so nothing is connected when it goes.
    [ -n "$TDB_USED" ] && tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
# Replaces the helper's own drop trap: cleanup() calls tdb_drop itself.
trap cleanup EXIT

printf "\n  MFA recovery codes\n  tree under test: %s\n  database: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. Start the API; the colleague gets a password"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=${TDB_NAME:-tatvaos_mail};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

reset_mfa
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
# A fresh database (CI) seeds the owner with no phone; OTP sign-in needs one.
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
OWNER=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "owner sign-in failed"; exit 1; }
HR_ID=$(PG "SELECT id FROM core.users WHERE email='$HR'")
PW=$(body "$(post "/api/org/users/$HR_ID/reset-password" "{}" "$OWNER")" | j "d.get('temporaryPassword') or ''")
[ -n "$PW" ] && pass "the colleague has a password" || { fail "no password"; exit 1; }
TOKEN=$(body "$(login "$HR" "$PW")" | j "d.get('accessToken') or ''")
[ -n "$TOKEN" ] && pass "the colleague signs in (no MFA yet)" || { fail "colleague sign-in failed"; exit 1; }

step "1. Enrol: begin, a real authenticator code, confirm"
SECRET=$(body "$(post "/api/auth/mfa/begin" "{}" "$TOKEN")" | j "d.get('secret') or ''")
[ -n "$SECRET" ] && pass "begin returns a secret" || { fail "no secret"; exit 1; }
r=$(post "/api/auth/mfa/confirm" "{\"code\":\"$(totp "$SECRET")\"}" "$TOKEN")
same "confirm with the current code" "$(status "$r")" "200"
body "$r" | j "'\n'.join(d.get('recoveryCodes') or [])" > "$SCRATCH/codes.txt"
same "ten recovery codes issued" "$(grep -c . "$SCRATCH/codes.txt")" "10"

step "2. Each code carries at least 80 bits"
BITS=$(CODES="$SCRATCH/codes.txt" "$PY" -c '
import os, math
alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
codes = [c.strip() for c in open(os.environ["CODES"]) if c.strip()]
worst = min(len([ch for ch in c if ch != "-"]) for c in codes)
foreign = [c for c in codes if any(ch not in alphabet + "-" for ch in c)]
print(-1 if foreign else int(worst * math.log2(len(alphabet))))' | tr -d "\r")
if [ -n "$BITS" ] && [ "$BITS" -ge 80 ]; then pass "every code >= 80 bits  [got $BITS]"
else fail "a code carries only $BITS bits (-1 = a symbol outside the alphabet); 0024-mfa.sql's unsalted SHA-256 needs 80"; fi
same "all ten are different" "$(sort -u "$SCRATCH/codes.txt" | grep -c .)" "10"

step "3. Only the hash is stored"
same "ten rows for the colleague" "$(PG "SELECT count(*) FROM core.mfa_recovery_codes WHERE user_id='$HR_ID'")" "10"
same "each is 64 hex characters (SHA-256)" "$(PG "SELECT count(*) FROM core.mfa_recovery_codes WHERE user_id='$HR_ID' AND code_hash ~ '^[0-9a-f]{64}\$'")" "10"
FIRST=$(head -1 "$SCRATCH/codes.txt"); RAW=$(printf '%s' "$FIRST" | tr -d '-')
same "(the query finds text that IS there: its own hash)" "$(PG "SELECT count(*) FROM core.mfa_recovery_codes u WHERE u.user_id='$HR_ID' AND to_jsonb(u)::text LIKE '%' || (SELECT code_hash FROM core.mfa_recovery_codes WHERE user_id='$HR_ID' LIMIT 1) || '%'")" "1"
same "no row holds a code's text" "$(PG "SELECT count(*) FROM core.mfa_recovery_codes u WHERE u.user_id='$HR_ID' AND (to_jsonb(u)::text ILIKE '%$FIRST%' OR to_jsonb(u)::text ILIKE '%$RAW%')")" "0"

step "4. A code signs in once"
challenge() { body "$(login "$HR" "$PW")" | j "d.get('challenge') or ''"; }
CH=$(challenge)
[ -n "$CH" ] && pass "password now asks for a second step" || { fail "no challenge after enrolment"; exit 1; }
TYPED=$(printf '%s' "$RAW" | tr 'A-Z' 'a-z')
r=$(post "/api/auth/mfa/verify" "{\"challenge\":\"$CH\",\"code\":\"$TYPED\"}")
same "the first code, lower case and without dashes, signs in" "$(status "$r")/$(body "$r" | j "'token' if d.get('accessToken') else 'none'")" "200/token"
r=$(post "/api/auth/mfa/verify" "{\"challenge\":\"$(challenge)\",\"code\":\"$FIRST\"}")
same "the same code a second time is refused" "$(status "$r")" "401"
same "...and is marked used" "$(PG "SELECT count(*) FROM core.mfa_recovery_codes WHERE user_id='$HR_ID' AND used_at IS NOT NULL")" "1"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
