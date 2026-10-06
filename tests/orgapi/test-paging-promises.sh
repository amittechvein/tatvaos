#!/usr/bin/env bash
#
# TatvaOS Meetings API - what the guide PROMISES about paging, run against the API.
#
# WHY THIS EXISTS. PR 177 put two sentences into the customer guide that nobody
# had run: "A cursor this API did not issue is refused with 400" and "Pages are
# stable ... a class added between two page requests is neither skipped nor
# repeated." Both were false. PR 190 corrected the guide on Mr. Singh's ruling
# (20 Sept 2026). This file is the five checks behind the corrected wording, so
# the next sentence anybody adds to that section has somewhere to be proved.
#
#   1. a cursor that cannot be read is refused with 400, in the new words
#   2. a WELL-FORMED HAND-MADE cursor is accepted: the 400 is a format check
#   3. ...but only ever within the caller's own organisation: a hand-made cursor
#      naming a REAL teacher and a REAL class in ANOTHER organisation gets nothing
#   4. with `cursor` present, from / to / hostEmail are ignored
#   5. paging is not a frozen list: added behind -> absent, moved earlier ->
#      absent, moved later -> appears twice with the same id
#
# TWO MODES, because a check nobody has seen fail is not a check (house rule 6):
#
#   PROMISES=new  (default)  asserts what the guide says NOW. Must be all green.
#   PROMISES=old             asserts what the guide said BEFORE PR 190. Checks 2
#                            and 5 MUST go red: that is the evidence the old
#                            sentences were false, produced by the same requests.
#
# A page is 500 classes, so a real page-one cursor cannot be had from three
# classes. The "position just after class A" is therefore hand-built with A's
# start and code - exactly what a real page-one cursor ending at A would hold
# (PageCursor in OrgMeetingApiEndpoints.cs). Check 2 is what makes that legitimate.
#
# No media server, no SMS, no production. WSL Postgres as tests/orgapi.
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_PAGING_TEST_PORT:-5088}"
API="http://localhost:$PORT"
PROMISES="${PROMISES:-new}"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/paging-promises-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 & WSL_KEEPALIVE=$!
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
# An empty operand is refused, not compared: [ "" = "" ] is true.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
xff() { printf "10.5.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
b64() { "$PY" -c "import base64,sys; print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('='))" "$1"; }
getk() { curl -s -w "\n%{http_code}" "$API/api/v1/org/meetings?$1" -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $SKEY"; }
titles() { body "$1" | j "','.join(m['title'].split(' ')[0] for m in d['meetings']) or '(none)'"; }
ids() { body "$1" | j "','.join(m['id'] for m in d['meetings'])"; }

API_PID=""
cleanup() {
    PG "DELETE FROM connect.meetings WHERE title LIKE '% pp$RUN'" >/dev/null
    PG "UPDATE core.api_keys SET revoked_at=now() WHERE label='Paging promises $RUN'" >/dev/null
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

printf "\n  Meetings API paging promises - asserting the %s guide wording\n" "$(printf '%s' "$PROMISES" | tr a-z A-Z)"
printf "  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. Start the API, make a key, schedule three classes, plant one in another organisation"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
# The three test phones, made true every run (tests/support/test-phones.sh).
. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
# CHECK 3 WITH RLS BYPASSED (Mr. Singh, 21 Sept 2026: "never falsified" is the
# weakest thing in the pack; decision 0007).
#   MUTATE_BYPASS_RLS=1 TATVAOS_SUPER_PW=<local postgres password> bash <this file>
# runs the API as a role that BYPASSES row-level security, so the database's
# layer is gone and only the application's remains.
#   Before 0007 step one (no EF filter on ConnectMeeting): check 3 went RED, the
#   other organisation's class in the answer — RLS was the only layer.
#   From 0007 step one (HasQueryFilter on ConnectMeeting): check 3 must stay
#   GREEN. Red here now means the application's layer is missing again.
# Local only; production's API role is tatvaos_app, neither superuser nor BYPASSRLS.
DB_USER="tatvaos_app"; DB_PW="dev_app_pw"
if [ "${MUTATE_BYPASS_RLS:-0}" = "1" ]; then
    DB_USER="postgres"; DB_PW="${TATVAOS_SUPER_PW:?set TATVAOS_SUPER_PW to the LOCAL postgres password}"
    printf "  *** RLS BYPASSED: the API runs as a role that skips row-level security. Only the EF filter (0007) guards check 3; it must stay green. ***
"
fi
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=$DB_USER;Password=$DB_PW;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
TOKEN=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
SKEY=$(curl -s -X POST "$API/api/org/keys" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"label\":\"Paging promises $RUN\",\"scopes\":[\"meetings:schedule\"]}" | j "d['key']")
[ -n "$SKEY" ] && pass "a Techvein key with meetings:schedule" || { fail "no key"; exit 1; }

# 1 March 2031: a window nothing else uses.
W_FROM="2031-03-01T00:00:00Z"; W_TO="2031-03-02T00:00:00Z"
mk() { curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/org/meetings" -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $SKEY" -H "Content-Type: application/json" -d "{\"hostEmail\":\"amit@techvein.local\",\"title\":\"$1 pp$RUN\",\"startsAt\":\"$2\"}"; }
same "classes A 09:00, B 10:00, C 11:00 scheduled" "$(mk A 2031-03-01T09:00:00Z)$(mk B 2031-03-01T10:00:00Z)$(mk C 2031-03-01T11:00:00Z)" "201201201"
CODEA=$(PG "SELECT code FROM connect.meetings WHERE title='A pp$RUN'"); IDA=$(PG "SELECT id FROM connect.meetings WHERE title='A pp$RUN'")
IDC=$(PG "SELECT id FROM connect.meetings WHERE title='C pp$RUN'")
# A REAL class, with a REAL teacher, in ANOTHER organisation, inside the same window.
PRINCIPAL=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
PG "INSERT INTO connect.meetings (tenant_id, code, title, kind, status, scheduled_start, scheduled_end, created_by_user_id) VALUES ('$SCHOOL', 'pp-school-$RUN', 'SCHOOL pp$RUN', 'scheduled', 'scheduled', '2031-03-01T09:30:00Z', '2031-03-01T10:30:00Z', '$PRINCIPAL')" >/dev/null
IDS=$(PG "SELECT id FROM connect.meetings WHERE code='pp-school-$RUN'")
[ -n "$IDS" ] && pass "a School class exists at 09:30 in the same window, hosted by the School's principal" || { fail "could not plant the School class"; exit 1; }
AFTER_A=$(b64 "{\"S\":\"$W_FROM\",\"E\":\"$W_TO\",\"H\":null,\"LS\":\"2031-03-01T09:00:00+00:00\",\"LC\":\"$CODEA\"}")

step "1. A cursor that cannot be read is refused"
r=$(getk "cursor=not-a-cursor")
same "cursor=not-a-cursor" "$(status "$r")" "400"
if [ "$PROMISES" = "new" ]; then
    same "...in the corrected words" "$(body "$r" | j "'cannot be read' in d.get('error','')")" "True"
fi

step "2. A WELL-FORMED HAND-MADE cursor"
r1=$(getk "cursor=$(b64 '{}')"); r2=$(getk "cursor=$AFTER_A")
if [ "$PROMISES" = "new" ]; then
    same "cursor={} is accepted: the 400 is a format check" "$(status "$r1")" "200"
    same "a hand-made position after A is accepted" "$(status "$r2")" "200"
    same "...and answers the query it describes" "$(titles "$r2")" "B,C"
else
    same "OLD PROMISE 'a cursor this API did not issue is refused with 400': cursor={}" "$(status "$r1")" "400"
    same "OLD PROMISE, same sentence: a hand-made position" "$(status "$r2")" "400"
fi

step "3. ...but only ever inside the caller's own organisation"
FOREIGN=$(b64 "{\"S\":\"$W_FROM\",\"E\":\"$W_TO\",\"H\":\"$PRINCIPAL\",\"LS\":\"2031-03-01T00:00:00+00:00\",\"LC\":\"\"}")
r=$(getk "cursor=$FOREIGN")
same "hand-made cursor naming the School's principal as host, with a Techvein key" "$(status "$r")" "200"
same "...returns no classes at all" "$(titles "$r")" "(none)"
r=$(getk "cursor=$(b64 "{\"S\":\"$W_FROM\",\"E\":\"$W_TO\",\"H\":null,\"LS\":\"2031-03-01T00:00:00+00:00\",\"LC\":\"\"}")")
same "hand-made cursor over the whole window, no host: Techvein's three only" "$(titles "$r")" "A,B,C"
same "...and the School's class id is not among them" "$(printf '%s' "$(ids "$r")" | grep -c "$IDS")" "0"
same "(the School class really is there to be leaked: the database holds it)" "$(PG "SELECT count(*) FROM connect.meetings WHERE id='$IDS' AND scheduled_start >= '$W_FROM' AND scheduled_start < '$W_TO'")" "1"

step "4. With cursor present, from / to / hostEmail are ignored"
r=$(getk "cursor=$AFTER_A&from=2099-01-01T00:00:00Z&to=2099-01-02T00:00:00Z&hostEmail=nobody@techvein.local")
same "cursor + a 2099 window + an unknown teacher: the CURSOR's question is answered" "$(titles "$r")" "B,C"

step "5. Paging while the timetable changes"
mk E 2031-03-01T08:00:00Z >/dev/null
r=$(getk "cursor=$AFTER_A")
if [ "$PROMISES" = "new" ]; then
    same "class E added at 08:00, BEHIND the position: absent from this read" "$(titles "$r")" "B,C"
else
    same "OLD PROMISE 'a class added between two page requests is neither skipped...': E at 08:00 shows up" "$(titles "$r")" "E,B,C"
fi
PG "UPDATE connect.meetings SET scheduled_start='2031-03-01T08:30:00Z', scheduled_end='2031-03-01T09:30:00Z' WHERE id='$IDC'" >/dev/null
r=$(getk "cursor=$AFTER_A")
if [ "$PROMISES" = "new" ]; then
    same "class C MOVED EARLIER, 11:00 -> 08:30: gone from this read, never on page one either" "$(titles "$r")" "B"
else
    same "OLD PROMISE '...neither skipped': C, moved to 08:30, is still read" "$(printf '%s' "$(ids "$r")" | grep -c "$IDC")" "1"
fi
PG "UPDATE connect.meetings SET scheduled_start='2031-03-01T12:00:00Z', scheduled_end='2031-03-01T13:00:00Z' WHERE id='$IDA'" >/dev/null
r=$(getk "cursor=$AFTER_A")
if [ "$PROMISES" = "new" ]; then
    same "class A (already read on page one) MOVED LATER, 09:00 -> 12:00: it comes back" "$(titles "$r")" "B,A"
    same "...with the SAME id, which is why the guide says match by id" "$(printf '%s' "$(ids "$r")" | grep -c "$IDA")" "1"
else
    same "OLD PROMISE '...nor repeated': A, already on page one, is not on page two" "$(printf '%s' "$(ids "$r")" | grep -c "$IDA")" "0"
fi
same "a fresh full read is complete and in order" "$(titles "$(getk "from=$W_FROM&to=$W_TO")")" "E,C,B,A"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (%s wording)\n\n" "$PASSED" "$PROMISES"; exit 0
else printf "  FAIL  %d of %d checks (%s wording)\n\n" "$FAILED" $((PASSED+FAILED)) "$PROMISES"; exit 1; fi
