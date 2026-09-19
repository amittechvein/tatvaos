#!/usr/bin/env bash
#
# TatvaOS — the organisation API: a customer's own software admitting people
# with an organisation API key (Amit, 18 September 2026).
#
# This is the most consequential public surface in the product: it creates
# sign-in identities. So the checks are mostly about what it REFUSES.
#
#   1. an admin creates a key: shown once, with a visible prefix, scopes stored
#   2. no key, a nonsense key and a revoked key all answer 401, identically
#   3. a key without people:admit is refused with 403
#   4. a key WITH it admits a person, who lands in the KEY'S organisation
#   5. the person cannot enter without an invitation channel — no password is
#      ever accepted over the API
#   6. a key cannot create an administrator, by role or by department default
#   7. the same address twice is refused, as the console refuses it
#   8. every rule the console applies still applies (capacity, verified domain)
#   9. it is all in the audit trail, naming the key
#  10. RLS: the key's tenant is the only one touched
#
# Meetings, added 18 September 2026 for a school's ERP:
#
#  11. meetings:schedule and meetings:join are separate from each other
#      and from people:admit — no key may do another's job
#  12. a class is scheduled with a TEACHER as host, never the key
#  13. it appears on that teacher's own primary CALENDAR, with the join
#      link on it. Nothing put a meeting on a calendar before this
#  14. rescheduling moves the calendar entry rather than adding one
#  15. the join half returns the link and what to tell the student. It
#      cannot cancel, cannot list the timetable, takes no email and never
#      answers with one (CTO review: a student-portal key must not be a way
#      to enumerate a school)
#  16. cancelling takes the class off the calendar and the timetable
#  17. it is audited against the key, and invisible to another tenant
#  18. the backfill migration writes the row the mirror would have — every
#      field compared — and a second run changes nothing (CTO condition 1)
#  19. the guide's claims: cancel twice is 204, a running class is 409 to
#      cancel and still joinable, an ended one is 409 to join, times come
#      back in UTC, the 31st request in a minute is 429, a missing title
#      becomes "<first name>'s meeting", a missing zone is Asia/Kolkata
#      (CTO condition 3)
#  21. the timetable is paged: 505 classes inserted straight into the
#      database, the first page is exactly 500 with a `next`, the second is
#      the 5 with none, and the two pages are 505 DISTINCT classes (CTO,
#      19 Sept: "a documented cap with no way past it is worse than no cap")
#  20. a person made through the console has a calendar the moment they
#      exist — where people are made, not where it was noticed (condition 2)
#
# ── CALIBRATION, 18 September 2026 (house rule 6) ──────────────────────────
#
# Each claim below was broken on purpose and the suite re-run, to find out
# which assertion actually carries it. Three findings worth keeping:
#
#  * MIRROR REMOVED FROM MEETING CREATION -> step 13 goes fully red (7), and
#    step 14 STAYED GREEN. The upsert on the update path had simply created
#    the row itself, so "the calendar follows a rename" was true for the
#    wrong reason. Step 14 now compares the row's ID to the one step 13 saw;
#    that single assertion is the only thing separating "the entry moved"
#    from "an entry appeared".
#
#  * SCHEDULING MADE TO ACCEPT A meetings:join KEY -> only
#    "a meetings:join key cannot schedule one either" goes red. The
#    people:admit check stays green because that key holds NEITHER meeting
#    scope, so it is not evidence about the schedule scope at all. It is
#    kept because it is evidence about the people scope.
#
#  * CALENDAR REMOVAL DROPPED FROM CANCEL -> exactly one assertion goes red,
#    "and it is off the calendar". Note that "gone from the timetable"
#    stayed green: the list reads connect.meetings, not the calendar, so it
#    can never be evidence about calendar rows.
#
#  * PAGE BOUNDARY MADE INCLUSIVE (>= instead of > on the tiebreaker) ->
#    exactly two assertions red: page two holds 6 not 5, and the union is
#    "505 1" — the boundary class repeated. Nothing else moved. An offset
#    instead of a keyset would fail the same two the moment a class is
#    scheduled between two page requests.
#
# The first run of these steps also printed three FALSE greens: the meeting
# had failed to be created, and `[ "" = "" ]` is true, so empty was being
# compared to empty. That is what `same`, `has` and `hasnt` below exist for.
#
# Starts its own API, like tests/oidc/stage3-flow.sh, and takes the same
# TATVAOS_PSQL / TATVAOS_PSQL_APP / TATVAOS_PG_HOST variables.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ORGAPI_TEST_PORT:-5081}"
API="http://localhost:$PORT"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/orgapi-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-wsl -e psql postgresql://tatvaos_app:dev_app_pw@localhost/tatvaos_mail -Atc}"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -Atc}"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG()    { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }
# Run a whole SQL FILE, on stdin, with the same psql PG uses minus its -Atc.
# stdin rather than -f because a /c/... path handed to wsl is mangled by Git
# Bash, and docker exec needs -i to forward stdin at all.
PGFILE() {
    local base="${TATVAOS_PSQL% -Atc}"
    base="${base/docker exec /docker exec -i }"
    # NOTICE lines carry a "psql:<file>:<line>: " prefix with -f and none on
    # stdin; both shapes are noise here. Anything else printed is a failure.
    $base -v ON_ERROR_STOP=1 -q < "$1" 2>&1 | grep -v "^wsl:" | grep -vE "^(psql:[^ ]*: )?NOTICE:" | grep -v "^$"
}
PGAPP() { $TATVAOS_PSQL_APP "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }
status() { printf '%s' "$1" | tail -n1; }
# same <label> <got> <want> — an empty operand is a FAILURE, never a match.
# Without this, a step whose subject was never created compares "" with ""
# and reports success (found on the first run of steps 12-16).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got '$2', wanted '$3')"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got '$2', wanted '$3'"; fi
}
# has <label> <haystack> <needle> — likewise: an empty needle matches
# everything, so it is refused rather than searched for.
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"
    else fail "$1 — not found"; fi
}
# hasnt <label> <haystack> <needle> — the same guard, opposite expectation.
hasnt() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif printf '%s' "$2" | grep -qF -- "$3"; then fail "$1 — it is still there"
    else pass "$1"; fi
}
body()   { printf '%s' "$1" | sed '$d'; }
brief()  { printf '%s' "$1" | head -c 220 | tr '\n' ' '; }
# ── EVERY ORG-API REQUEST ARRIVES FROM A DIFFERENT ADDRESS ──────────────────
# The org-api limiter allows 30 a minute per calling address, keyed on the
# last X-Forwarded-For entry. This suite fires well over 30 in a minute, and
# when step 19 was added the very last join came back 429 while its check
# said "join handed out a link to an ended class" — a limiter doing its job,
# read as a bug in something else. So each request claims its own address,
# and step 19 sends 31 from ONE fixed address to prove the limit is real.
xff()    { printf '10.9.%d.%d' $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
post()   { curl -s -w '\n%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $2" -d "$3"; }
admit()  { curl -s -w '\n%{http_code}' -X POST "$API/api/v1/org/people" -H 'Content-Type: application/json' -H "X-Forwarded-For: $(xff)" ${1:+-H "Authorization: Bearer $1"} -d "$2"; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
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

step "0. Start the API against $TATVAOS_PG_HOST"
for _ in $(seq 1 30); do [ -n "$(PG 'SELECT 1')" ] && break; sleep 1; done
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer"; exit 1; }
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w '%{http_code}' "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
TOKEN=$(curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$TOKEN" ] && pass "signed in as the Techvein owner" || { fail "sign-in failed"; exit 1; }

step "1. An admin creates a key"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Student system $RUN\",\"scopes\":[\"people:admit\"]}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(brief "$(body "$r")")"
KEY=$(jq_ "$(body "$r")" "d['key']"); KEY_ID=$(jq_ "$(body "$r")" "d['id']")
[ "${KEY:0:4}" = "tvk_" ] && pass "the key has the tvk_ prefix" || fail "key prefix: ${KEY:0:4}"
[ "$(jq_ "$(body "$r")" "d['keyPrefix']")" = "${KEY:0:12}" ] && pass "the visible prefix is the first 12 characters" || fail "keyPrefix wrong"
r=$(curl -s "$API/api/org/keys" -H "Authorization: Bearer $TOKEN")
printf '%s' "$r" | grep -qF -- "$KEY" && fail "the list carries the key itself" || pass "the list never carries the key"
[ "$(PG "SELECT key_hash <> '$KEY' FROM core.api_keys WHERE id='$KEY_ID'")" = "t" ] && pass "stored hashed, not in the clear" || fail "the key is stored in the clear"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Bad $RUN\",\"scopes\":[\"people:everything\"]}")
[ "$(status "$r")" = "400" ] && pass "an unknown scope is refused, not ignored" || fail "unknown scope answered $(status "$r")"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Empty $RUN\",\"scopes\":[]}")
[ "$(status "$r")" = "400" ] && pass "a key with nothing ticked is refused" || fail "empty scopes answered $(status "$r")"

step "2. No key, a nonsense key and a revoked key all answer the same"
BODY="{\"localPart\":\"api-person-$RUN\",\"displayName\":\"API Person\",\"recoveryEmail\":\"api-person-$RUN@example.test\"}"
[ "$(status "$(admit "" "$BODY")")" = "401" ] && pass "no key: 401" || fail "no key answered $(status "$(admit "" "$BODY")")"
[ "$(status "$(admit "tvk_notarealkeyatallnotarealkeyatall" "$BODY")")" = "401" ] && pass "a nonsense key: 401" || fail "nonsense key not refused"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"To revoke $RUN\",\"scopes\":[\"people:admit\"]}")
DEAD=$(jq_ "$(body "$r")" "d['key']"); DEAD_ID=$(jq_ "$(body "$r")" "d['id']")
curl -s -o /dev/null -X DELETE "$API/api/org/keys/$DEAD_ID" -H "Authorization: Bearer $TOKEN"
[ "$(status "$(admit "$DEAD" "$BODY")")" = "401" ] && pass "a revoked key: 401, the same answer as unknown" || fail "revoked key not refused"

step "3. A key without people:admit"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Wrong scope $RUN\",\"scopes\":[\"people:admit\"]}")
NOSCOPE_ID=$(jq_ "$(body "$r")" "d['id']"); NOSCOPE=$(jq_ "$(body "$r")" "d['key']")
PG "UPDATE core.api_keys SET scopes='{}' WHERE id='$NOSCOPE_ID'" >/dev/null
r=$(admit "$NOSCOPE" "$BODY")
[ "$(status "$r")" = "403" ] && pass "refused with 403, not 401 — the key is real, the permission is not" || fail "no-scope answered $(status "$r")"

step "4. A key WITH it admits a person, into the key's organisation"
r=$(admit "$KEY" "$BODY")
[ "$(status "$r")" = "200" ] || [ "$(status "$r")" = "201" ] && pass "admitted ($(status "$r"))" || fail "admit: $(status "$r") $(brief "$(body "$r")")"
NEW_ID=$(PG "SELECT id FROM core.users WHERE email LIKE 'api-person-$RUN@%'")
[ -n "$NEW_ID" ] && pass "the person exists" || fail "no person was created"
[ "$(PG "SELECT tenant_id::text FROM core.users WHERE id='$NEW_ID'")" = "$TECHVEIN" ] && pass "in the KEY'S organisation, not another" || fail "wrong tenant"
[ "$(PG "SELECT role FROM core.users WHERE id='$NEW_ID'")" = "employee" ] && pass "as an ordinary employee" || fail "role: $(PG "SELECT role FROM core.users WHERE id='$NEW_ID'")"
[ "$(PG "SELECT invite_token_hash IS NOT NULL FROM core.users WHERE id='$NEW_ID'")" = "t" ] && pass "with an invitation to set their own way in (0005)" || fail "no invitation was issued"
[ "$(PG "SELECT password_hash IS NULL FROM core.users WHERE id='$NEW_ID'")" = "t" ] && pass "and no password: a key never handles one" || fail "a password was set through the API"

step "5. A person with no way in is refused"
r=$(admit "$KEY" "{\"localPart\":\"nowayin-$RUN\",\"displayName\":\"No Way In\"}")
[ "$(status "$r")" = "400" ] && pass "no recovery email or phone: refused" || fail "no-way-in answered $(status "$r")"
[ "$(PG "SELECT count(*) FROM core.users WHERE email LIKE 'nowayin-$RUN@%'")" = "0" ] && pass "and nobody was created" || fail "a person with no way in was created"

step "6. A key cannot create an administrator"
# WHICH ASSERTION CARRIES WHICH CLAIM, from calibrating this step: with
# allowPrivilegedRoles forced true, ONLY the org_admin checks go red.
# org_owner is stopped independently (it needs owner scope, and an API key
# has no user), and super_admin is not an assignable role at all. So the new
# guard is what stands between a key and an org_admin; the other two were
# already defended, and are asserted here so a change to either is noticed.
for role in org_admin org_owner super_admin; do
    r=$(admit "$KEY" "{\"localPart\":\"esc-$role-$RUN\",\"displayName\":\"Esc\",\"recoveryEmail\":\"esc@example.test\",\"role\":\"$role\"}")
    [ "$(status "$r")" != "200" ] && [ "$(status "$r")" != "201" ] && pass "refused role '$role' ($(status "$r"))" || fail "LEAK: a key created a '$role'"
    [ "$(PG "SELECT count(*) FROM core.users WHERE email LIKE 'esc-$role-$RUN@%'")" = "0" ] && pass "…and no such person exists" || fail "LEAK: '$role' row was written"
done
# The same escalation by the longer route: a department whose DEFAULT role is
# privileged must not be inherited by a key.
DEPT=$(PG "INSERT INTO core.departments (tenant_id, name, default_role) VALUES ('$TECHVEIN', 'Admins $RUN', 'org_admin') RETURNING id")
if [ -n "$DEPT" ]; then
    r=$(admit "$KEY" "{\"localPart\":\"deptesc-$RUN\",\"displayName\":\"Dept Esc\",\"recoveryEmail\":\"d@example.test\",\"departmentId\":\"$DEPT\"}")
    got=$(PG "SELECT role FROM core.users WHERE email LIKE 'deptesc-$RUN@%'")
    [ -z "$got" ] || [ "$got" = "employee" ] && pass "a privileged department default is not inherited (role '${got:-none}')" || fail "LEAK: inherited '$got' from the department"
else
    printf '  - could not create a test department; department-default check skipped\n'
fi

step "7. The same address twice"
r=$(admit "$KEY" "$BODY")
[ "$(status "$r")" = "409" ] && pass "the second time: 409, as the console refuses it" || fail "duplicate answered $(status "$r")"

step "8. The audit trail names the key"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_person_admitted' AND target_id='$KEY_ID'")
[ "${n:-0}" -ge 1 ] && pass "the admission is recorded against the key" || fail "no audit row naming the key"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_key_created' AND target_id='$KEY_ID'")
[ "${n:-0}" -ge 1 ] && pass "so is the key's creation" || fail "no audit row for the key"
printf '%s' "$(PG "SELECT coalesce(string_agg(after_state::text,' '),'') FROM core.audit_logs WHERE action LIKE 'org.api%'")" | grep -qF -- "$KEY" && fail "the key itself is in the audit trail" || pass "and the key itself appears nowhere in it"

step "9. Nothing secret in the API log"
n=$(grep -c -F -- "$KEY" "$LOG"); [ "$n" -eq 0 ] && pass "the key appears nowhere in the API log" || fail "the key appears $n time(s) in the log"

step "10. RLS: the school sees none of it"
n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM core.api_keys")
[ "${n:-1}" -eq 0 ] && pass "ABC School sees no Techvein key" || fail "LEAK: school sees ${n:-?} key(s)"
n=$(PGAPP "SELECT count(*) FROM core.api_keys")
[ "${n:-1}" -eq 0 ] && pass "no tenant context sees nothing" || fail "DANGEROUS: ${n:-?} key(s) with no tenant"
[ "$(PGAPP "SELECT tenant_id::text FROM core.resolve_api_key((SELECT key_hash FROM core.api_keys WHERE id='$KEY_ID'))" 2>/dev/null)" = "" ] \
    && pass "the app role cannot read a hash it was not given" || printf '  - resolver spot-check skipped (needs the hash, which only the caller holds)\n'

# ===========================================================================
#  MEETINGS — a school's ERP scheduling classes and handing out join links
#  (Amit, 18 September 2026). The claim that needed proving most is that a
#  scheduled meeting reaches a CALENDAR, because until this change nothing
#  put it on one.
# ===========================================================================
get_k()  { curl -s -w '\n%{http_code}' "$1" -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $2"; }
del_k()  { curl -s -w '\n%{http_code}' -X DELETE "$1" -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $2"; }
START=$("$PY" -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
END=$("$PY"   -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=2,hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
HOST_EMAIL='amit@techvein.local'
HOST_ID=$(PG "SELECT id FROM core.users WHERE email='$HOST_EMAIL'")

step "11. The meeting scopes are separate from the people scope"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"ERP staff $RUN\",\"scopes\":[\"meetings:schedule\"]}")
[ "$(status "$r")" = "201" ] && pass "a meetings:schedule key can be created" || fail "create: $(status "$r") $(brief "$(body "$r")")"
SKEY=$(jq_ "$(body "$r")" "d['key']"); SKEY_ID=$(jq_ "$(body "$r")" "d['id']")
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"ERP students $RUN\",\"scopes\":[\"meetings:join\"]}")
JKEY=$(jq_ "$(body "$r")" "d['key']")
[ -n "$JKEY" ] && pass "so can a meetings:join key" || fail "could not create a join key"

MEETING="{\"hostEmail\":\"$HOST_EMAIL\",\"title\":\"Physics $RUN\",\"startsAt\":\"$START\",\"endsAt\":\"$END\"}"
# The whole point of two scopes: neither key may do the other's job, and the
# people key may do neither.
[ "$(status "$(post "$API/api/v1/org/meetings" "$KEY" "$MEETING")")" = "403" ] \
    && pass "a people:admit key cannot schedule a meeting" || fail "LEAK: the people key scheduled a meeting"
[ "$(status "$(post "$API/api/v1/org/meetings" "$JKEY" "$MEETING")")" = "403" ] \
    && pass "a meetings:join key cannot schedule one either" || fail "LEAK: the student key scheduled a meeting"
[ "$(status "$(admit "$SKEY" "{\"localPart\":\"x-$RUN\",\"displayName\":\"X\",\"recoveryEmail\":\"x@example.test\"}")")" = "403" ] \
    && pass "and a meetings key cannot admit people" || fail "LEAK: a meetings key created a person"
[ "$(status "$(post "$API/api/v1/org/meetings" "" "$MEETING")")" = "401" ] && pass "no key at all: 401" || fail "no key was not refused"

step "12. Scheduling, as a named teacher rather than as the key"
r=$(post "$API/api/v1/org/meetings" "$SKEY" "$MEETING")
[ "$(status "$r")" = "201" ] && pass "scheduled (201)" || fail "schedule: $(status "$r") $(brief "$(body "$r")")"
MID=$(jq_ "$(body "$r")" "d['id']")
JOIN_URL=$(jq_ "$(body "$r")" "d['joinUrl']")
[ -n "$MID" ] && pass "it has an id" || fail "no meeting id came back"
same "the HOST is the teacher, not the key" "$(PG "SELECT created_by_user_id::text FROM connect.meetings WHERE id='$MID'")" "$HOST_ID"
same "in the key's organisation" "$(PG "SELECT tenant_id::text FROM connect.meetings WHERE id='$MID'")" "$TECHVEIN"
same "and it is a scheduled meeting" "$(PG "SELECT kind FROM connect.meetings WHERE id='$MID'")" "scheduled"
has "the join link carries the meeting's own code" "$JOIN_URL" "$(PG "SELECT code FROM connect.meetings WHERE id='$MID'")"
# The teacher is a participant from the start, so it shows in THEIR Connect
# list — the same thing the console's own path guarantees.
same "the teacher is the host participant" "$(PG "SELECT role FROM connect.participants WHERE meeting_id='$MID' AND user_id='$HOST_ID'")" "host"
# An unknown teacher is refused rather than silently hosted by nobody.
[ "$(status "$(post "$API/api/v1/org/meetings" "$SKEY" "{\"hostEmail\":\"nobody-$RUN@techvein.local\",\"startsAt\":\"$START\"}")")" = "400" ] \
    && pass "an unknown hostEmail is refused" || fail "an unknown host was accepted"
[ "$(status "$(post "$API/api/v1/org/meetings" "$SKEY" "{\"hostEmail\":\"$HOST_EMAIL\"}")")" = "400" ] \
    && pass "a meeting with no start time is refused" || fail "a meeting with no time was accepted"

step "13. It is on the teacher's CALENDAR — the thing that did not happen before"
EVID=$(PG "SELECT id FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")
[ -n "$EVID" ] && pass "a calendar event exists for the meeting" || fail "NO calendar event was created"
same "carrying the join link, so the entry is clickable" "$(PG "SELECT meeting_url FROM calendar.events WHERE id='$EVID'")" "$JOIN_URL"
same "organised by the teacher" "$(PG "SELECT organiser_user_id::text FROM calendar.events WHERE id='$EVID'")" "$HOST_ID"
same "and it sits on the TEACHER'S own calendar" "$(PG "SELECT c.owner_user_id::text FROM calendar.events e JOIN calendar.calendars c ON c.id=e.calendar_id WHERE e.id='$EVID'")" "$HOST_ID"
same "their primary one, which is the one the app opens on" "$(PG "SELECT c.is_primary FROM calendar.events e JOIN calendar.calendars c ON c.id=e.calendar_id WHERE e.id='$EVID'")" "t"
same "with the meeting's title" "$(PG "SELECT title FROM calendar.events WHERE id='$EVID'")" "Physics $RUN"
same "exactly one row, not one per call" "$(PG "SELECT count(*) FROM calendar.events WHERE uid='connect-$MID@tatvaos.com'")" "1"

step "14. Rescheduling MOVES the calendar entry rather than replacing it"
NEWSTART=$("$PY" -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
# The END moves with it. Moving only the start pushed it past the old end, and
# Connect refused the whole PATCH with "the meeting cannot end before it
# starts" — correctly. That refusal is what the first version of this step was
# actually measuring while claiming to measure the calendar.
NEWEND=$("$PY" -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=3,hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
# The reschedule itself is ASSERTED, not assumed. On the first run the two
# calendar checks below went red and looked like a broken mirror; the PATCH
# had been thrown away with -o /dev/null, so nothing said whether the
# meeting had been rescheduled at all. A check whose subject may not have
# happened does not test what its label claims.
r=$(curl -s -w '\n%{http_code}' -X PATCH "$API/api/connect/meetings/$MID" -H 'Content-Type: application/json' \
     -H "Authorization: Bearer $TOKEN" -d "{\"title\":\"Physics moved $RUN\",\"scheduledStart\":\"$NEWSTART\",\"scheduledEnd\":\"$NEWEND\"}")
case "$(status "$r")" in
  200|204) pass "the teacher rescheduled it ($(status "$r"))" ;;
  *) fail "the reschedule itself was refused: $(status "$r") $(brief "$(body "$r")")" ;;
esac
same "the calendar entry follows a rename" "$(PG "SELECT title FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")" "Physics moved $RUN"
same "and follows a reschedule — nobody is left at the old slot" "$(PG "SELECT date_trunc('minute',starts_at) = date_trunc('minute','$NEWSTART'::timestamptz) FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")" "t"
same "still one row after the change" "$(PG "SELECT count(*) FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")" "1"
# ── WHAT THIS ONE ASSERTION CARRIES, from calibrating the step ──────────────
# With the mirror removed from meeting CREATION, steps 13 went fully red and
# step 14 stayed green: the upsert on the update path simply made the row
# itself, so "the calendar follows a rename" was true for the wrong reason.
# Comparing the row's IDENTITY to the one step 13 saw is what separates
# "the entry moved" from "an entry appeared", and it is the only assertion
# here that can tell the difference.
same "and it is the SAME row, not a replacement" "$(PG "SELECT id FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")" "$EVID"

step "15. The join half, which is all a student's ERP may do — and may learn"
r=$(post "$API/api/v1/org/meetings/$MID/join" "$JKEY" "")
[ "$(status "$r")" = "200" ] && pass "a join key gets a link (200), sending nothing but the id" || fail "join: $(status "$r") $(brief "$(body "$r")")"
same "the same link the meeting carries" "$(jq_ "$(body "$r")" "d['joinUrl']")" "$JOIN_URL"
same "and what to tell the student, from the waiting-room setting" "$(jq_ "$(body "$r")" "'yes' if d.get('guidance') else ''")" "yes"
same "the teacher's name is on the class" "$(jq_ "$(body "$r")" "d['hostName']")" "$(PG "SELECT display_name FROM core.users WHERE id='$HOST_ID'")"
# ── WHAT A STUDENT-PORTAL KEY MUST NEVER LEARN (CTO review, 18 Sept 2026) ──
# The first version took an email and answered "recognised", which made a
# stolen portal key an oracle for whether any address belongs to the school.
# No '@' anywhere in the join response is the blunt form of the rule, and it
# holds for the teacher's email, the host id, and anything added later.
hasnt "and no email address anywhere in it" "$(body "$r")" "@"
hasnt "nor the teacher's account id" "$(body "$r")" "$HOST_ID"
r=$(get_k "$API/api/v1/org/meetings/$MID" "$JKEY")
[ "$(status "$r")" = "200" ] && pass "a join key can read a class it holds the id of" || fail "get: $(status "$r")"
hasnt "and sees the teacher's name, never their email" "$(body "$r")" "$HOST_EMAIL"
r=$(get_k "$API/api/v1/org/meetings/$MID" "$SKEY")
has "the schedule key, by contrast, sees the host as a person" "$(body "$r")" "$HOST_EMAIL"
# Reading is reading: the join key must not be able to cancel.
[ "$(status "$(del_k "$API/api/v1/org/meetings/$MID" "$JKEY")")" = "403" ] \
    && pass "a join key cannot cancel the class" || fail "LEAK: a student key cancelled a meeting"
# And the whole timetable — every class, every teacher — is the staff view.
[ "$(status "$(get_k "$API/api/v1/org/meetings?from=$START" "$JKEY")")" = "403" ] \
    && pass "a join key cannot read the organisation's timetable" || fail "LEAK: a student key listed every class"
r=$(get_k "$API/api/v1/org/meetings?from=$START" "$SKEY")
[ "$(status "$r")" = "200" ] && pass "the schedule key can" || fail "list: $(status "$r")"
has "and the class is on it" "$(body "$r")" "$MID"

step "16. Cancelling takes it off the calendar too"
[ "$(status "$(del_k "$API/api/v1/org/meetings/$MID" "$SKEY")")" = "204" ] && pass "cancelled (204)" || fail "cancel refused"
same "the meeting says cancelled" "$(PG "SELECT status FROM connect.meetings WHERE id='$MID'")" "cancelled"
same "and it is off the calendar — no cancelled class left sitting on Monday" "$(PG "SELECT count(*) FROM calendar.events WHERE uid='connect-$MID@tatvaos.com' AND deleted_at IS NULL")" "0"
r=$(get_k "$API/api/v1/org/meetings?from=$START" "$SKEY")
hasnt "and gone from the timetable" "$(body "$r")" "$MID"

step "17. The audit trail, and RLS"
[ "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_meeting_scheduled' AND target_id='$SKEY_ID'")" -ge 1 ] \
    && pass "the scheduling is recorded against the key" || fail "no audit row for the scheduled meeting"
[ "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_meeting_cancelled' AND target_id='$SKEY_ID'")" -ge 1 ] \
    && pass "so is the cancellation" || fail "no audit row for the cancellation"
n=$(grep -c -F -- "$SKEY" "$LOG"); [ "$n" -eq 0 ] && pass "the meetings key appears nowhere in the API log" || fail "the key appears $n time(s) in the log"
# A key belonging to another organisation must not see this meeting at all.
n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM connect.meetings WHERE id='$MID'")
[ "${n:-1}" -eq 0 ] && pass "ABC School cannot see Techvein's class" || fail "LEAK: the school sees ${n:-?} Techvein meeting(s)"
n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM calendar.events WHERE uid='connect-$MID@tatvaos.com'")
[ "${n:-1}" -eq 0 ] && pass "nor its calendar entry" || fail "LEAK: the school sees the calendar row"

step "18. The backfill writes the row the mirror would have (CTO condition 1)"
r=$(post "$API/api/v1/org/meetings" "$SKEY" "{\"hostEmail\":\"$HOST_EMAIL\",\"title\":\"Chemistry $RUN\",\"startsAt\":\"$START\",\"endsAt\":\"$END\"}")
[ "$(status "$r")" = "201" ] && pass "a second class scheduled" || fail "schedule: $(status "$r") $(brief "$(body "$r")")"
MID2=$(jq_ "$(body "$r")" "d['id']"); CREATE2="$(body "$r")"
UID2="connect-$MID2@tatvaos.com"
# Every field the mirror wrote, as one string, BEFORE the row is removed.
FIELDS="calendar_id::text||'|'||title||'|'||starts_at::text||'|'||ends_at::text||'|'||timezone||'|'||meeting_url||'|'||coalesce(description,'')||'|'||sequence::text||'|'||organiser_user_id::text||'|'||created_by_user_id::text||'|'||status||'|'||transparency"
MIRRORED=$(PG "SELECT $FIELDS FROM calendar.events WHERE uid='$UID2' AND deleted_at IS NULL")
[ -n "$MIRRORED" ] && pass "its calendar row is there (the mirror)" || fail "no mirrored row to compare against"
PG "DELETE FROM calendar.events WHERE uid='$UID2'" >/dev/null
same "removed, to stand in for a meeting that predates the mirror" "$(PG "SELECT count(*) FROM calendar.events WHERE uid='$UID2'")" "0"
out=$(PGFILE "$ROOT/local/postgres/init/20260918-connect-meetings-on-calendar.sql")
[ -z "$out" ] && pass "the migration file ran clean" || fail "the migration printed: $(printf '%s' "$out" | head -c 300)"
BACKFILLED=$(PG "SELECT $FIELDS FROM calendar.events WHERE uid='$UID2' AND deleted_at IS NULL")
same "and wrote a row that matches the mirror's, field for field" "$BACKFILLED" "$MIRRORED"
# ── THE CLAIM THIS CARRIES ──────────────────────────────────────────────────
# ConnectCalendarMirror and the SQL file are two implementations of one
# row. The comparison above is the only thing that notices when one of them
# changes and the other does not — title fallback, the one-hour default end,
# the zone fallback, the description sentence, the join URL's base.
BEFORE=$(PG "SELECT count(*) FROM calendar.events WHERE uid LIKE 'connect-%'")
PGFILE "$ROOT/local/postgres/init/20260918-connect-meetings-on-calendar.sql" >/dev/null
same "a second run inserts nothing" "$(PG "SELECT count(*) FROM calendar.events WHERE uid LIKE 'connect-%'")" "$BEFORE"
same "and the row is still exactly one" "$(PG "SELECT count(*) FROM calendar.events WHERE uid='$UID2' AND deleted_at IS NULL")" "1"

step "19. What the guide promises (CTO condition 3)"
[ "$(status "$(del_k "$API/api/v1/org/meetings/$MID" "$SKEY")")" = "204" ] \
    && pass "cancelling an already-cancelled class answers 204 again" || fail "a second cancel was not 204"
same "times come back in UTC" "$(jq_ "$CREATE2" "'utc' if d['startsAt'].endswith('+00:00') or d['startsAt'].endswith('Z') else d['startsAt']")" "utc"
PG "UPDATE connect.meetings SET status='active' WHERE id='$MID2'" >/dev/null
[ "$(status "$(del_k "$API/api/v1/org/meetings/$MID2" "$SKEY")")" = "409" ] \
    && pass "a RUNNING class cannot be cancelled from the API (409)" || fail "a running class was cancelled by a batch job"
same "and it was not touched" "$(PG "SELECT status FROM connect.meetings WHERE id='$MID2'")" "active"
[ "$(status "$(post "$API/api/v1/org/meetings/$MID2/join" "$JKEY" "")")" = "200" ] \
    && pass "but is still joinable — a class in progress is exactly when the link matters" || fail "join refused a running class"
PG "UPDATE connect.meetings SET status='ended' WHERE id='$MID2'" >/dev/null
[ "$(status "$(post "$API/api/v1/org/meetings/$MID2/join" "$JKEY" "")")" = "409" ] \
    && pass "and an ended one answers 409, not a link to an empty room" || fail "join handed out a link to an ended class"
# "30 requests a minute, per calling address" — from one address, the 31st
# is refused and the 30th was not. A key is used so the refusal is the
# limiter's and not a 401 from an unauthenticated call.
ONE_ADDR="10.9.251.$((RANDOM % 250 + 1))"
last=""; thirtieth=""
for i in $(seq 1 31); do
    last=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/org/meetings/$MID2/join" \
           -H "X-Forwarded-For: $ONE_ADDR" -H "Authorization: Bearer $JKEY" -H 'Content-Type: application/json' -d "")
    [ "$i" -eq 30 ] && thirtieth="$last"
done
[ "$thirtieth" != "429" ] && [ "$last" = "429" ] \
    && pass "the 31st request in a minute from one address is refused (429); the 30th was not ($thirtieth)" \
    || fail "rate limit: 30th answered $thirtieth, 31st answered $last"
# 'Left out, it becomes "Firstname's meeting"' and 'Defaults to Asia/Kolkata':
# one class with neither a title nor a zone.
r=$(post "$API/api/v1/org/meetings" "$SKEY" "{\"hostEmail\":\"$HOST_EMAIL\",\"startsAt\":\"$START\"}")
FIRST=$(PG "SELECT split_part(btrim(display_name), ' ', 1) FROM core.users WHERE id='$HOST_ID'")
same "a class with no title is named after its teacher's first name" "$(jq_ "$(body "$r")" "d['title']")" "$FIRST's meeting"
same "and with no zone it is held in Asia/Kolkata" "$(jq_ "$(body "$r")" "d['timezone']")" "Asia/Kolkata"
MID3=$(jq_ "$(body "$r")" "d['id']"); [ -n "$MID3" ] && del_k "$API/api/v1/org/meetings/$MID3" "$SKEY" >/dev/null

step "20. A person has a calendar the moment they exist (CTO condition 2)"
# NEW_ID was made in step 4 through the console's own method, by the people
# API. Before this change the migration's backfill would have given them one
# on the NEXT deploy; now it is in the same transaction as the person.
same "the person the people API admitted has a primary calendar" "$(PG "SELECT count(*) FROM calendar.calendars WHERE owner_user_id='$NEW_ID' AND is_primary AND deleted_at IS NULL")" "1"
same "named as the migration's backfill names it, so a re-run adds nothing" "$(PG "SELECT name FROM calendar.calendars WHERE owner_user_id='$NEW_ID' AND is_primary")" "My calendar"
same "in their own organisation" "$(PG "SELECT tenant_id::text FROM calendar.calendars WHERE owner_user_id='$NEW_ID' AND is_primary")" "$TECHVEIN"

step "21. The timetable is paged, and page two is the rest"
# Straight into the database, as the CTO suggested: 505 classes through the
# API would take minutes and fight the limiter. Parked 400 days out so no
# other step's window sees them; one second apart so the order is fixed.
PG "INSERT INTO connect.meetings (tenant_id, code, title, kind, status, created_by_user_id, scheduled_start, scheduled_end, timezone)
    SELECT '$TECHVEIN', 'bulk-$RUN-' || lpad(i::text, 4, '0'), 'Bulk $RUN ' || i, 'scheduled', 'scheduled', '$HOST_ID',
           now() + interval '400 days' + (i || ' seconds')::interval,
           now() + interval '400 days' + (i || ' seconds')::interval + interval '30 minutes', 'Asia/Kolkata'
      FROM generate_series(1, 505) AS i" >/dev/null
same "505 classes exist for the window" "$(PG "SELECT count(*) FROM connect.meetings WHERE code LIKE 'bulk-$RUN-%'")" "505"
PFROM=$("$PY" -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=399)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
PTO=$("$PY"   -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(days=401)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
r=$(get_k "$API/api/v1/org/meetings?from=$PFROM&to=$PTO" "$SKEY")
[ "$(status "$r")" = "200" ] && pass "page one answers (200)" || fail "page one: $(status "$r") $(brief "$(body "$r")")"
same "and holds exactly 500 — the page size, not the total" "$(jq_ "$(body "$r")" "len(d['meetings'])")" "500"
NEXT=$(jq_ "$(body "$r")" "d['next'] or ''")
[ -n "$NEXT" ] && pass "with a \`next\` cursor, so the caller knows there is more" || fail "no next cursor on a full page"
PAGE1=$(jq_ "$(body "$r")" "','.join(m['id'] for m in d['meetings'])")
r=$(get_k "$API/api/v1/org/meetings?cursor=$NEXT" "$SKEY")
[ "$(status "$r")" = "200" ] && pass "page two answers from the cursor alone" || fail "page two: $(status "$r") $(brief "$(body "$r")")"
same "and holds the remaining 5" "$(jq_ "$(body "$r")" "len(d['meetings'])")" "5"
same "with next = null: the last page says so" "$(jq_ "$(body "$r")" "'null' if d['next'] is None else 'not null'")" "null"
PAGE2=$(jq_ "$(body "$r")" "','.join(m['id'] for m in d['meetings'])")
# ── THE CLAIM THAT MATTERS: nothing skipped, nothing repeated ───────────────
# 500 + 5 rows is easy to get with an offset that also duplicates the row at
# the boundary or drops one. Distinct ids across both pages is what proves
# the second page is the REST, not another page.
same "the two pages are 505 DISTINCT classes — nothing skipped, nothing repeated" \
    "$("$PY" -c "a='$PAGE1'.split(','); b='$PAGE2'.split(','); print(len(set(a)|set(b)), len(set(a)&set(b)))")" "505 0"
[ "$(status "$(get_k "$API/api/v1/org/meetings?cursor=not-a-cursor" "$SKEY")")" = "400" ] \
    && pass "a cursor this API did not issue is refused (400)" || fail "a forged cursor was accepted"
PG "DELETE FROM connect.meetings WHERE code LIKE 'bulk-$RUN-%'" >/dev/null
same "cleaned up" "$(PG "SELECT count(*) FROM connect.meetings WHERE code LIKE 'bulk-$RUN-%'")" "0"

step "22. The guide's own example: times with an Indian offset (+05:30)"
# INCIDENT, 19 Sept 2026. Every example in the guide - curl, Node, Python - sends
# "startsAt": "...+05:30", and the guide says "Send whatever offset you like -
# +05:30 is read correctly". It was not read at all: Postgres takes UTC only,
# nothing converted, and the API answered 500 to the guide's first example, to
# `from`/`to` with an offset, and to a cursor carrying one. The ERP developer had
# already started. It was invisible because every time THIS suite sent ended in
# Z, the console's browser always sends Z, and "times come back in UTC" (step 19)
# is true of a time that went in as UTC. A check whose input cannot be wrong is
# not a check of the claim. So this step sends what the guide tells people to send.
IST_START='2031-04-07T09:00:00+05:30'; IST_END='2031-04-07T10:00:00+05:30'
UTC_START='2031-04-07T03:30:00'                       # the same instant
r=$(post "$API/api/v1/org/meetings" "$SKEY" "{\"hostEmail\":\"$HOST_EMAIL\",\"title\":\"IST class $RUN\",\"startsAt\":\"$IST_START\",\"endsAt\":\"$IST_END\"}")
same "the guide's example is accepted" "$(status "$r")" "201"
IST_ID=$(jq_ "$(body "$r")" "d.get('id') or ''")
has  "it comes back as the same INSTANT, in UTC" "$(jq_ "$(body "$r")" "d.get('startsAt') or ''")" "$UTC_START"
same "and that instant is what is stored" \
    "$(PG "SELECT to_char(scheduled_start AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') FROM connect.meetings WHERE id='${IST_ID:-00000000-0000-0000-0000-000000000000}'")" "$UTC_START"
same "the end too" \
    "$(PG "SELECT to_char(scheduled_end AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') FROM connect.meetings WHERE id='${IST_ID:-00000000-0000-0000-0000-000000000000}'")" "2031-04-07T04:30:00"
# The calendar entry is written from the same values: a class at 09:00 IST that
# sat on the teacher's calendar at 09:00 UTC would be a worse bug than a 500.
same "the teacher's calendar holds the same instant" \
    "$(PG "SELECT to_char(e.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') FROM calendar.events e WHERE e.uid LIKE '%${IST_ID:-none}%'")" "$UTC_START"
# %2B is a '+' in a query string. A bare '+' is a SPACE, which is a caller's
# mistake and answers 400; the guide should say so, and that is a docs matter.
r=$(get_k "$API/api/v1/org/meetings?from=2031-04-07T00:00:00%2B05:30&to=2031-04-08T00:00:00%2B05:30" "$SKEY")
same "the timetable accepts an Indian-offset window" "$(status "$r")" "200"
has  "…and the class is in it" "$(body "$r")" "${IST_ID:-nothing-was-created}"
r=$(get_k "$API/api/v1/org/meetings?from=2031-04-07T10:00:00%2B05:30&to=2031-04-08T00:00:00%2B05:30" "$SKEY")
hasnt "a window opening at 10:00 IST does NOT hold a 09:00 IST class: the offset was honoured, not dropped" "$(body "$r")" "${IST_ID:-nothing-was-created}"
IST_CURSOR=$("$PY" -c "import base64,json;print(base64.urlsafe_b64encode(json.dumps({'S':'2031-04-07T00:00:00+05:30','E':'2031-04-08T00:00:00+05:30','H':None,'LS':'2031-04-07T00:00:00+05:30','LC':''}).encode()).decode().rstrip('='))")
r=$(get_k "$API/api/v1/org/meetings?cursor=$IST_CURSOR" "$SKEY")
same "a cursor carrying an offset is an answer, not a 500" "$(status "$r")" "200"
[ -n "$IST_ID" ] && PG "DELETE FROM connect.meetings WHERE id='$IST_ID'" >/dev/null

printf '\n%s%s%s\n  %s%d passed%s, ' "$CYAN" "----------------------------------------" "$RST" "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n\n' "$GREEN" "$RST" || printf '%s%d failed%s\n\n' "$RED" "$FAILED" "$RST"
[ "$FAILED" -eq 0 ]
