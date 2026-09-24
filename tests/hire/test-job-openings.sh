#!/usr/bin/env bash
# TatvaOS Hire — job openings, end to end through the API (R1, 24 Sept 2026).
#
# Mostly about what the API REFUSES, because a job opening is about to become
# the first thing TatvaOS shows to the public:
#   1. an admin creates a draft; it gets a slug; the audit row says product hire
#   2. nonsense is refused with a sentence (title, ranges, dates, pay, type)
#   3. another organisation's location or person cannot be named (404 as
#      "does not exist" — the tenant filter — with the database FK behind it)
#   4. a draft cannot be published without a description and a location, or
#      with a closing date in the past
#   5. once open, it cannot be edited back into something unpublishable
#   6. the status moves only along its arrows, and closing needs a reason
#   7. a published job can never be deleted; a draft can
#   8. a location or designation in use cannot be deleted, only archived; an
#      archived one may stay on a job but not be newly chosen
#   9. the slug does not follow a rename (a shared link keeps working)
#  10. an employee gets 403; ANOTHER organisation's admin gets 404 on every
#      verb, and the row is unchanged afterwards
#  11. the list: counts per status, the status filter, the title search
#  12. the hiring team (Amit, 24 Sept): a recruiter sees and manages every
#      job but cannot change the team; a hiring manager sees ONLY jobs that
#      name them (others 404), cannot name or hand over to anyone else, and
#      loses a job the moment it is handed to someone else; removal ends
#      access; another organisation cannot touch the team
#
# ── CALIBRATION, 24 September 2026 (house rule 6) ──────────────────────────
#  * PUBLISH CHECK REMOVED FROM SAVE -> "blanking the description of an open
#    job" goes red, then the reopen steps, because the job really was blanked.
#  * DELETE ALLOWED ON A PUBLISHED JOB -> "deleting a published job" goes red;
#    every later step 404s, because the job really is gone.
#  * LOCATION LOOKUP WITH IgnoreQueryFilters() -> step 3 STAYED GREEN. Row-
#    level security on core.locations still hid ABC School's row, so the API
#    still said "does not exist". So step 3 is evidence that SOME layer holds,
#    not that the query filter does; the database FK is a third layer, proven
#    separately in tests/isolation (run as postgres, which bypasses RLS).
#  * HireAccess.Jobs() WIDENED to return every job for a hiring manager ->
#    exactly the five step-12 hiring-manager visibility checks go red (open,
#    status, list, count, and the handed-over job). This is the quiet failure
#    HireAccess warns about; these five are what would catch it.
#  * TEAM CHANGES ALLOWED TO RECRUITERS -> exactly "a recruiter cannot change
#    the team" goes red.
#
# Starts its own API, like tests/orgapi/test-org-api.sh, and takes the same
# TATVAOS_PSQL / TATVAOS_PSQL_APP / TATVAOS_PG_HOST variables, plus
# TATVAOS_PGDATABASE (default tatvaos_mail).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_HIRE_TEST_PORT:-5083}"
API="http://localhost:$PORT"
DB="${TATVAOS_PGDATABASE:-tatvaos_mail}"
SCHOOL='22222222-2222-2222-2222-222222222222'
OWNER_ID='d1111111-1111-1111-1111-111111111111'     # Techvein org_owner
EMPLOYEE_ID='d1111111-1111-1111-1111-111111111112'  # Techvein employee
PRINCIPAL_ID='d2222222-2222-2222-2222-222222222222' # ABC School admin
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/hire-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d $DB -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d $DB -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j()    { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_()  { printf '%s' "$1" | j "$2"; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
brief()  { printf '%s' "$1" | head -c 200 | tr '\n' ' '; }
# same/has: an empty operand is a FAILURE, never a match (testing-false-greens).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got '$2', wanted '$3')"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got '$2', wanted '$3'"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif printf '%s' "$2" | grep -qiF -- "$3"; then pass "$1"
    else fail "$1 — '$3' not in: $(brief "$2")"; fi
}
# call <token> <METHOD> <path> [json] -> body + newline + status
call() {
    curl -s -w '\n%{http_code}' -X "$2" "$API/api$3" -H 'Content-Type: application/json' \
         ${1:+-H "Authorization: Bearer $1"} ${4:+-d "$4"}
}
# expect <label> <want status> <response> [sentence fragment]
expect() {
    local got; got=$(status "$3")
    if [ "$got" != "$2" ]; then fail "$1 — answered $got, wanted $2: $(brief "$(body "$3")")"; return; fi
    if [ -n "${4:-}" ]; then has "$1 ($2)" "$(body "$3")" "$4"; else pass "$1 ($2)"; fi
}

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=$DB;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

API_PID=""
cleanup() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
        fi
        kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf '  kept for reading: %s\n' "$SCRATCH"; fi
}
trap cleanup EXIT

# Sign a seed person in by OTP. Each gets a dedicated dev number, and the
# resend throttle is cleared first: a second request inside 60 seconds
# returns no devCode at all (local-stack-and-otp-login).
signin() {
    local id="$1" phone="$2" code
    PG "UPDATE core.users SET phone='$phone', login_otp_sent_at=NULL, login_otp_attempts=0 WHERE id='$id'" >/dev/null
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' \
         -d "{\"phone\":\"$phone\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}

step "0. Start the API against $TATVAOS_PG_HOST/$DB and sign in"
for _ in $(seq 1 30); do [ -n "$(PG 'SELECT 1')" ] && break; sleep 1; done
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer"; exit 1; }
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w '%{http_code}' "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

# The seed predates the role names the policy uses (as test-org-api.sh notes).
PG "UPDATE core.users SET role='org_owner' WHERE id='$OWNER_ID' AND role='owner'" >/dev/null
PG "UPDATE core.users SET role='org_admin' WHERE id='$PRINCIPAL_ID' AND role='admin'" >/dev/null
TOKEN=$(signin "$OWNER_ID" '+919999900001')
EMP=$(signin "$EMPLOYEE_ID" '+919999900011')
OTHER=$(signin "$PRINCIPAL_ID" '+919999900021')
[ -n "$TOKEN" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
[ -n "$EMP" ]   && pass "signed in as a Techvein employee" || fail "employee sign-in failed"
[ -n "$OTHER" ] && pass "signed in as the ABC School admin" || fail "School admin sign-in failed"

# Fixtures through the organisation's own endpoints.
LOC=$(jq_ "$(body "$(call "$TOKEN" POST /org/locations "{\"name\":\"Hire test office $RUN\",\"city\":\"Pune\"}")")" "d['id']")
LOC2=$(jq_ "$(body "$(call "$TOKEN" POST /org/locations "{\"name\":\"Hire test annex $RUN\"}")")" "d['id']")
DES=$(jq_ "$(body "$(call "$TOKEN" POST /org/designations "{\"title\":\"Hire test engineer $RUN\",\"level\":30}")")" "d['id']")
# A CTE, so psql prints the id and not the INSERT's command tag. The first
# version used INSERT ... RETURNING, captured "INSERT 0 1" as the id, and the
# fixture check below passed because it only asked for non-empty — step 3
# then failed for a reason that had nothing to do with tenancy. So fixtures
# must now LOOK like ids.
SCHOOL_LOC=$(PG "WITH i AS (INSERT INTO core.locations (tenant_id, name) VALUES ('$SCHOOL','School test campus $RUN') RETURNING id) SELECT id FROM i")
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ok=1; for v in "$LOC" "$LOC2" "$DES" "$SCHOOL_LOC"; do printf '%s' "$v" | grep -qE "$UUID_RE" || ok=0; done
[ "$ok" = 1 ] && pass "fixtures: two locations, a designation, and a School location" \
    || { fail "fixtures are not ids (loc '$LOC' loc2 '$LOC2' des '$DES' school '$SCHOOL_LOC')"; exit 1; }

step "1. An admin creates a draft"
r=$(call "$TOKEN" POST /hire/jobs "{\"title\":\"Backend Engineer $RUN\",\"employmentType\":\"full_time\",\"designationId\":\"$DES\",\"hiringManagerId\":\"$OWNER_ID\",\"skills\":[\"C#\",\" SQL \",\"c#\",\"\"]}")
expect "created" 201 "$r"
JOB=$(jq_ "$(body "$r")" "d['id']")
same "it starts as a draft" "$(jq_ "$(body "$r")" "d['status']")" "draft"
SLUG=$(jq_ "$(body "$r")" "d['slug']")
printf '%s' "$SLUG" | grep -qE "^backend-engineer-$RUN-[a-z0-9]{5}$" && pass "slug is the title plus five random characters ($SLUG)" \
    || fail "slug has the wrong shape: '$SLUG'"
same "skills trimmed, blanks dropped, duplicates ignoring case removed" "$(jq_ "$(body "$r")" "','.join(d['skills'])")" "C#,SQL"
same "the audit row names product hire" "$(PG "SELECT product_code FROM core.audit_logs WHERE action='job.created' AND target_id='$JOB'")" "hire"

step "2. Nonsense is refused with a sentence"
expect "blank title"                400 "$(call "$TOKEN" POST /hire/jobs '{"title":"   "}')" "title is required"
expect "unknown employment type"    400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","employmentType":"gig"}')" "employment type"
expect "experience to below from"   400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","experienceMinYears":5,"experienceMaxYears":2}')" "experience"
expect "salary top below bottom"    400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","salaryMin":900000,"salaryMax":500000}')" "salary range"
expect "show a salary there is not" 400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","showSalary":true}')" "no salary to show"
expect "closing before opening"     400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","openingDate":"2026-10-10","closingDate":"2026-10-01"}')" "closing date"
expect "zero vacancies"             400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","vacancies":0}')" "vacancies"
expect "a currency that is not one" 400 "$(call "$TOKEN" POST /hire/jobs '{"title":"x","salaryCurrency":"RUPEES"}')" "three-letter"

step "3. Another organisation's location or person cannot be named"
expect "School's location on a Techvein job" 400 \
    "$(call "$TOKEN" POST /hire/jobs "{\"title\":\"x\",\"locationId\":\"$SCHOOL_LOC\"}")" "does not exist"
expect "School's admin as hiring manager" 400 \
    "$(call "$TOKEN" POST /hire/jobs "{\"title\":\"x\",\"hiringManagerId\":\"$PRINCIPAL_ID\"}")" "not in this organisation"
same "neither attempt left a job behind" "$(PG "SELECT count(*) FROM hire.job_openings WHERE title='x'")" "0"

step "4. Publishing needs a description, a location and a future closing date"
expect "no description yet" 400 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')" "add a description"
FULL="{\"title\":\"Backend Engineer $RUN\",\"employmentType\":\"full_time\",\"designationId\":\"$DES\",\"hiringManagerId\":\"$OWNER_ID\",\"description\":\"Build the API.\",\"skills\":[\"C#\",\"SQL\"]"
expect "description, no location" 200 "$(call "$TOKEN" PUT /hire/jobs/$JOB "$FULL}")"
expect "still no location" 400 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')" "choose a location"
expect "closing date in the past" 200 "$(call "$TOKEN" PUT /hire/jobs/$JOB "$FULL,\"locationId\":\"$LOC\",\"closingDate\":\"2020-01-01\"}")"
expect "a job already closed by its date" 400 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')" "closing date has passed"
expect "a future closing date" 200 "$(call "$TOKEN" PUT /hire/jobs/$JOB "$FULL,\"locationId\":\"$LOC\",\"closingDate\":\"2099-12-31\"}")"
r=$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')
expect "published" 200 "$r"
same "status is open" "$(jq_ "$(body "$r")" "d['status']")" "open"
[ "$(jq_ "$(body "$r")" "d['publishedAt'] is not None")" = "True" ] && pass "publishedAt recorded" || fail "publishedAt not set"
[ "$(jq_ "$(body "$r")" "d['openingDate'] is not None")" = "True" ] && pass "an empty opening date becomes the day it was published" || fail "openingDate not filled in"
same "audited as job.published" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='job.published' AND target_id='$JOB'")" "1"

step "5. An open job cannot be edited back into something unpublishable"
expect "blanking the description of an open job" 400 \
    "$(call "$TOKEN" PUT /hire/jobs/$JOB "{\"title\":\"Backend Engineer $RUN\",\"locationId\":\"$LOC\"}")" "must stay complete"
same "and the stored description is untouched" "$(PG "SELECT description FROM hire.job_openings WHERE id='$JOB'")" "Build the API."

step "6. Status moves only along its arrows"
expect "open -> on hold"   200 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"on_hold"}')"
expect "on hold -> open"   200 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')"
expect "closing with no reason" 400 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"closed"}')" "filled or cancelled"
r=$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"closed","reason":"filled"}')
expect "closed as filled" 200 "$r"
same "reason stored" "$(PG "SELECT closed_reason FROM hire.job_openings WHERE id='$JOB'")" "filled"
expect "closed -> on hold is not an arrow" 409 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"on_hold"}')" "cannot be moved"
expect "an unknown status" 400 "$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"archived"}')" "unknown status"
r=$(call "$TOKEN" POST /hire/jobs/$JOB/status '{"status":"open"}')
expect "reopened" 200 "$r"
same "reopening clears the closed reason" "$(PG "SELECT coalesce(closed_reason,'none') FROM hire.job_openings WHERE id='$JOB'")" "none"
DRAFT=$(jq_ "$(body "$(call "$TOKEN" POST /hire/jobs "{\"title\":\"Throwaway $RUN\"}")")" "d['id']")
expect "a draft cannot be put on hold" 409 "$(call "$TOKEN" POST /hire/jobs/$DRAFT/status '{"status":"on_hold"}')" "only be published"

step "7. A published job is never deleted; a draft can be"
expect "deleting a published job" 409 "$(call "$TOKEN" DELETE /hire/jobs/$JOB)" "close it instead"
same "it is still there" "$(PG "SELECT count(*) FROM hire.job_openings WHERE id='$JOB'")" "1"
expect "deleting a draft" 200 "$(call "$TOKEN" DELETE /hire/jobs/$DRAFT)"
same "the draft is gone" "$(PG "SELECT count(*) FROM hire.job_openings WHERE id='$DRAFT'")" "0"

step "8. Locations and designations in use are archived, not deleted"
expect "deleting the job's location" 409 "$(call "$TOKEN" DELETE /org/locations/$LOC)" "switch off in use"
expect "deleting the job's designation" 409 "$(call "$TOKEN" DELETE /org/designations/$DES)" "switch off in use"
expect "archiving the location" 200 "$(call "$TOKEN" PUT /org/locations/$LOC "{\"name\":\"Hire test office $RUN\",\"isActive\":false}")"
expect "the open job keeps its archived location on save" 200 \
    "$(call "$TOKEN" PUT /hire/jobs/$JOB "$FULL,\"locationId\":\"$LOC\",\"closingDate\":\"2099-12-31\"}")"
expect "a new job cannot choose the archived one" 400 \
    "$(call "$TOKEN" POST /hire/jobs "{\"title\":\"New $RUN\",\"locationId\":\"$LOC\"}")" "archived"
expect "moving the job to another location" 200 \
    "$(call "$TOKEN" PUT /hire/jobs/$JOB "$FULL,\"locationId\":\"$LOC2\",\"closingDate\":\"2099-12-31\"}")"
expect "then the old one can be deleted" 200 "$(call "$TOKEN" DELETE /org/locations/$LOC)"

step "9. The slug does not follow a rename"
expect "renamed" 200 "$(call "$TOKEN" PUT /hire/jobs/$JOB "{\"title\":\"Platform Engineer $RUN\",\"description\":\"Build the API.\",\"locationId\":\"$LOC2\"}")"
same "slug unchanged" "$(PG "SELECT slug FROM hire.job_openings WHERE id='$JOB'")" "$SLUG"

step "10. Who may touch it"
expect "employee: list"   403 "$(call "$EMP" GET /hire/jobs)"
expect "employee: create" 403 "$(call "$EMP" POST /hire/jobs '{"title":"Sneaky"}')"
expect "no token at all"  401 "$(call "" GET /hire/jobs)"
BEFORE=$(PG "SELECT title||'|'||status||'|'||updated_at FROM hire.job_openings WHERE id='$JOB'")
expect "School admin: read Techvein's job"   404 "$(call "$OTHER" GET /hire/jobs/$JOB)"
expect "School admin: edit it"               404 "$(call "$OTHER" PUT /hire/jobs/$JOB '{"title":"hijacked"}')"
expect "School admin: close it"              404 "$(call "$OTHER" POST /hire/jobs/$JOB/status '{"status":"closed","reason":"cancelled"}')"
expect "School admin: delete it"             404 "$(call "$OTHER" DELETE /hire/jobs/$JOB)"
same "Techvein's job is exactly as it was" "$(PG "SELECT title||'|'||status||'|'||updated_at FROM hire.job_openings WHERE id='$JOB'")" "$BEFORE"
r=$(call "$OTHER" GET "/hire/jobs?status=all&q=$RUN")
same "School's list holds none of Techvein's jobs" "$(jq_ "$(body "$r")" "len(d['jobs'])")" "0"

step "11. The list"
r=$(call "$TOKEN" GET "/hire/jobs?status=open&q=Platform%20Engineer%20$RUN")
same "search by title finds it" "$(jq_ "$(body "$r")" "[x['id'] for x in d['jobs']][0]")" "$JOB"
same "and names its location" "$(jq_ "$(body "$r")" "d['jobs'][0]['location']")" "Hire test annex $RUN"
same "counts carry every status" "$(jq_ "$(body "$r")" "','.join(sorted(d['counts'].keys()))")" "closed,draft,on_hold,open"
r=$(call "$TOKEN" GET "/hire/jobs?status=draft&q=Platform%20Engineer%20$RUN")
same "the draft tab does not show an open job" "$(jq_ "$(body "$r")" "len(d['jobs'])")" "0"
expect "an unknown status filter" 400 "$(call "$TOKEN" GET "/hire/jobs?status=everything")"

step "12. The hiring team"
# Audit rows are counted from HERE, not by time: a time window made two runs
# in ten minutes see each other's rows (found on the calibration run).
AUDIT_FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")
me_of() { jq_ "$(body "$(call "$1" GET /hire/me)")" "d['access']"; }
same "not on the team: /hire/me says none" "$(me_of "$EMP")" "none"
same "an administrator needs no team row" "$(me_of "$TOKEN")" "admin"
expect "an unknown team role" 400 "$(call "$TOKEN" PUT /hire/team/$EMPLOYEE_ID '{"role":"boss"}')" "recruiter or hiring manager"
expect "ABC School's admin adding a Techvein person to a team" 404 \
    "$(call "$OTHER" PUT /hire/team/$EMPLOYEE_ID '{"role":"recruiter"}')" "not in this organisation"
same "and ABC School's team did not gain them" "$(PG "SELECT count(*) FROM hire.team_members WHERE user_id='$EMPLOYEE_ID' AND tenant_id='$SCHOOL'")" "0"

expect "admin makes the employee a recruiter" 200 "$(call "$TOKEN" PUT /hire/team/$EMPLOYEE_ID '{"role":"recruiter"}')"
same "/hire/me says recruiter" "$(me_of "$EMP")" "recruiter"
r=$(call "$EMP" GET "/hire/jobs?status=all&q=Platform%20Engineer%20$RUN")
same "a recruiter sees the admin's job" "$(jq_ "$(body "$r")" "[x['id'] for x in d['jobs']][0]")" "$JOB"
expect "a recruiter creates a job" 201 "$(call "$EMP" POST /hire/jobs "{\"title\":\"Recruiter job $RUN\"}")"
expect "a recruiter can list the team" 200 "$(call "$EMP" GET /hire/team)"
expect "a recruiter cannot change the team" 403 "$(call "$EMP" PUT /hire/team/$EMPLOYEE_ID '{"role":"recruiter"}')" "only an administrator"
expect "nor remove anyone from it" 403 "$(call "$EMP" DELETE /hire/team/$EMPLOYEE_ID)"

expect "admin makes them a hiring manager instead" 200 "$(call "$TOKEN" PUT /hire/team/$EMPLOYEE_ID '{"role":"hiring_manager"}')"
same "/hire/me says hiring_manager" "$(me_of "$EMP")" "hiring_manager"
expect "a hiring manager cannot open a job that names someone else" 404 "$(call "$EMP" GET /hire/jobs/$JOB)"
expect "nor change its status" 404 "$(call "$EMP" POST /hire/jobs/$JOB/status '{"status":"on_hold"}')"
r=$(call "$EMP" GET "/hire/jobs?status=all&q=$RUN")
same "and does not see it in the list" "$(jq_ "$(body "$r")" "str('$JOB' in [x['id'] for x in d['jobs']])")" "False"
same "nor count it" "$(jq_ "$(body "$r")" "sum(d['counts'].values())")" "$(PG "SELECT count(*) FROM hire.job_openings WHERE hiring_manager_id='$EMPLOYEE_ID'")"
r=$(call "$EMP" POST /hire/jobs "{\"title\":\"HM job $RUN\",\"description\":\"Mine.\",\"locationId\":\"$LOC2\"}")
expect "a hiring manager creates a job" 201 "$r"
HMJOB=$(jq_ "$(body "$r")" "d['id']")
same "which names them as its hiring manager" "$(jq_ "$(body "$r")" "d['hiringManagerId']")" "$EMPLOYEE_ID"
expect "naming someone else on a new job" 400 \
    "$(call "$EMP" POST /hire/jobs "{\"title\":\"x\",\"hiringManagerId\":\"$OWNER_ID\"}")" "jobs you manage yourself"
expect "handing their own job to someone else" 400 \
    "$(call "$EMP" PUT /hire/jobs/$HMJOB "{\"title\":\"HM job $RUN\",\"description\":\"Mine.\",\"locationId\":\"$LOC2\",\"hiringManagerId\":\"$OWNER_ID\"}")" "recruiter or an administrator"
expect "editing their own job" 200 \
    "$(call "$EMP" PUT /hire/jobs/$HMJOB "{\"title\":\"HM job $RUN\",\"description\":\"Mine, edited.\",\"locationId\":\"$LOC2\",\"hiringManagerId\":\"$EMPLOYEE_ID\"}")"
expect "publishing their own job" 200 "$(call "$EMP" POST /hire/jobs/$HMJOB/status '{"status":"open"}')"
expect "a hiring manager cannot see the team" 403 "$(call "$EMP" GET /hire/team)"
expect "the admin hands the job to someone else" 200 \
    "$(call "$TOKEN" PUT /hire/jobs/$HMJOB "{\"title\":\"HM job $RUN\",\"description\":\"Mine, edited.\",\"locationId\":\"$LOC2\",\"hiringManagerId\":\"$OWNER_ID\"}")"
expect "and the former hiring manager can no longer open it" 404 "$(call "$EMP" GET /hire/jobs/$HMJOB)"

expect "removed from the team" 200 "$(call "$TOKEN" DELETE /hire/team/$EMPLOYEE_ID)"
same "/hire/me says none again" "$(me_of "$EMP")" "none"
expect "and the job list is refused" 403 "$(call "$EMP" GET /hire/jobs)"
same "every team change is audited under product hire" \
    "$(PG "SELECT string_agg(action, ',' ORDER BY id) FROM core.audit_logs WHERE target_id='$EMPLOYEE_ID' AND product_code='hire' AND action LIKE 'hire_team.%' AND id > $AUDIT_FLOOR")" \
    "hire_team.added,hire_team.changed,hire_team.removed"

printf '\n%s----------------------------------------%s\n' "$CYAN" "$RST"
printf '  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
