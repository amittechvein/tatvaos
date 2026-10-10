#!/usr/bin/env bash
# TatvaOS Hire — interviews and interview feedback (Phase 2; 20261009-s),
# end to end through the API.
#
#   1. only administrators and recruiters schedule; a hiring manager cannot
#   2. a panel is only people who can ALREADY see the application:
#      administrators, recruiters, this job's hiring manager - never a hiring
#      manager of another job, never another organisation's person
#   3. the job's hiring manager sees the interview; another job's does not
#   4. feedback: panel members only, about themselves; rating and
#      recommendation required; the DATABASE refuses feedback with no panel row
#   5. independent feedback: a panel member who has not given theirs does not
#      see colleagues'; after giving it, they do
#   6. cancelling keeps the interview; feedback on a cancelled one is refused
#   7. another organisation gets 404 on everything
#   8. erasing the candidate removes interviews, panel and every word of
#      feedback; no audit row repeats what the feedback said
#
# Builds its own throwaway database (house rule 13) unless TATVAOS_PSQL is
# given. Starts its own API on :5113 (needs `dotnet build -c Release`).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_INTERVIEWS_TEST_PORT:-5113}"
API="http://localhost:$PORT"
SCRATCH="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/interviews-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
RUN=$(date +%s)

TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create interviews || exit 2
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
cleanup() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    if [ -z "$TDB_USED" ]; then
        PG "DELETE FROM hire.candidates WHERE full_name LIKE 'iv-$RUN-%';
            DELETE FROM hire.job_openings WHERE title LIKE 'iv-$RUN-%';
            DELETE FROM hire.team_members WHERE tenant_id = '$TECHVEIN' AND user_id = (SELECT id FROM core.users WHERE email='hr@techvein.local');
            DELETE FROM core.locations WHERE name = 'iv-$RUN-office';" >/dev/null
    fi
    [ -n "$TDB_USED" ] && tdb_drop
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Hire: interviews and feedback\n  tree under test: %s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. Start the API, sign in, and set up two jobs"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
if curl -s -o /dev/null "$API/health" 2>/dev/null; then
    fail "something is already listening on port $PORT - stop it, or set TATVAOS_INTERVIEWS_TEST_PORT"; exit 1
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
PRINCIPAL_ID=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
same "the staff member is no administrator" "$(PG "SELECT (role NOT IN ('org_owner','org_admin','owner','admin','super_admin'))::text FROM core.users WHERE id='$STAFF_ID'")" "true"
OWNER=$(signin '+919999900001'); STAFF=$(signin '+919999900002'); OTHER=$(signin '+919999900003')
[ -n "$OWNER" ] && pass "signed in as the Techvein owner (administrator)" || { fail "owner sign-in failed"; exit 1; }
[ -n "$STAFF" ] && pass "signed in as a Techvein staff member" || fail "staff sign-in failed"
[ -n "$OTHER" ] && pass "signed in as the ABC School admin" || fail "School admin sign-in failed"
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")

expect "the staff member joins the hiring team as a hiring manager" 200 "$(call "$OWNER" PUT /hire/team/$STAFF_ID '{"role":"hiring_manager"}')"
LOC=$(id_of "$(call "$OWNER" POST /org/locations "{\"name\":\"iv-$RUN-office\"}")")
mkjob() {
    local r id; r=$(call "$OWNER" POST /hire/jobs "{\"title\":\"$1\",\"description\":\"Do the work.\",\"locationId\":\"$LOC\"${2:-}}")
    id=$(id_of "$r"); call "$OWNER" POST "/hire/jobs/$id/status" '{"status":"open"}' >/dev/null; printf '%s' "$id"
}
J1=$(mkjob "iv-$RUN-job-managed" ",\"hiringManagerId\":\"$STAFF_ID\"")
J2=$(mkjob "iv-$RUN-job-other")
same "two open jobs; the staff member manages the first only" \
    "$(PG "SELECT string_agg(status||'/'||(hiring_manager_id IS NOT DISTINCT FROM '$STAFF_ID')::text, ',' ORDER BY title) FROM hire.job_openings WHERE title LIKE 'iv-$RUN-%'")" "open/true,open/false"
C=$(id_of "$(call "$OWNER" POST /hire/candidates "{\"fullName\":\"iv-$RUN-asha\",\"email\":\"asha.$RUN@example.test\"}")")
A1=$(id_of "$(call "$OWNER" POST /hire/applications "{\"candidateId\":\"$C\",\"jobId\":\"$J1\"}")")
A2=$(id_of "$(call "$OWNER" POST /hire/applications "{\"candidateId\":\"$C\",\"jobId\":\"$J2\"}")")
printf '%s%s' "$A1" "$A2" | grep -qE '^[0-9a-f-]{72}$' && pass "fixture: Asha applied to both jobs" || { fail "no application fixtures ('$A1' '$A2')"; exit 1; }
WHEN="2026-11-02T10:30:00+05:30"

step "1. Who may schedule"
expect "the hiring manager cannot schedule, even on their own job" 403 \
    "$(call "$STAFF" POST /hire/applications/$A1/interviews "{\"scheduledAt\":\"$WHEN\",\"panel\":[\"$STAFF_ID\"]}")" "recruiters and administrators"
expect "nor list who could sit on a panel" 403 "$(call "$STAFF" GET /hire/applications/$A1/interviews/panel-options)"

step "2. A panel is only people who can already see the application"
# The RULE, not a fixed list: CI's shared database holds other suites'
# administrators and recruiters, who are legitimately eligible (the first CI
# run of this test expected exactly two people and found three, 9 Oct).
OPTS=$(jq_ "$(body "$(call "$OWNER" GET /hire/applications/$A1/interviews/panel-options)")" "' '.join(p['id'] for p in d)")
has "job 1's options include the owner" "$OPTS" "$OWNER_ID"
has "and its hiring manager" "$OPTS" "$STAFF_ID"
in_list=$(printf "'%s'," $OPTS | sed 's/,$//')
same "and every option is an administrator, a recruiter, or this job's hiring manager" \
    "$(PG "SELECT count(*) FROM core.users u WHERE u.id IN ($in_list)
             AND NOT (u.role IN ('super_admin','org_owner','org_admin')
                      OR EXISTS (SELECT 1 FROM hire.team_members m WHERE m.user_id = u.id AND m.role = 'recruiter')
                      OR u.id = (SELECT hiring_manager_id FROM hire.job_openings WHERE id = '$J1'))")" "0"
same "for job 2 the staff member is NOT an option (another job's hiring manager)" \
    "$(jq_ "$(body "$(call "$OWNER" GET /hire/applications/$A2/interviews/panel-options)")" "str('$STAFF_ID' in [p['id'] for p in d])")" "False"
expect "putting another job's hiring manager on job 2's panel" 400 \
    "$(call "$OWNER" POST /hire/applications/$A2/interviews "{\"scheduledAt\":\"$WHEN\",\"panel\":[\"$STAFF_ID\"]}")" "cannot see this application"
expect "putting another organisation's person on a panel" 400 \
    "$(call "$OWNER" POST /hire/applications/$A1/interviews "{\"scheduledAt\":\"$WHEN\",\"panel\":[\"$PRINCIPAL_ID\"]}")" "cannot see this application"
expect "an empty panel" 400 "$(call "$OWNER" POST /hire/applications/$A1/interviews "{\"scheduledAt\":\"$WHEN\",\"panel\":[]}")" "1 to 10"
expect "no time" 400 "$(call "$OWNER" POST /hire/applications/$A1/interviews "{\"panel\":[\"$OWNER_ID\"]}")" "when the interview is"
expect "a mode that is not one" 400 "$(call "$OWNER" POST /hire/applications/$A1/interviews "{\"scheduledAt\":\"$WHEN\",\"mode\":\"telepathy\",\"panel\":[\"$OWNER_ID\"]}")" "in person, on video or by phone"
r=$(call "$OWNER" POST /hire/applications/$A1/interviews "{\"scheduledAt\":\"$WHEN\",\"durationMinutes\":45,\"mode\":\"video\",\"place\":\"https://meet.example/abc\",\"panel\":[\"$OWNER_ID\",\"$STAFF_ID\"]}")
expect "the owner schedules job 1's interview with both on the panel" 201 "$r"; IV=$(id_of "$r")
same "10:30 India time is stored as 05:00 UTC (the first run answered 500 on +05:30)" \
    "$(PG "SELECT to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') FROM hire.interviews WHERE id='$IV'")" "2026-11-02 05:00"
same "the interview and both panel rows were stored together" \
    "$(PG "SELECT (SELECT count(*) FROM hire.interviews WHERE id='$IV')||'/'||(SELECT count(*) FROM hire.interview_panel WHERE interview_id='$IV')")" "1/2"
r=$(call "$OWNER" POST /hire/applications/$A2/interviews "{\"scheduledAt\":\"$WHEN\",\"panel\":[\"$OWNER_ID\"]}")
expect "and job 2's with the owner alone" 201 "$r"; IV2=$(id_of "$r")

step "3. Who sees an interview"
same "the job's hiring manager sees job 1's interview" "$(jq_ "$(body "$(call "$STAFF" GET /hire/applications/$A1/interviews)")" "str(len(d))")" "1"
expect "but not job 2's application at all" 404 "$(call "$STAFF" GET /hire/applications/$A2/interviews)"
expect "nor can give feedback on its interview" 404 "$(call "$STAFF" PUT /hire/interviews/$IV2/feedback '{"rating":3,"recommendation":"no"}')"

step "4. Feedback: the panel only, about themselves"
expect "a rating of 0" 400 "$(call "$OWNER" PUT /hire/interviews/$IV2/feedback '{"rating":0,"recommendation":"yes"}')" "1 to 5"
expect "no recommendation" 400 "$(call "$OWNER" PUT /hire/interviews/$IV/feedback '{"rating":4}')" "strong yes, yes, no"
expect "the hiring manager (on the panel) gives feedback" 200 "$(call "$STAFF" PUT /hire/interviews/$IV/feedback '{"rating":4,"recommendation":"yes","notes":"iv-secret-note: strong on SQL"}')"
same "stored under the hiring manager's own name" "$(PG "SELECT (interviewer_id='$STAFF_ID')::text FROM hire.interview_feedback WHERE interview_id='$IV'")" "true"
expect "changing it keeps one row" 200 "$(call "$STAFF" PUT /hire/interviews/$IV/feedback '{"rating":5,"recommendation":"strong_yes","notes":"iv-secret-note: strong on SQL"}')"
same "still one row, now 5" "$(PG "SELECT count(*)||'/'||max(rating) FROM hire.interview_feedback WHERE interview_id='$IV'")" "1/5"
# The database, not only the API: feedback for someone not on the panel.
out=$(PGRAW "INSERT INTO hire.interview_feedback (tenant_id, interview_id, interviewer_id, rating, recommendation) VALUES ('$TECHVEIN','$IV2','$STAFF_ID',3,'no')")
has "the database refuses feedback from someone not on the panel" "$out" "fk_feedback_panel"

step "5. Independent feedback"
r=$(call "$OWNER" GET /hire/applications/$A1/interviews)
same "the owner (on the panel, not given theirs) sees no colleague's feedback yet" "$(jq_ "$(body "$r")" "str(len(d[0]['feedback']))")" "0"
same "and is told one is waiting for them to give theirs" "$(jq_ "$(body "$r")" "str(d[0]['feedbackHidden'])")" "1"
same "the response does not carry the hidden words" "$(grep -c 'iv-secret-note' <<< "$(body "$r")")" "0"
expect "the owner gives theirs" 200 "$(call "$OWNER" PUT /hire/interviews/$IV/feedback '{"rating":3,"recommendation":"no","notes":"needs more depth"}')"
same "now they see both" "$(jq_ "$(body "$(call "$OWNER" GET /hire/applications/$A1/interviews)")" "str(len(d[0]['feedback']))")" "2"

step "6. Cancelling"
expect "the hiring manager cannot cancel" 403 "$(call "$STAFF" POST /hire/interviews/$IV2/cancel '{}')"
expect "the owner cancels job 2's interview" 200 "$(call "$OWNER" POST /hire/interviews/$IV2/cancel '{"reason":"Candidate asked to move it"}')"
same "it is kept, cancelled" "$(PG "SELECT status FROM hire.interviews WHERE id='$IV2'")" "cancelled"
expect "feedback on a cancelled interview" 409 "$(call "$OWNER" PUT /hire/interviews/$IV2/feedback '{"rating":3,"recommendation":"no"}')" "cancelled"
expect "changing a cancelled interview" 409 "$(call "$OWNER" PUT /hire/interviews/$IV2 "{\"scheduledAt\":\"$WHEN\",\"panel\":[\"$OWNER_ID\"]}")" "cancelled"

step "7. Another organisation"
expect "ABC School cannot list job 1's interviews" 404 "$(call "$OTHER" GET /hire/applications/$A1/interviews)"
expect "nor give feedback" 404 "$(call "$OTHER" PUT /hire/interviews/$IV/feedback '{"rating":1,"recommendation":"strong_no"}')"
expect "nor cancel" 404 "$(call "$OTHER" POST /hire/interviews/$IV/cancel '{}')"

step "8. Erasure takes every word"
same "no audit row says what any feedback said" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE id > $FLOOR AND (coalesce(before_state::text,'')||coalesce(after_state::text,'')) LIKE '%iv-secret-note%'")" "0"
expect "the owner erases Asha" 200 "$(call "$OWNER" DELETE /hire/candidates/$C)"
same "her interviews, panels and feedback are gone" \
    "$(PG "SELECT (SELECT count(*) FROM hire.interviews WHERE id IN ('$IV','$IV2'))+(SELECT count(*) FROM hire.interview_panel WHERE interview_id IN ('$IV','$IV2'))+(SELECT count(*) FROM hire.interview_feedback WHERE interview_id IN ('$IV','$IV2'))")" "0"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
