#!/usr/bin/env bash
# TatvaOS People — the employee-ID scheme (Phase 0), end to end through the API.
#
#   1. looking writes nothing: no row, the defaults, "0001"
#   2. an administrator saves a scheme; the prefix is upper-cased; audited
#   3. the digit count is a MINIMUM, never a cut: 10000 with 4 digits is
#      10000 (lpad() alone would have said 1000 - the database's function
#      is the preview, so this checks the one definition)
#   4. nonsense is refused with a sentence, by the API and by the database,
#      and a refusal changes nothing
#   5. manual mode: no "next ID", the scheme is kept
#   6. an employee gets 403; another organisation sees only its own
#
# Builds its own throwaway database (house rule 13) unless TATVAOS_PSQL is
# given. Starts its own API on :5109 (needs `dotnet build -c Release` first,
# like the other API suites).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_EMPID_TEST_PORT:-5109}"
API="http://localhost:$PORT"
SCRATCH="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/empid-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'

TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create empid || exit 2
    TDB_USED=1
    TATVAOS_PG_HOST="$TDB_HOST"
fi
PG()    { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }
PGRAW() { $TATVAOS_PSQL "$1" 2>&1 | grep -v "^wsl:" | tr -d "\r"; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
jq_() { printf '%s' "$1" | j "$2"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
brief() { printf '%s' "$1" | head -c 200 | tr '\n' ' '; }
# An empty operand is a failure, never a match (testing-false-greens).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
# A here-string, not printf | grep -q (pipefail SIGPIPE, PR 386).
has() {
    if [ -z "$3" ]; then fail "$1 - nothing to look for"
    elif grep -qiF -- "$3" <<< "$2"; then pass "$1"
    else fail "$1 - '$3' not in: $(brief "$2")"; fi
}
call() {
    curl -s -w '\n%{http_code}' -X "$2" "$API/api$3" -H 'Content-Type: application/json' \
         ${1:+-H "Authorization: Bearer $1"} ${4:+-d "$4"}
}
expect() {  # label want-status response [sentence fragment]
    local got; got=$(status "$3")
    if [ "$got" != "$2" ]; then fail "$1 - answered $got, wanted $2: $(brief "$(body "$3")")"; return; fi
    if [ -n "${4:-}" ]; then has "$1 ($2)" "$(body "$3")" "$4"; else pass "$1 ($2)"; fi
}
# The scheme as one comparable string: mode/prefix/digits/next/nextId/saved.
shape() { jq_ "$(body "$1")" "f\"{d['mode']}/{d['prefix']}/{d['digits']}/{d['nextNumber']}/{d['nextId']}/{d['saved']}\""; }
row() { PG "SELECT coalesce((SELECT mode||'/'||prefix||'/'||digits||'/'||next_number FROM people.employee_id_settings WHERE tenant_id='$1'),'(none)')"; }

API_PID=""
cleanup() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    # On a caller's database, leave nothing behind; a throwaway one is dropped.
    [ -z "$TDB_USED" ] && PG "DELETE FROM people.employee_id_settings WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
    [ -n "$TDB_USED" ] && tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  People: the employee-ID scheme\n  tree under test: %s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. Start the API and sign in"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
if curl -s -o /dev/null "$API/health" 2>/dev/null; then
    fail "something is already listening on port $PORT - stop it, or set TATVAOS_EMPID_TEST_PORT"; exit 1
fi
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=${TATVAOS_PG_HOST:-localhost};Port=5432;Database=${TDB_NAME:-${TATVAOS_PGDATABASE:-tatvaos_mail}};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

# The three standard test phones (tests/support/test-phones.sh), and ONLY
# those. The first version of this suite gave the owner a number of its own;
# on CI's shared database the owner kept it, and the next suite (0009), which
# sets +919999900001 only where the phone is empty, could not sign in
# (PR 409, run 37816891716). A suite must leave the people as it found them.
. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
signin() {
    local phone="$1" code
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$phone'" >/dev/null
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' \
         -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}
# The seed predates the role names the policy uses (as test-careers.sh notes).
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET role='org_admin' WHERE email='principal@abcschool.local' AND role='admin'" >/dev/null
same "the employee really is not an administrator" \
    "$(PG "SELECT (role NOT IN ('org_owner','org_admin','owner','admin'))::text FROM core.users WHERE email='hr@techvein.local'")" "true"
TOKEN=$(signin '+919999900001')
EMP=$(signin '+919999900002')
OTHER=$(signin '+919999900003')
[ -n "$TOKEN" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
[ -n "$EMP" ]   && pass "signed in as a Techvein employee" || fail "employee sign-in failed"
[ -n "$OTHER" ] && pass "signed in as the ABC School admin" || fail "School admin sign-in failed"
PG "DELETE FROM people.employee_id_settings WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")

step "1. Looking writes nothing"
r=$(call "$TOKEN" GET /org/employee-ids)
expect "an administrator reads the scheme" 200 "$r"
same "nothing saved yet: the defaults, and the first ID would be 0001" "$(shape "$r")" "auto//4/1/0001/False"
same "and looking did not write a row" "$(row "$TECHVEIN")" "(none)"

step "2. An administrator saves a scheme"
r=$(call "$TOKEN" PUT /org/employee-ids '{"mode":"auto","prefix":"tv-","digits":4,"nextNumber":7}')
expect "saving TV-, four digits, starting at 7" 200 "$r"
same "the prefix is upper-cased, and the next ID is TV-0007" "$(shape "$r")" "auto/TV-/4/7/TV-0007/True"
same "the row holds exactly that" "$(row "$TECHVEIN")" "auto/TV-/4/7"
same "it is audited, with what it was and what it became" \
    "$(PG "SELECT coalesce(before_state::text,'null')||' -> '||(after_state->>'Prefix')||(after_state->>'NextNumber') FROM core.audit_logs WHERE id > $FLOOR AND action='employee_ids.updated' AND tenant_id='$TECHVEIN' ORDER BY id DESC LIMIT 1")" \
    "null -> TV-7"
same "a GET now reads the saved scheme" "$(shape "$(call "$TOKEN" GET /org/employee-ids)")" "auto/TV-/4/7/TV-0007/True"

step "3. The digit count is a minimum, never a cut"
same "number 10000 with four digits is TV-10000, not TV-1000" \
    "$(shape "$(call "$TOKEN" PUT /org/employee-ids '{"mode":"auto","prefix":"TV-","digits":4,"nextNumber":10000}')")" "auto/TV-/4/10000/TV-10000/True"
same "the database function says the same, directly" \
    "$(PG "SELECT people.format_employee_id('TV-', 4, 10000)")" "TV-10000"
same "the largest number at eight digits" \
    "$(shape "$(call "$TOKEN" PUT /org/employee-ids '{"mode":"auto","prefix":"","digits":8,"nextNumber":99999999}')")" "auto//8/99999999/99999999/True"
same "one digit, number 5" "$(PG "SELECT people.format_employee_id('ABC/', 1, 5)")" "ABC/5"
call "$TOKEN" PUT /org/employee-ids '{"mode":"auto","prefix":"TV-","digits":4,"nextNumber":7}' >/dev/null

step "4. Nonsense is refused, and changes nothing"
expect "mode 'sometimes'" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"mode":"sometimes"}')" "auto or manual"
expect "a space in the prefix" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"prefix":"TV 1"}')" "only letters, digits"
expect "a prefix of eleven characters" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"prefix":"ABCDEFGHIJK"}')" "at most 10"
expect "zero digits" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"digits":0}')" "between 1 and 8"
expect "nine digits" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"digits":9}')" "between 1 and 8"
expect "next number 0" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"nextNumber":0}')" "between 1 and"
expect "next number 100,000,000" 400 "$(call "$TOKEN" PUT /org/employee-ids '{"nextNumber":100000000}')" "between 1 and"
same "after all of that, the scheme is as it was" "$(row "$TECHVEIN")" "auto/TV-/4/7"
for bad in "prefix = 'tv-'" "prefix = 'TV 1'" "digits = 9" "next_number = 0" "mode = 'sometimes'"; do
    out=$(PGRAW "UPDATE people.employee_id_settings SET $bad WHERE tenant_id='$TECHVEIN'")
    has "the database refuses $bad as well" "$out" "violates check constraint"
done
same "and the row is still as it was" "$(row "$TECHVEIN")" "auto/TV-/4/7"

step "5. Manual mode keeps the scheme and offers no next ID"
same "manual: nothing is generated, so no next ID" \
    "$(shape "$(call "$TOKEN" PUT /org/employee-ids '{"mode":"manual","prefix":"TV-","digits":4,"nextNumber":7}')")" "manual/TV-/4/7/None/True"
call "$TOKEN" PUT /org/employee-ids '{"mode":"auto","prefix":"TV-","digits":4,"nextNumber":7}' >/dev/null

step "6. Who may see and change it"
expect "an employee cannot read it" 403 "$(call "$EMP" GET /org/employee-ids)"
expect "nor change it" 403 "$(call "$EMP" PUT /org/employee-ids '{"prefix":"HACK"}')"
same "ABC School's admin sees only their own (nothing saved)" "$(shape "$(call "$OTHER" GET /org/employee-ids)")" "auto//4/1/0001/False"
expect "ABC School saves its own scheme" 200 "$(call "$OTHER" PUT /org/employee-ids '{"prefix":"ABC/","digits":3,"nextNumber":1}')"
same "ABC School's row" "$(row "$SCHOOL")" "auto/ABC//3/1"
same "Techvein's row is untouched" "$(row "$TECHVEIN")" "auto/TV-/4/7"
same "and Techvein still reads its own" "$(shape "$(call "$TOKEN" GET /org/employee-ids)")" "auto/TV-/4/7/TV-0007/True"
expect "signed out: refused" 401 "$(call "" GET /org/employee-ids)"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
