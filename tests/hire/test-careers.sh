#!/usr/bin/env bash
# TatvaOS Hire — the public careers page (decision 0010 §1), end to end.
#
# The first unauthenticated read of Hire data, so this is mostly about what a
# stranger must NOT get:
#   0. jobs in every state; only published ones have public addresses
#   1. setup is administrators only; the address is checked, platform-unique,
#      and the page cannot be switched on without a data contact
#   2. unknown site, site switched off, platform switch off: the SAME 404 body
#   3. with both switches on: only open, unexpired jobs; only public fields
#      (checked as exact key sets); salary only when the job says so; the
#      text exactly as typed; the data contact shown; applying not open
#   4. another organisation's job never appears under this site
#   5. switching off (the organisation, a suspension, the platform) is
#      immediate
#   6. 120 reads a minute per address, then 429; other addresses unaffected
#
# The platform switch 'hire.careers_portal_enabled' is set back to what it was
# on exit, whatever happens — a half-finished run must not leave pages public.
#
# Starts its own API on :5085. Takes TATVAOS_PSQL / TATVAOS_PSQL_APP /
# TATVAOS_PG_HOST / TATVAOS_PGDATABASE like tests/hire/test-job-openings.sh.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_CAREERS_TEST_PORT:-5085}"
API="http://localhost:$PORT"
DB="${TATVAOS_PGDATABASE:-tatvaos_mail}"
TECHVEIN_ID='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
OWNER_ID='d1111111-1111-1111-1111-111111111111'     # Techvein org_owner
EMPLOYEE_ID='d1111111-1111-1111-1111-111111111112'  # Techvein employee
PRINCIPAL_ID='d2222222-2222-2222-2222-222222222222' # ABC School admin
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/careers-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d $DB -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-wsl -e psql postgresql://tatvaos_app:dev_app_pw@localhost/$DB -Atc}"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d $DB -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-docker exec tv-postgres psql -U tatvaos_app -d $DB -Atc}"
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
# A failed read prints a marker rather than nothing: an empty result reads as
# "the API returned nothing" and sends you looking at the wrong layer. Found
# on one laptop run where a single read came back blank between two that
# worked on the SAME response.
j()    { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>"$SCRATCH/j.err" \
             || printf 'JSON-READ-FAILED(%s)' "$(head -c 160 "$SCRATCH/j.err" | tr '\n' ' ')"; }
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
# Something already answering on our port means the health check below would
# be answered by IT — typically the previous run's API still shutting down —
# and every request after would go to a dying process. Found as "owner
# sign-in failed" on the first of two back-to-back runs, never the second.
# Wait for the port to fall silent, and say so plainly if it will not.
for _ in $(seq 1 20); do curl -s -o /dev/null "$API/health" 2>/dev/null || break; sleep 1; done
if curl -s -o /dev/null "$API/health" 2>/dev/null; then
    fail "something is already listening on port $PORT - stop it, or set TATVAOS_CAREERS_TEST_PORT"; exit 1
fi
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

# Everything this script turns on, it turns off again — the platform switch
# above all. A run that died halfway must not leave careers pages public on a
# shared database.
PLATFORM_BEFORE=$(PG "SELECT coalesce((SELECT value FROM core.platform_settings WHERE key='hire.careers_portal_enabled'),'(none)')")
restore_platform() {
    if [ "$PLATFORM_BEFORE" = "(none)" ]; then PG "DELETE FROM core.platform_settings WHERE key='hire.careers_portal_enabled'" >/dev/null
    else PG "UPDATE core.platform_settings SET value='$PLATFORM_BEFORE' WHERE key='hire.careers_portal_enabled'" >/dev/null; fi
}
trap 'restore_platform; cleanup' EXIT
platform() { PG "INSERT INTO core.platform_settings (key, value) VALUES ('hire.careers_portal_enabled','$1')
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null; }
platform false
# pub <path> [xff] — a stranger: no token, no cookie.
pub() { curl -s -w '\n%{http_code}' "$API/api/public/careers/$1" -H "X-Forwarded-For: ${2:-10.77.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))}"; }

SLUG_T="tv-$RUN"
LOC=$(jq_ "$(body "$(call "$TOKEN" POST /org/locations "{\"name\":\"Careers test office $RUN\"}")")" "d['id']")
printf '%s' "$LOC" | grep -qE '^[0-9a-f-]{36}$' && pass "fixture: a location" || { fail "no location fixture ('$LOC')"; exit 1; }

# Jobs in every state, through the API. publish <title> [extra json]
mkjob() { jq_ "$(body "$(call "$TOKEN" POST /hire/jobs "{\"title\":\"$1\",\"description\":\"Plain text.\nSecond line <b>not bold</b>.\",\"locationId\":\"$LOC\"${2:-}}")")" "d['id']"; }
publish() { call "$TOKEN" POST "/hire/jobs/$1/status" '{"status":"open"}' >/dev/null; }
J_OPEN=$(mkjob "Careers open $RUN" ",\"salaryMin\":600000,\"salaryMax\":900000,\"showSalary\":false,\"hiringManagerId\":\"$OWNER_ID\""); publish "$J_OPEN"
J_PAY=$(mkjob "Careers pay shown $RUN" ",\"salaryMin\":500000,\"salaryMax\":700000,\"showSalary\":true"); publish "$J_PAY"
J_DRAFT=$(mkjob "Careers draft $RUN")
J_HOLD=$(mkjob "Careers hold $RUN"); publish "$J_HOLD"; call "$TOKEN" POST "/hire/jobs/$J_HOLD/status" '{"status":"on_hold"}' >/dev/null
J_CLOSED=$(mkjob "Careers closed $RUN"); publish "$J_CLOSED"; call "$TOKEN" POST "/hire/jobs/$J_CLOSED/status" '{"status":"closed","reason":"filled"}' >/dev/null
J_PAST=$(mkjob "Careers past $RUN"); publish "$J_PAST"
# Its closing date moved into the past after publishing (the API would refuse
# to publish it so); the public page must drop it on its own.
# Both dates move: publishing set opening_date to today, and ck_job_dates
# refuses a closing date before it — the first run moved closing_date alone,
# the UPDATE was refused, the fixture silently stayed open, and the two checks
# on it went red for a reason that had nothing to do with the careers page.
PG "UPDATE hire.job_openings SET opening_date = current_date - 10, closing_date = current_date - 1 WHERE id = '$J_PAST'" >/dev/null
same "fixture: the past job really closed yesterday" \
    "$(PG "SELECT (closing_date = current_date - 1)::text FROM hire.job_openings WHERE id='$J_PAST'")" "true"
S_OPEN=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_OPEN'")
S_PAY=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_PAY'")
S_HOLD=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_HOLD'")
S_CLOSED=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_CLOSED'")
S_PAST=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_PAST'")
same "fixtures: five published jobs have public addresses" \
    "$(PG "SELECT count(*) FROM hire.job_openings WHERE id IN ('$J_OPEN','$J_PAY','$J_HOLD','$J_CLOSED','$J_PAST') AND slug IS NOT NULL")" "5"
same "and the draft has none" "$(PG "SELECT coalesce(slug,'none') FROM hire.job_openings WHERE id='$J_DRAFT'")" "none"

step "1. Setting the page up (administrators)"
r=$(call "$TOKEN" GET /hire/careers)
expect "an admin reads the careers setup" 200 "$r"
same "nothing is saved yet" "$(jq_ "$(body "$r")" "str(d['saved'])+'/'+str(d['isEnabled'])+'/'+str(d['platformEnabled'])")" "False/False/False"
same "the owner is suggested as the data contact" "$(jq_ "$(body "$r")" "d['erasureContact']")" "$(PG "SELECT email FROM core.users WHERE id='$OWNER_ID'")"
expect "an address with capitals and spaces" 400 "$(call "$TOKEN" PUT /hire/careers '{"slug":"Tech Vein","displayName":"Techvein"}')" "lower-case"
expect "an address of two letters" 400 "$(call "$TOKEN" PUT /hire/careers '{"slug":"tv","displayName":"Techvein"}')" "3 to 40"
expect "switching on with no data contact" 400 "$(call "$TOKEN" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"Techvein\",\"isEnabled\":true}")" "before switching the page on"
expect "saved, switched off" 200 "$(call "$TOKEN" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"Techvein Careers\",\"erasureContact\":\"privacy@techvein.test\"}")"
expect "ABC School cannot take the same address" 409 "$(call "$OTHER" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"ABC\"}")" "is taken"
same "and ABC School has no site row from trying" "$(PG "SELECT count(*) FROM hire.careers_sites WHERE tenant_id='$SCHOOL'")" "0"
expect "an employee cannot read the setup" 403 "$(call "$EMP" GET /hire/careers)"
same "audited" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='careers_site.created' AND target_id='$SLUG_T'")" "1"

step "2. Every kind of no looks the same"
NO_BODY=$(body "$(pub "no-such-site-$RUN")")
r=$(pub "no-such-site-$RUN"); same "an unknown site: 404" "$(status "$r")" "404"
r=$(pub "$SLUG_T");            same "our site, switched off: 404" "$(status "$r")" "404"
same "with exactly the unknown site's body" "$(body "$r")" "$NO_BODY"
call "$TOKEN" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"Techvein Careers\",\"erasureContact\":\"privacy@techvein.test\",\"isEnabled\":true}" >/dev/null
r=$(pub "$SLUG_T");            same "switched on, but the PLATFORM switch is off: 404" "$(status "$r")" "404"
same "same body again" "$(body "$r")" "$NO_BODY"
same "the resolver, as the app with no tenant, answers nothing while the platform is off" \
    "$($TATVAOS_PSQL_APP "SELECT count(*) FROM hire.resolve_careers_site('$SLUG_T')" 2>/dev/null | grep -v '^wsl:' | tail -n1)" "0"

step "3. The platform switch on: only open jobs, only public fields"
platform true
r=$(pub "$SLUG_T")
expect "the careers page answers" 200 "$r"
same "under the organisation's chosen name" "$(jq_ "$(body "$r")" "d['organisation']")" "Techvein Careers"
same "listing exactly the two open, unexpired jobs" \
    "$(jq_ "$(body "$r")" "','.join(sorted(j['slug'] for j in d['jobs'] if '$RUN' in j['slug'] or j['title'].endswith('$RUN')))")" \
    "$(printf '%s\n%s\n' "$S_OPEN" "$S_PAY" | sort | paste -sd, -)"
same "each list item carries only public keys" \
    "$(jq_ "$(body "$r")" "','.join(sorted(d['jobs'][0].keys()))")" "closingDate,employmentType,location,slug,title"
same "and the page itself only these" "$(jq_ "$(body "$r")" "','.join(sorted(d.keys()))")" "jobs,organisation"
r=$(pub "$SLUG_T/jobs/$S_OPEN")
expect "an open job's page" 200 "$r"
same "carries only public keys" "$(jq_ "$(body "$r")" "','.join(sorted(d.keys()))")" \
    "applyOpen,closingDate,description,employmentType,experienceMaxYears,experienceMinYears,location,organisation,privacyContact,qualification,requirements,responsibilities,salary,skills,slug,title,vacancies"
has "never the hiring manager, ids or tenant" "$(printf '%s' "$(body "$r")" | grep -qiE 'hiringManager|recruiter|tenant|departmentId|"id"' && echo LEAKED || echo clean)" "clean"
same "salary hidden when the job says so" "$(jq_ "$(body "$r")" "str(d['salary'])")" "None"
same "the description is the plain text as typed" "$(jq_ "$(body "$r")" "repr(d['description'])")" "'Plain text.\\nSecond line <b>not bold</b>.'"
same "the data contact is shown" "$(jq_ "$(body "$r")" "d['privacyContact']")" "privacy@techvein.test"
same "and applying is not open yet" "$(jq_ "$(body "$r")" "str(d['applyOpen'])")" "False"
# Mr. Singh, 24 Sept: nothing public is indexed before launch. The JSON says so
# on every answer; the pages carry it in app/careers/layout.tsx.
robots=$(curl -s -D - -o /dev/null "$API/api/public/careers/$SLUG_T/jobs/$S_OPEN" -H "X-Forwarded-For: 10.55.1.1" | tr -d '\r' | grep -i '^x-robots-tag:' | cut -d' ' -f2-)
same "the public API tells search engines not to index it" "$robots" "noindex, nofollow"
same "salary shown when the job says so" "$(jq_ "$(body "$(pub "$SLUG_T/jobs/$S_PAY")")" "f\"{d['salary']['currency']} {int(d['salary']['min'])}-{int(d['salary']['max'])} {d['salary']['period']}\"")" "INR 500000-700000 year"
for pair in "on hold:$S_HOLD" "closed:$S_CLOSED" "past its closing date:$S_PAST"; do
    what=${pair%%:*}; s=${pair#*:}
    r=$(pub "$SLUG_T/jobs/$s"); same "a job $what: 404" "$(status "$r")" "404"
done
same "a made-up job address: 404, same body" "$(body "$(pub "$SLUG_T/jobs/nothing-here-$RUN")")" "$NO_BODY"

step "4. Another organisation's jobs never appear under this site"
L_S=$(jq_ "$(body "$(call "$OTHER" POST /org/locations "{\"name\":\"School careers $RUN\"}")")" "d['id']")
J_S=$(jq_ "$(body "$(call "$OTHER" POST /hire/jobs "{\"title\":\"School job $RUN\",\"description\":\"x\",\"locationId\":\"$L_S\"}")")" "d['id']")
call "$OTHER" POST "/hire/jobs/$J_S/status" '{"status":"open"}' >/dev/null
S_SCHOOL=$(PG "SELECT slug FROM hire.job_openings WHERE id='$J_S'")
[ -n "$S_SCHOOL" ] && pass "fixture: an open ABC School job ($S_SCHOOL)" || fail "no ABC School job fixture"
r=$(pub "$SLUG_T/jobs/$S_SCHOOL"); same "ABC School's job under Techvein's site: 404" "$(status "$r")" "404"
same "and it is not in Techvein's list" "$(jq_ "$(body "$(pub "$SLUG_T")")" "str('$S_SCHOOL' in [j['slug'] for j in d['jobs']])")" "False"

step "5. Switching off works at once"
call "$TOKEN" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"Techvein Careers\",\"erasureContact\":\"privacy@techvein.test\",\"isEnabled\":false}" >/dev/null
r=$(pub "$SLUG_T/jobs/$S_OPEN"); same "the organisation switched off: the job page is 404" "$(status "$r")" "404"
call "$TOKEN" PUT /hire/careers "{\"slug\":\"$SLUG_T\",\"displayName\":\"Techvein Careers\",\"erasureContact\":\"privacy@techvein.test\",\"isEnabled\":true}" >/dev/null
same "on again: 200" "$(status "$(pub "$SLUG_T")")" "200"
PG "UPDATE core.tenants SET status='suspended' WHERE id='$TECHVEIN_ID'" >/dev/null
same "the organisation suspended: 404" "$(status "$(pub "$SLUG_T")")" "404"
PG "UPDATE core.tenants SET status='active' WHERE id='$TECHVEIN_ID'" >/dev/null
platform false
same "the platform switched off again: 404" "$(status "$(pub "$SLUG_T")")" "404"
platform true

step "6. The read limit: 120 a minute per address"
FIXED_IP="10.66.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"
codes=""; for _ in $(seq 1 125); do codes="$codes $(pub "$SLUG_T" "$FIXED_IP" | tail -n1)"; done
n429=$(printf '%s\n' $codes | grep -c '^429$')
n200=$(printf '%s\n' $codes | grep -c '^200$')
[ "$n200" -ge 115 ] && [ "$n429" -ge 1 ] && pass "125 reads from one address: $n200 answered, $n429 refused (429)" \
    || fail "rate limit not as expected: $n200 answered, $n429 refused"
same "another address is unaffected" "$(status "$(pub "$SLUG_T")")" "200"

step "7. Clean up"
platform false
for j in "$J_OPEN" "$J_PAY" "$J_HOLD" "$J_CLOSED" "$J_PAST"; do call "$TOKEN" POST "/hire/jobs/$j/status" '{"status":"closed","reason":"cancelled"}' >/dev/null; done
call "$TOKEN" DELETE "/hire/jobs/$J_DRAFT" >/dev/null
call "$OTHER" POST "/hire/jobs/$J_S/status" '{"status":"closed","reason":"cancelled"}' >/dev/null
PG "DELETE FROM hire.careers_sites WHERE slug = '$SLUG_T'" >/dev/null
same "the test's site is gone" "$(PG "SELECT count(*) FROM hire.careers_sites WHERE slug='$SLUG_T'")" "0"


printf '
%s----------------------------------------%s
' "$CYAN" "$RST"
printf '  passed: %d   failed: %d

' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
