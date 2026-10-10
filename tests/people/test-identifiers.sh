#!/usr/bin/env bash
# TatvaOS People — Aadhaar, PAN and bank details (decision 0015), end to end.
# HELD FOR MR. SINGH with the code it tests.
#
# 0015 §8's checks, each meant to go red when its guard is removed:
#   2. AT REST: the stored ciphertext contains no value, in text, hex or base64
#   3. BINDING: a ciphertext copied onto another employee will not open; the
#      reveal fails loudly and is recorded as failed
#   4. FAIL CLOSED: the API without its identifier keys saves and reveals
#      nothing (503) - no fallback to another key
#   5. PER-READ AUDIT: one read row per value revealed; no read row and no
#      audit row holds a value or its last four
#   7. LOGS: under Development logging (EF prints every parameter) the API's
#      log never contains a value - encrypted before EF sees it
# and who may do what (Amit, 10 Oct 2026):
#   * masked view: People HR, the named readers, the employee - never a
#     manager, never another organisation
#   * reveal: the named readers (an owner only after naming themselves,
#     recorded) and the employee for their own; a reason every time
#   * the employee can see who has seen theirs
#   * Aadhaar: full number, Verhoeff-checked, never a lookup hash; PAN and
#     account: a duplicate on another employee refused without naming them
#
# Builds its own throwaway database (rule 13) unless TATVAOS_PSQL is given.
# Starts its own API on :5115, twice (the second time without keys).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_IDENTIFIERS_TEST_PORT:-5115}"
API="http://localhost:$PORT"
SCRATCH="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/identifiers-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'

TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create identifiers || exit 2
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
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 - nothing to look for"
    elif grep -qiF -- "$3" <<< "$2"; then pass "$1"
    else fail "$1 - '$3' not in: $(brief "$2")"; fi
}
call() {
    curl -s -w '\n%{http_code}' -X "$2" "$API/api$3" -H 'Content-Type: application/json' \
         ${1:+-H "Authorization: Bearer $1"} ${4:+-d "$4"}
}
expect() {
    local got; got=$(status "$3")
    if [ "$got" != "$2" ]; then fail "$1 - answered $got, wanted $2: $(brief "$(body "$3")")"; return; fi
    if [ -n "${4:-}" ]; then has "$1 ($2)" "$(body "$3")" "$4"; else pass "$1 ($2)"; fi
}
id_of() { jq_ "$(body "$1")" "d['id']"; }

API_PID=""
stop_api() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
        API_PID=""
        for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
    fi
}
cleanup() {
    stop_api
    if [ -z "$TDB_USED" ]; then
        PG "DELETE FROM people.employees WHERE tenant_id IN ('$TECHVEIN','$SCHOOL') AND full_name LIKE 'idt-%';
            DELETE FROM people.identifier_readers WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
            DELETE FROM people.identifier_keys WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');" >/dev/null
    fi
    [ -n "$TDB_USED" ] && tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  People: Aadhaar, PAN and bank details (0015)\n  tree under test: %s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

# Test keys, made here and never printed. Not production keys.
ID_KEY=$("$PY" -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())" | tr -d '\r')
LOOKUP_KEY=$("$PY" -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())" | tr -d '\r')

start_api() {   # start_api with-keys|without-keys
    for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
    if curl -s -o /dev/null "$API/health" 2>/dev/null; then
        fail "something is already listening on port $PORT - stop it, or set TATVAOS_IDENTIFIERS_TEST_PORT"; exit 1
    fi
    if [ "$1" = with-keys ]; then export People__IdentifierKey="$ID_KEY" People__IdentifierLookupKey="$LOOKUP_KEY"
    else unset People__IdentifierKey People__IdentifierLookupKey; fi
    env "Logging__LogLevel__Microsoft.EntityFrameworkCore.Database.Command=Information" \
        dotnet run --no-build -c Release --project "$PROJ" >> "$LOG" 2>&1 &
    API_PID=$!
    for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
    curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up ($1)" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
}

step "0. Start the API with keys, sign in, add three employees"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=${TATVAOS_PG_HOST:-localhost};Port=5432;Database=${TDB_NAME:-${TATVAOS_PGDATABASE:-tatvaos_mail}};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
# Development logging prints EVERY EF parameter (check 7 depends on that).
# (a dotted name cannot be exported in bash; start_api passes it through env)
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
start_api with-keys

. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set"; exit 1; }
signin() {
    local phone="$1" code
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$phone'" >/dev/null
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' \
         -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}
PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET role='org_admin' WHERE email='principal@abcschool.local' AND role='admin'" >/dev/null
OWNER_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
STAFF_ID=$(PG "SELECT id FROM core.users WHERE email='hr@techvein.local'")
PRINCIPAL_ID=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
OWNER=$(signin '+919999900001'); STAFF=$(signin '+919999900002'); OTHER=$(signin '+919999900003')
[ -n "$OWNER" ] && [ -n "$STAFF" ] && [ -n "$OTHER" ] && pass "three sign-ins" || { fail "sign-in failed"; exit 1; }
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")
expect "the owner names themselves People HR (to add employees)" 200 "$(call "$OWNER" PUT /people/hr/$OWNER_ID)"
mk() { call "$OWNER" POST /people/employees "$1"; }
H=$(id_of "$(mk "{\"fullName\":\"idt-Hari\",\"userId\":\"$STAFF_ID\",\"joinedOn\":\"2025-01-01\"}")")
X=$(id_of "$(mk "{\"fullName\":\"idt-Xena\",\"reportsTo\":\"$H\",\"joinedOn\":\"2025-01-01\"}")")
Y=$(id_of "$(mk '{"fullName":"idt-Yusuf","joinedOn":"2025-01-01"}')")
printf '%s%s%s' "$H" "$X" "$Y" | grep -qE '^[0-9a-f-]{108}$' && pass "fixture: Hari (staff sign-in, manages Xena), Xena, Yusuf" || { fail "fixtures missing"; exit 1; }

# A valid Aadhaar (Verhoeff check digit computed here) and one with a typo.
AADHAAR=$("$PY" -c "
d=[[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
p=[[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]
inv=[0,4,3,2,1,5,6,7,8,9]
s='73519246802'; c=0
for i,ch in enumerate(reversed(s)): c=d[c][p[(i+1)%8][int(ch)]]
print(s+str(inv[c]))" | tr -d '\r')
BAD_AADHAAR="${AADHAAR:0:11}$(( (${AADHAAR:11:1} + 1) % 10 ))"
PAN='KQZPM4821R'; ACCT='501002398877'

step "1. Who sees the masked view"
expect "the employee (Hari) sees his own (empty)" 200 "$(call "$STAFF" GET /people/employees/$H/identifiers)"
expect "Hari, Xena's MANAGER, never sees hers" 404 "$(call "$STAFF" GET /people/employees/$X/identifiers)"
expect "another organisation" 404 "$(call "$OTHER" GET /people/employees/$H/identifiers)"

step "2. Entering values: checked, encrypted, never echoed"
expect "an Aadhaar with a wrong check digit" 400 "$(call "$STAFF" PUT /people/employees/$H/identifiers/aadhaar "{\"value\":\"$BAD_AADHAAR\"}")" "check digit"
r=$(call "$STAFF" PUT /people/employees/$H/identifiers/aadhaar "{\"value\":\"${AADHAAR:0:4} ${AADHAAR:4:4} ${AADHAAR:8:4}\"}")
expect "Hari enters his own Aadhaar (spaces allowed)" 200 "$r"
same "the answer is the last four only" "$(jq_ "$(body "$r")" "d['last4']")" "${AADHAAR:8:4}"
same "the answer does not contain the number" "$(grep -c "$AADHAAR" <<< "$(body "$r")")" "0"
expect "a malformed PAN" 400 "$(call "$OWNER" PUT /people/employees/$H/identifiers/pan '{"value":"ABC123"}')" "five letters"
expect "HR enters Hari's PAN" 200 "$(call "$OWNER" PUT /people/employees/$H/identifiers/pan "{\"value\":\"${PAN,,}\"}")"
expect "and his bank account with IFSC" 200 "$(call "$OWNER" PUT /people/employees/$H/identifiers/bank_account "{\"value\":\"$ACCT\",\"ifsc\":\"hdfc0001234\"}")"
r=$(call "$OWNER" PUT /people/employees/$Y/identifiers/pan "{\"value\":\"$PAN\"}")
expect "the same PAN on Yusuf is refused" 409 "$r" "already on another employee"
same "without naming whose it is" "$(grep -c 'Hari' <<< "$(body "$r")")" "0"
same "the Aadhaar row has NO lookup hash; PAN and account do" \
    "$(PG "SELECT string_agg(kind||'='||(lookup_hash IS NOT NULL)::text, ',' ORDER BY kind) FROM people.employee_identifiers WHERE employee_id='$H'")" \
    "aadhaar=false,bank_account=true,pan=true"

step "3. At rest: no value anywhere in the stored row (check 2)"
for v in "$AADHAAR" "$PAN" "$ACCT"; do
    b64=$("$PY" -c "import base64,sys; print(base64.b64encode(sys.argv[1].encode()).decode())" "$v" | tr -d '\r')
    hex=$("$PY" -c "import sys; print(sys.argv[1].encode().hex())" "$v" | tr -d '\r')
    same "not in the ciphertext as text, hex or base64 (…${v: -4})" \
        "$(PG "SELECT count(*) FROM people.employee_identifiers
                WHERE position('$v' IN encode(ciphertext,'escape')) > 0
                   OR position('$hex' IN encode(ciphertext,'hex')) > 0
                   OR position('$b64' IN encode(ciphertext,'base64')) > 0
                   OR position('$v' IN coalesce(ifsc,'')||last4||encode(coalesce(lookup_hash,''::bytea),'hex')) > 0")" "0"
done
same "the organisation's data key is stored wrapped (60 bytes), not raw" \
    "$(PG "SELECT string_agg(octet_length(wrapped_key)::text, ',') FROM people.identifier_keys WHERE tenant_id='$TECHVEIN'")" "60"

step "4. Reveal: named people and the employee, a reason, one row each (check 5)"
expect "People HR who is not a named reader cannot reveal" 403 "$(call "$OWNER" POST /people/employees/$H/identifiers/pan/reveal '{"reason":"payroll_setup"}')" "names"
expect "no reason" 400 "$(call "$STAFF" POST /people/employees/$H/identifiers/pan/reveal '{}')" "why"
r=$(curl -s -D "$SCRATCH/h.txt" -w '\n%{http_code}' -X POST "$API/api/people/employees/$H/identifiers/pan/reveal" -H 'Content-Type: application/json' -H "Authorization: Bearer $STAFF" -d '{"reason":"own_record"}')
expect "Hari reveals his own PAN" 200 "$r"
same "and gets the full value" "$(jq_ "$(body "$r")" "d['value']")" "$PAN"
has "the reveal is not cached" "$(cat "$SCRATCH/h.txt")" "no-store"
expect "the owner names themselves a reader" 200 "$(call "$OWNER" PUT /people/identifier-readers/$OWNER_ID)"
same "recorded as appointing themselves" \
    "$(PG "SELECT after_state->>'appointedThemselves' FROM core.audit_logs WHERE id > $FLOOR AND action='identifier_reader.added' ORDER BY id DESC LIMIT 1")" "true"
for k in aadhaar pan bank_account; do
    expect "the reader reveals $k for payroll" 200 "$(call "$OWNER" POST /people/employees/$H/identifiers/$k/reveal '{"reason":"payroll_setup","note":"October run"}')"
done
same "four reveals, four read rows, all shown" \
    "$(PG "SELECT count(*)||'/'||count(*) FILTER (WHERE outcome='shown') FROM people.identifier_reads WHERE employee_id='$H'")" "4/4"
same "Hari can see who has seen his (4)" "$(jq_ "$(body "$(call "$STAFF" GET /people/employees/$H/identifier-reads)")" "str(len(d))")" "4"
for v in "$AADHAAR" "$PAN" "$ACCT" "${AADHAAR:8:4}" "${ACCT:8:4}"; do
    same "no read row and no audit row holds …${v: -4}" \
        "$(PG "SELECT (SELECT count(*) FROM people.identifier_reads WHERE coalesce(note,'')||reason LIKE '%$v%')
                    + (SELECT count(*) FROM core.audit_logs WHERE id > $FLOOR AND coalesce(after_state::text,'')||coalesce(before_state::text,'') LIKE '%$v%')")" "0"
done

step "5. Binding: a ciphertext moved to another person will not open (check 3)"
PG "INSERT INTO people.employee_identifiers (tenant_id, employee_id, kind, ciphertext, key_version, last4)
    SELECT tenant_id, '$Y', kind, ciphertext, key_version, last4 FROM people.employee_identifiers
     WHERE employee_id='$H' AND kind='aadhaar'" >/dev/null
r=$(call "$OWNER" POST /people/employees/$Y/identifiers/aadhaar/reveal '{"reason":"correction"}')
expect "revealing Hari's Aadhaar copied onto Yusuf fails" 500 "$r" "could not be opened"
same "it does not leak the value" "$(grep -c "$AADHAAR" <<< "$(body "$r")")" "0"
same "and is recorded as failed" "$(PG "SELECT outcome FROM people.identifier_reads WHERE employee_id='$Y' ORDER BY id DESC LIMIT 1")" "failed"

step "6. Replacing clears 'verified'; someone who has left is kept as they were"
expect "HR marks the PAN original seen" 200 "$(call "$OWNER" POST /people/employees/$H/identifiers/pan/verify)"
expect "Hari cannot mark his own as verified" 403 "$(call "$STAFF" POST /people/employees/$H/identifiers/pan/verify)"
expect "a new PAN replaces it" 200 "$(call "$OWNER" PUT /people/employees/$H/identifiers/pan '{"value":"KQZPM4821S"}')"
same "and is no longer verified" "$(PG "SELECT (verified_at IS NULL)::text FROM people.employee_identifiers WHERE employee_id='$H' AND kind='pan'")" "true"
expect "Yusuf leaves" 200 "$(call "$OWNER" POST /people/employees/$Y/exit '{"exitOn":"2026-10-31"}')"
expect "nothing new is recorded for someone who has left" 409 "$(call "$OWNER" PUT /people/employees/$Y/identifiers/pan '{"value":"ZZZZZ9999Z"}')" "has left"

step "7. Logs: Development logging prints every parameter - and no value (check 7)"
grep -q "Executed DbCommand" "$LOG" && pass "the API log does record SQL commands (so this check can see)" \
                                    || fail "no SQL commands in the API log - this check would prove nothing"
grep -qF -- "idt-Xena" "$LOG" && pass "and their parameter values (an employee's name is there)" \
                              || fail "parameter values are not logged - the 'never in the log' checks below would prove nothing"
for v in "$AADHAAR" "$PAN" "$ACCT" "KQZPM4821S"; do
    same "the API log never contains …${v: -4}" "$(grep -c -- "$v" "$LOG")" "0"
done

step "8. Fail closed: the same API without its keys (check 4)"
stop_api
start_api without-keys
OWNER=$(signin '+919999900001'); STAFF=$(signin '+919999900002')
same "status (signed in) says not configured" "$(jq_ "$(body "$(call "$OWNER" GET /people/identifiers/status)")" "str(d['configured'])")" "False"
expect "saving is refused" 503 "$(call "$OWNER" PUT /people/employees/$H/identifiers/pan '{"value":"KQZPM4821T"}')" "not set up"
expect "revealing is refused" 503 "$(call "$OWNER" POST /people/employees/$H/identifiers/pan/reveal '{"reason":"payroll_setup"}')" "not set up"
same "and nothing changed in the table" "$(PG "SELECT last4 FROM people.employee_identifiers WHERE employee_id='$H' AND kind='pan'")" "821S"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
