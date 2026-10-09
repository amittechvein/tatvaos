#!/usr/bin/env bash
# TatvaOS People — employee records and who reports to whom (decision 0018),
# end to end through the API.
#
#   1. an owner is NOT People HR until they name themselves; that is audited
#   2. only administrators name People HR
#   3. HR creates records; codes come from the scheme, in order
#   4. MANAGER BY DATA (check 6): a person sees themselves and everyone below
#      them through reports_to - and a role of 'manager' with nobody below
#      grants nothing
#   5. no reporting to yourself, no loops (check 2), with sentences
#   6. self-appointment is in the access audit as plainly as a grant
#      (Mr. Singh's addition 3): who, whose manager, when
#   7. exit: refused while people report to you (with the count); an exited
#      person cannot become a manager
#   8. another organisation's department, manager or record: refused / 404
#   9. manual codes; a duplicate refused; the scheme cannot be set back below
#      a number already given (#409 + 0018 §1)
#  10. a department, designation or location named by a record cannot be
#      deleted
#  11. RACE (check 3): rounds of A->B and B->A at once - never both, never a
#      loop, never a 500; and simultaneous creates never share a code (check 4)
#
# Builds its own throwaway database (house rule 13) unless TATVAOS_PSQL is
# given. Starts its own API on :5111 (needs `dotnet build -c Release`).
# TATVAOS_PEOPLE_RACE_ROUNDS (default 5).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_PEOPLE_TEST_PORT:-5111}"
API="http://localhost:$PORT"
SCRATCH="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/people-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
ROUNDS="${TATVAOS_PEOPLE_RACE_ROUNDS:-5}"

TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create people || exit 2
    TDB_USED=1
    TATVAOS_PG_HOST="$TDB_HOST"
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

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
cleanup() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    if [ -z "$TDB_USED" ]; then
        PG "DELETE FROM people.employees WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
            DELETE FROM people.hr_members WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
            DELETE FROM people.employee_id_settings WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
            DELETE FROM core.locations WHERE name LIKE 'People test %';
            DELETE FROM core.departments WHERE name LIKE 'People test dept %';" >/dev/null
    fi
    [ -n "$TDB_USED" ] && tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  People: employee records and reporting lines\n  tree under test: %s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. Start the API and sign in"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
if curl -s -o /dev/null "$API/health" 2>/dev/null; then
    fail "something is already listening on port $PORT - stop it, or set TATVAOS_PEOPLE_TEST_PORT"; exit 1
fi
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=${TATVAOS_PG_HOST:-localhost};Port=5432;Database=${TDB_NAME:-${TATVAOS_PGDATABASE:-tatvaos_mail}};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
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
STAFF_ROLE=$(PG "SELECT role FROM core.users WHERE email='hr@techvein.local'")
same "the staff member is no administrator" "$(PG "SELECT (role NOT IN ('org_owner','org_admin','owner','admin','super_admin'))::text FROM core.users WHERE email='hr@techvein.local'")" "true"
OWNER=$(signin '+919999900001'); STAFF=$(signin '+919999900002'); OTHER=$(signin '+919999900003')
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
[ -n "$STAFF" ] && pass "signed in as a Techvein staff member" || fail "staff sign-in failed"
[ -n "$OTHER" ] && pass "signed in as the ABC School admin" || fail "School admin sign-in failed"
PG "DELETE FROM people.employees WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
    DELETE FROM people.hr_members WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');
    DELETE FROM people.employee_id_settings WHERE tenant_id IN ('$TECHVEIN','$SCHOOL');" >/dev/null
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")
# A department of Meera's own, with no sign-ins in it: step 10 must be refused
# BECAUSE OF THE EMPLOYEE RECORD, not because people sign in from it (the
# first run picked the seed's "Staff", and the older check answered first).
DEPT_T=$(jq_ "$(body "$(call "$OWNER" POST /org/departments "{\"name\":\"People test dept $$\"}")")" "d['id']")
printf '%s' "$DEPT_T" | grep -qE '^[0-9a-f-]{36}$' && pass "fixture: an empty department" || { fail "no department fixture ('$DEPT_T')"; exit 1; }
DEPT_S=$(PG "SELECT id FROM core.departments WHERE tenant_id='$SCHOOL' ORDER BY name LIMIT 1")

step "1. An owner is not People HR until they name themselves"
r=$(call "$OWNER" GET /people/me)
same "the owner is not HR, but may name HR" "$(jq_ "$(body "$r")" "f\"{d['isHr']}/{d['canNameHr']}\"")" "False/True"
expect "so the owner cannot add an employee" 403 "$(call "$OWNER" POST /people/employees '{"fullName":"X","joinedOn":"2026-01-01"}')" "People HR"
same "and sees no one" "$(jq_ "$(body "$(call "$OWNER" GET /people/employees)")" "len(d)")" "0"
expect "the owner names themselves People HR" 200 "$(call "$OWNER" PUT /people/hr/$OWNER_ID)"
same "and the moment is audited as appointing themselves" \
    "$(PG "SELECT after_state->>'appointedThemselves' FROM core.audit_logs WHERE id > $FLOOR AND action='people_hr.added' ORDER BY id DESC LIMIT 1")" "true"
same "now they are HR" "$(jq_ "$(body "$(call "$OWNER" GET /people/me)")" "d['isHr']")" "True"

step "2. Only administrators name People HR"
expect "a staff member cannot name themselves HR" 403 "$(call "$STAFF" PUT /people/hr/$STAFF_ID)" "administrator"
same "and is not HR" "$(jq_ "$(body "$(call "$STAFF" GET /people/me)")" "d['isHr']")" "False"

step "3. HR adds employees; codes come from the scheme, in order"
mk() { call "$OWNER" POST /people/employees "$1"; }
r=$(mk "{\"fullName\":\"Meera Manager\",\"userId\":\"$STAFF_ID\",\"departmentId\":\"$DEPT_T\",\"joinedOn\":\"2025-04-01\"}")
expect "a manager, linked to the staff member's sign-in" 201 "$r"; M=$(id_of "$r")
same "the first code" "$(jq_ "$(body "$r")" "d['employeeCode']")" "0001"
r=$(mk "{\"fullName\":\"Ravi Report\",\"reportsTo\":\"$M\",\"joinedOn\":\"2025-05-01\"}"); expect "a report to her" 201 "$r"; R1=$(id_of "$r")
r=$(mk "{\"fullName\":\"Sita Second\",\"reportsTo\":\"$R1\",\"joinedOn\":\"2025-06-01\"}"); expect "a report two levels down" 201 "$r"; R2=$(id_of "$r")
r=$(mk '{"fullName":"Xavier Elsewhere","joinedOn":"2025-07-01"}'); expect "someone not under her" 201 "$r"; X=$(id_of "$r")
same "codes are 0001..0004 with no gaps" "$(PG "SELECT string_agg(employee_code, ',' ORDER BY employee_code) FROM people.employees WHERE tenant_id='$TECHVEIN'")" "0001,0002,0003,0004"
expect "a sign-in can belong to one record only" 400 "$(mk "{\"fullName\":\"Dup\",\"userId\":\"$STAFF_ID\",\"joinedOn\":\"2025-01-01\"}")" "already belongs"
expect "a typed ID in auto mode" 400 "$(mk '{"fullName":"Typed","employeeCode":"ZZ-1","joinedOn":"2025-01-01"}')" "automatically"

r=$(call "$OWNER" GET /people/options)
expect "HR reads the form's choices" 200 "$r"
same "they say codes are automatic, and offer four managers" "$(jq_ "$(body "$r")" "f\"{d['codeMode']}/{len(d['managers'])}\"")" "auto/4"
same "the staff member's sign-in is marked as linked" \
    "$(jq_ "$(body "$r")" "str(next(s['linked'] for s in d['signIns'] if s['id']=='$STAFF_ID'))")" "True"
expect "a non-HR person cannot read them (they list the organisation's sign-ins)" 403 "$(call "$STAFF" GET /people/options)"

step "4. A manager sees themselves and everyone below - by data, not by role"
r=$(call "$STAFF" GET /people/employees)
same "the staff member (Meera) sees exactly her line: herself, Ravi, Sita" \
    "$(jq_ "$(body "$r")" "','.join(sorted(e['fullName'].split()[0] for e in d))")" "Meera,Ravi,Sita"
expect "a record two levels down is readable" 200 "$(call "$STAFF" GET /people/employees/$R2)"
expect "someone outside her line is 404" 404 "$(call "$STAFF" GET /people/employees/$X)"
expect "a manager cannot change records" 403 "$(call "$STAFF" PUT /people/employees/$R1 '{"fullName":"Ravi","joinedOn":"2025-05-01"}')" "People HR"
same "her own view says how many report to her" "$(jq_ "$(body "$(call "$STAFF" GET /people/me)")" "d['directReports']")" "1"
# The role says nothing. Make her 'manager' by role and take her record away:
# she must see nobody (0018 §3; Mr. Singh: a role cannot say OF WHOM).
PG "UPDATE people.employees SET user_id = NULL WHERE id='$M'" >/dev/null
PG "UPDATE core.users SET role='manager' WHERE id='$STAFF_ID'" >/dev/null
same "role 'manager' with nobody below her by data: sees no one" "$(jq_ "$(body "$(call "$STAFF" GET /people/employees)")" "len(d)")" "0"
PG "UPDATE core.users SET role='$STAFF_ROLE' WHERE id='$STAFF_ID'" >/dev/null
PG "UPDATE people.employees SET user_id = '$STAFF_ID' WHERE id='$M'" >/dev/null
same "her line is back once the data says so" "$(jq_ "$(body "$(call "$STAFF" GET /people/employees)")" "len(d)")" "3"

step "5. No reporting to yourself, no loops"
put() { call "$OWNER" PUT /people/employees/$1 "$2"; }
expect "Meera reporting to herself" 409 "$(put "$M" "{\"fullName\":\"Meera Manager\",\"userId\":\"$STAFF_ID\",\"departmentId\":\"$DEPT_T\",\"reportsTo\":\"$M\",\"joinedOn\":\"2025-04-01\"}")" "themselves"
expect "Meera reporting to Sita, who is below her" 409 "$(put "$M" "{\"fullName\":\"Meera Manager\",\"userId\":\"$STAFF_ID\",\"departmentId\":\"$DEPT_T\",\"reportsTo\":\"$R2\",\"joinedOn\":\"2025-04-01\"}")" "loop"
same "Meera still reports to no one" "$(PG "SELECT coalesce(reports_to::text,'none') FROM people.employees WHERE id='$M'")" "none"

step "6. Setting reports_to is in the access audit, plainly"
r=$(mk "{\"fullName\":\"Amit Owner\",\"userId\":\"$OWNER_ID\",\"joinedOn\":\"2024-01-01\"}"); expect "the owner gets a record of their own" 201 "$r"; O=$(id_of "$r")
expect "the owner makes themselves Xavier's manager" 200 "$(put "$X" "{\"fullName\":\"Xavier Elsewhere\",\"reportsTo\":\"$O\",\"joinedOn\":\"2025-07-01\"}")"
same "the history says: Xavier, now under the owner's record, done by the owner" \
    "$(PG "SELECT (to_manager_id='$O')::text||'/'||(changed_by='$OWNER_ID')::text||'/'||coalesce(from_manager_id::text,'none') FROM people.reporting_changes WHERE employee_id='$X' ORDER BY id DESC LIMIT 1")" "true/true/none"
same "every reporting line set so far has a history row naming who did it (Ravi, Sita, Xavier)" \
    "$(PG "SELECT count(*) FROM people.reporting_changes WHERE tenant_id='$TECHVEIN' AND changed_by='$OWNER_ID'")" "3"
same "Xavier's history is readable by HR" "$(jq_ "$(body "$(call "$OWNER" GET /people/employees/$X/reporting-changes)")" "len(d)")" "1"
expect "but not by Meera, for someone outside her line" 404 "$(call "$STAFF" GET /people/employees/$X/reporting-changes)"

step "7. Leaving"
expect "Meera cannot leave while Ravi reports to her" 409 "$(call "$OWNER" POST /people/employees/$M/exit '{"exitOn":"2026-10-31"}')" "1 person reports"
expect "Ravi moves to the owner" 200 "$(put "$R1" "{\"fullName\":\"Ravi Report\",\"reportsTo\":\"$O\",\"joinedOn\":\"2025-05-01\"}")"
expect "now Meera can leave" 200 "$(call "$OWNER" POST /people/employees/$M/exit '{"exitOn":"2026-10-31"}')"
expect "and nobody can be put under her" 409 "$(put "$R2" "{\"fullName\":\"Sita Second\",\"reportsTo\":\"$M\",\"joinedOn\":\"2025-06-01\"}")" "has left"
expect "her record is kept as it was" 409 "$(put "$M" '{"fullName":"Renamed","joinedOn":"2025-04-01"}')" "has left"

step "8. Another organisation"
expect "ABC School's department" 400 "$(mk "{\"fullName\":\"Cross\",\"departmentId\":\"$DEPT_S\",\"joinedOn\":\"2025-01-01\"}")" "does not exist"
expect "ABC School names its admin People HR" 200 "$(call "$OTHER" PUT /people/hr/$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'"))"
r=$(call "$OTHER" POST /people/employees '{"fullName":"School Person","joinedOn":"2025-01-01"}'); expect "ABC School adds its own" 201 "$r"; S1=$(id_of "$r")
same "ABC School's code starts at its own 0001" "$(jq_ "$(body "$r")" "d['employeeCode']")" "0001"
expect "Techvein cannot make ABC School's person a manager" 400 "$(put "$X" "{\"fullName\":\"Xavier Elsewhere\",\"reportsTo\":\"$S1\",\"joinedOn\":\"2025-07-01\"}")" "does not exist"
expect "ABC School cannot read Techvein's record" 404 "$(call "$OTHER" GET /people/employees/$X)"
same "ABC School's list is its own" "$(jq_ "$(body "$(call "$OTHER" GET /people/employees)")" "len(d)")" "1"

step "9. Manual codes, and the scheme cannot go backwards"
expect "the scheme goes manual" 200 "$(call "$OWNER" PUT /org/employee-ids '{"mode":"manual","prefix":"","digits":4,"nextNumber":6}')"
expect "manual: an ID is required" 400 "$(mk '{"fullName":"No Code","joinedOn":"2025-01-01"}')" "Give one"
expect "manual: T-1" 201 "$(mk '{"fullName":"Typed One","employeeCode":"T-1","joinedOn":"2025-01-01"}')"
expect "manual: t-1 again is the same ID" 409 "$(mk '{"fullName":"Typed Two","employeeCode":"t-1","joinedOn":"2025-01-01"}')" "already taken"
expect "back to auto, starting at 3 (0005 is already given)" 400 "$(call "$OWNER" PUT /org/employee-ids '{"mode":"auto","prefix":"","digits":4,"nextNumber":3}')" "already been given"
expect "back to auto, starting at 6" 200 "$(call "$OWNER" PUT /org/employee-ids '{"mode":"auto","prefix":"","digits":4,"nextNumber":6}')"

step "10. What a record names cannot be deleted"
expect "Meera's department" 400 "$(call "$OWNER" DELETE /org/departments/$DEPT_T)" "employee record"
LOC=$(id_of "$(call "$OWNER" POST /org/locations '{"name":"People test office"}')")
expect "Ravi moves to a location" 200 "$(put "$R1" "{\"fullName\":\"Ravi Report\",\"reportsTo\":\"$O\",\"locationId\":\"$LOC\",\"joinedOn\":\"2025-05-01\"}")"
expect "that location" 409 "$(call "$OWNER" DELETE /org/locations/$LOC)" "employee record"

step "11. Races"
bad=0; answers=0
for round in $(seq 1 "$ROUNDS"); do
    A=$(id_of "$(mk "{\"fullName\":\"Race A$round\",\"joinedOn\":\"2025-01-01\"}")")
    B=$(id_of "$(mk "{\"fullName\":\"Race B$round\",\"joinedOn\":\"2025-01-01\"}")")
    ( put "$A" "{\"fullName\":\"Race A$round\",\"reportsTo\":\"$B\",\"joinedOn\":\"2025-01-01\"}" > "$SCRATCH/ra-$round" ) &
    p1=$!
    ( put "$B" "{\"fullName\":\"Race B$round\",\"reportsTo\":\"$A\",\"joinedOn\":\"2025-01-01\"}" > "$SCRATCH/rb-$round" ) &
    p2=$!
    wait $p1 $p2
    s1=$(status "$(cat "$SCRATCH/ra-$round")"); s2=$(status "$(cat "$SCRATCH/rb-$round")")
    answers=$((answers + 2))
    case "$s1/$s2" in
        200/409|409/200) ;;
        *) bad=$((bad + 1)); printf '      round %s answered %s and %s\n' "$round" "$s1" "$s2" ;;
    esac
    loop=$(PG "SELECT count(*) FROM people.employees a JOIN people.employees b ON a.reports_to=b.id AND b.reports_to=a.id WHERE a.id IN ('$A','$B')")
    [ "$loop" = "0" ] || { bad=$((bad + 1)); printf '      round %s LEFT A LOOP in the table\n' "$round"; }
done
same "all $answers answers were read" "$answers" "$((ROUNDS * 2))"
same "every round: exactly one of A->B / B->A accepted, the other refused, no loop, no 500" "$bad" "0"
# The HTTP rounds above prove no 500 and no loop under real traffic, but they
# do NOT prove the lock: with the advisory lock removed they still passed 8 of
# 8 (red run, 9 Oct) - the API does enough per request that the two changes
# rarely overlap inside the trigger's window. So force the overlap at the
# database: session one changes A->B and holds its transaction open; session
# two changes B->A meanwhile. WITH the lock, two waits, then sees A->B and is
# refused. WITHOUT it, both commit and the table holds a loop. Deterministic.
A=$(id_of "$(mk '{"fullName":"Held A","joinedOn":"2025-01-01"}')")
B=$(id_of "$(mk '{"fullName":"Held B","joinedOn":"2025-01-01"}')")
as_owner="SET app.tenant_id = '$TECHVEIN'; SELECT set_config('app.user_id', '$OWNER_ID', false);"
( $TATVAOS_PSQL "$as_owner BEGIN; UPDATE people.employees SET reports_to='$B' WHERE id='$A'; SELECT pg_sleep(3); COMMIT;" \
      > "$SCRATCH/held-1" 2>&1 ) &
held=$!
sleep 1
second=$($TATVAOS_PSQL "$as_owner SET statement_timeout = '15s'; UPDATE people.employees SET reports_to='$A' WHERE id='$B';" 2>&1 | grep -v "^wsl:")
wait "$held"
has "the second change, made while the first was open, was refused as a loop" "$second" "loop"
same "and the table holds no loop" \
    "$(PG "SELECT count(*) FROM people.employees a JOIN people.employees b ON a.reports_to=b.id AND b.reports_to=a.id WHERE a.id IN ('$A','$B')")" "0"
same "the first change stands" "$(PG "SELECT (reports_to='$B')::text FROM people.employees WHERE id='$A'")" "true"

# Wait for THESE ten only. A bare `wait` also waits for the API this script
# started, and hung the first run for ten minutes (9 Oct).
pids=""
for n in $(seq 1 10); do ( mk "{\"fullName\":\"Burst $n\",\"joinedOn\":\"2025-01-01\"}" > "$SCRATCH/burst-$n" ) & pids="$pids $!"; done
wait $pids
codes=$(for n in $(seq 1 10); do jq_ "$(body "$(cat "$SCRATCH/burst-$n")")" "d['employeeCode']"; done | sort)
same "ten simultaneous joiners got ten codes" "$(printf '%s\n' "$codes" | grep -c .)" "10"
same "and no two the same" "$(printf '%s\n' "$codes" | sort -u | grep -c .)" "10"

step "12. Signed out"
expect "the list, signed out" 401 "$(call "" GET /people/employees)"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
