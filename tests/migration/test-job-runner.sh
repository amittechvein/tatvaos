#!/usr/bin/env bash
#
# TatvaOS - Google Workspace migration: the job runner survives being killed.
#
# WHAT THE DESIGN ASKS (docs/GOOGLE_MIGRATION_DESIGN.md, section 3.2, Mr.
# Singh 8 Oct 2026): "resumability proven by killing the process mid-run and
# watching it continue - not by reading the code and believing it", and
# "idempotency by Message-ID ... a migration will be re-run; it must not
# duplicate". So this starts the REAL API with the REAL worker, against the
# synthetic source (a fake Google, Development only), and:
#
#   1. isolation, with no API: each organisation sees its own jobs and not the
#      other's; with no organisation set, nothing; an item cannot hang off
#      another organisation's job; job_tenants() lists only live
#      organisations with a ready job that has a target person
#   2. one job in each of two organisations; every 10th item is a duplicate
#      of the one before (the three-labels shape); item 120 fails once
#   3. while the failure is fresh: the job is back to pending with attempts 1,
#      and last_error names the failure WITHOUT the PEM-shaped canary the
#      exception carried (design section 9: no credential in an error)
#   4. SIGKILL the API mid-run - no shutdown, no lease handed back
#   5. start it again; the dead lease expires, the job is claimed again and
#      the log says it resumed from its cursor
#   6. what it DID: both jobs completed; every item recorded exactly once;
#      exactly the duplicates skipped, nothing else; counts on the job equal
#      the ledger; every item in its own job's organisation
#
# ITS OWN DATABASE (house rule 13), dropped at the end, pass or fail.
# Build first:  dotnet build apps/api -c Release
# Needs psql on PATH and Postgres reachable with the PG* variables, e.g. the
# local stack: PGHOST=localhost PGUSER=postgres PGPASSWORD=devpass
# Runs in about two minutes. Exit 0 pass, 1 fail, 2 could not run.
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${TATVAOS_ROOT:-$HERE}"
DLL="$ROOT/apps/api/bin/Release/net10.0/TatvaOS.Api.dll"
PORT="${TATVAOS_MIGRATION_TEST_PORT:-5098}"
API="http://localhost:$PORT"
SCRATCH="$HERE/.tmp/migration-runner-$$"; mkdir -p "$SCRATCH"
TECHVEIN="11111111-1111-1111-1111-111111111111"; SCHOOL="22222222-2222-2222-2222-222222222222"
HR_ID="d1111111-1111-1111-1111-111111111112"; PR_ID="d2222222-2222-2222-2222-222222222222"
# FAIL_AT must not be a multiple of ten: those items are duplicates, skipped
# without being written, so a failure planted on one would never fire.
N_TV=500; N_SC=200; FAIL_AT=123

[ -f "$DLL" ] || { echo "  no build at $DLL - run: dotnet build apps/api -c Release"; exit 2; }

# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create migration || exit 2

PG() { $TATVAOS_PSQL "$1" 2>&1 | tr -d "\r" | tail -n1; }
# As the API's own role, inside one organisation (or none: pass "").
APP() {
    PGPASSWORD=dev_app_pw psql -h "$TDB_HOST" -U tatvaos_app -d "$TDB_NAME" -Atq -X \
        -c "SELECT set_config('app.tenant_id', '$1', false)" -c "$2" 2>&1 | tr -d "\r" | tail -n1
}

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}

API_PID=""
stop_api() { # stop_api SIGNAL
    [ -n "$API_PID" ] && kill "-$1" "$API_PID" >/dev/null 2>&1
    for _ in $(seq 1 20); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.5; done
    API_PID=""
}
cleanup() {
    stop_api KILL
    tdb_drop    # after the API, so nothing is connected when it goes
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

start_api() { # start_api LOGFILE
    export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
    export ConnectionStrings__Postgres="$TDB_CONN" Oidc__KeyDirectory="$SCRATCH/keys"
    export Migration__Runner=on Migration__TickSeconds=1 Migration__LeaseSeconds=8 Migration__SliceSeconds=20
    export Migration__Synthetic__PageSize=25 Migration__Synthetic__DelayMs=30 Migration__Synthetic__FailOnceAtItem=$FAIL_AT
    dotnet "$DLL" > "$1" 2>&1 &
    API_PID=$!
    for _ in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && return 0; sleep 1; done
    return 1
}

printf "\n  Migration job runner\n  tree under test: %s%s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" \
    "$(git -C "$ROOT" diff --quiet HEAD 2>/dev/null || echo ' (+ UNCOMMITTED CHANGES - not a proof of any commit)')" "$TDB_NAME"

step "0. The schema is in place"
same "migration.jobs and migration.items have forced row-level security" \
    "$(PG "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='migration' AND c.relname IN ('jobs','items') AND c.relrowsecurity AND c.relforcerowsecurity")" "2"
same "migration.job_tenants() is a definer function" \
    "$(PG "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='migration' AND p.proname='job_tenants' AND p.prosecdef")" "1"
same "the seed people exist in their organisations" \
    "$(PG "SELECT count(*) FROM core.users WHERE (id='$HR_ID' AND tenant_id='$TECHVEIN') OR (id='$PR_ID' AND tenant_id='$SCHOOL')")" "2"

step "1. Isolation, before anything runs"
# Planted as the superuser (RLS does not apply to it). Not yet due, so the
# API started later does not race this step.
# WITH ... SELECT, not a bare RETURNING: psql -Atc prints the INSERT's status
# line after the id, and tail -n1 would take that.
TV_JOB=$(PG "WITH x AS (INSERT INTO migration.jobs (tenant_id, source, data_type, source_user, target_user_id, items_total, state, next_attempt_at)
             VALUES ('$TECHVEIN', 'synthetic', 'mail', 'hr@techvein.example', '$HR_ID', $N_TV, 'pending', now() + interval '1 day') RETURNING id) SELECT id FROM x")
SC_JOB=$(PG "WITH x AS (INSERT INTO migration.jobs (tenant_id, source, data_type, source_user, target_user_id, items_total, state, next_attempt_at)
             VALUES ('$SCHOOL', 'synthetic', 'mail', 'principal@abcschool.example', '$PR_ID', $N_SC, 'pending', now() + interval '1 day') RETURNING id) SELECT id FROM x")
NO_TARGET=$(PG "WITH x AS (INSERT INTO migration.jobs (tenant_id, source, data_type, source_user, items_total, state)
             VALUES ('$TECHVEIN', 'synthetic', 'contacts', 'nobody@techvein.example', 10, 'pending') RETURNING id) SELECT id FROM x")
# Enrolled but not started: has a target person, and must never be claimed.
PLANNED=$(PG "WITH x AS (INSERT INTO migration.jobs (tenant_id, source, data_type, source_user, target_user_id, items_total)
             VALUES ('$TECHVEIN', 'synthetic', 'calendar', 'hr@techvein.example', '$HR_ID', 10) RETURNING id) SELECT id FROM x")
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for j in "$TV_JOB" "$SC_JOB" "$NO_TARGET" "$PLANNED"; do printf '%s' "$j" | grep -Eq "$uuid" || { fail "could not plant the jobs: [$TV_JOB] [$SC_JOB] [$NO_TARGET]"; exit 1; }; done
pass "planted: a Techvein job, a School job, a Techvein job with no target person, and a planned one"
same "a job enrolled without a state is 'planned', not 'pending'" "$(PG "SELECT state FROM migration.jobs WHERE id='$PLANNED'")" "planned"

same "Techvein sees its own job (the check below can fail)" "$(APP "$TECHVEIN" "SELECT count(*) FROM migration.jobs WHERE id='$TV_JOB'")" "1"
same "School does not see Techvein's job" "$(APP "$SCHOOL" "SELECT count(*) FROM migration.jobs WHERE id='$TV_JOB'")" "0"
same "School sees exactly its own one job" "$(APP "$SCHOOL" "SELECT count(*) FROM migration.jobs")" "1"
same "with no organisation set, nothing is visible" "$(APP "" "SELECT count(*) FROM migration.jobs")" "0"
case "$(APP "$SCHOOL" "INSERT INTO migration.jobs (tenant_id, data_type, source_user) VALUES ('$TECHVEIN', 'mail', 'x@y') RETURNING 'inserted'")" in
    *"row-level security"*) pass "School cannot create a job in Techvein (refused by row-level security)";;
    *) fail "School created a job in Techvein, or was refused for another reason";;
esac
FK_OUT=$($TATVAOS_PSQL "INSERT INTO migration.items (tenant_id, job_id, source_id, outcome) VALUES ('$SCHOOL', '$TV_JOB', 'x', 'done')" 2>&1 | tr -d "\r")
case "$FK_OUT" in
    *fk_migration_item_job*) pass "an item cannot hang off another organisation's job (composite foreign key, even for the superuser)";;
    *) fail "an item was attached to another organisation's job, or refused for another reason: [$FK_OUT]";;
esac

PG "UPDATE migration.jobs SET next_attempt_at = now() WHERE id IN ('$TV_JOB', '$SC_JOB', '$NO_TARGET')" >/dev/null
same "job_tenants() lists both organisations once their jobs are due" \
    "$(APP "" "SELECT count(*) FROM migration.job_tenants() WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')")" "2"
PG "UPDATE core.tenants SET status='suspended' WHERE id='$SCHOOL'" >/dev/null
same "...and leaves out a suspended organisation" \
    "$(APP "" "SELECT count(*) FROM migration.job_tenants() WHERE tenant_id='$SCHOOL'")" "0"
PG "UPDATE core.tenants SET status='active' WHERE id='$SCHOOL'" >/dev/null

step "2. Start the API and let the real worker run"
start_api "$SCRATCH/api-1.log" && pass "API up (run 1)" || { fail "API did not start"; tail -20 "$SCRATCH/api-1.log"; exit 1; }
grep -q "Migration job runner on" "$SCRATCH/api-1.log" && pass "the runner says it is on" || fail "the runner did not say it is on"

step "3. The failure at item $FAIL_AT: retried, and its error carries no credential"
for _ in $(seq 1 90); do [ "$(PG "SELECT attempts FROM migration.jobs WHERE id='$TV_JOB'")" = "1" ] && break; sleep 0.5; done
ERR=$(PG "SELECT last_error FROM migration.jobs WHERE id='$TV_JOB'")
same "the failed page put the job back to pending, attempts 1" "$(PG "SELECT state || ' ' || attempts FROM migration.jobs WHERE id='$TV_JOB'")" "pending 1"
case "$ERR" in *"synthetic failure at item $FAIL_AT"*) pass "last_error names the failure";; *) fail "last_error does not name the failure: [$ERR]";; esac
case "$ERR" in *MIGRATIONCANARY*|*"BEGIN TEST CANARY"*) fail "last_error carries the PEM-shaped canary: [$ERR]";; *) pass "last_error does not carry the PEM-shaped canary";; esac
grep -q "MIGRATIONCANARY" "$SCRATCH/api-1.log" && fail "the API log carries the canary" || pass "the API log does not carry the canary"
same "nothing from the failed page was recorded (items stop at the page before)" \
    "$(PG "SELECT count(*) FROM migration.items WHERE job_id='$TV_JOB' AND source_id='syn-$FAIL_AT'")" "0"

step "4. Kill the API mid-run (SIGKILL: no shutdown, no lease handed back)"
for _ in $(seq 1 240); do
    n=$(PG "SELECT count(*) FROM migration.items WHERE job_id='$TV_JOB'")
    [ "${n:-0}" -ge 250 ] && break; sleep 0.25
done
stop_api KILL
AT_KILL=$(PG "SELECT state || ' ' || (lease_owner IS NOT NULL) FROM migration.jobs WHERE id='$TV_JOB'")
ITEMS_AT_KILL=$(PG "SELECT count(*) FROM migration.items WHERE job_id='$TV_JOB'")
CURSOR_AT_KILL=$(PG "SELECT cursor FROM migration.jobs WHERE id='$TV_JOB'")
same "killed while the job was running and leased" "$AT_KILL" "running true"
if [ "${ITEMS_AT_KILL:-0}" -gt 0 ] && [ "${ITEMS_AT_KILL:-0}" -lt "$N_TV" ]; then
    pass "killed mid-run: $ITEMS_AT_KILL of $N_TV items recorded, cursor $CURSOR_AT_KILL"
else fail "not killed mid-run: $ITEMS_AT_KILL of $N_TV items recorded"; fi
same "the cursor and the ledger agree at the kill (cursor = items recorded)" "$CURSOR_AT_KILL" "$ITEMS_AT_KILL"

step "5. Start it again: the dead lease expires and the job resumes"
start_api "$SCRATCH/api-2.log" && pass "API up (run 2)" || { fail "API did not start again"; tail -20 "$SCRATCH/api-2.log"; exit 1; }
for _ in $(seq 1 240); do
    [ "$(PG "SELECT count(*) FROM migration.jobs WHERE id IN ('$TV_JOB','$SC_JOB') AND state='completed'")" = "2" ] && break; sleep 0.5
done
grep -q "Migration job $TV_JOB claimed .*resuming from its cursor" "$SCRATCH/api-2.log" \
    && pass "run 2 claimed the Techvein job and resumed from its cursor" \
    || fail "run 2 did not log resuming the Techvein job: $(grep -m1 "$TV_JOB" "$SCRATCH/api-2.log" | head -c 300)"

step "6. What it did"
for row in "$TV_JOB Techvein $N_TV" "$SC_JOB School $N_SC"; do
    set -- $row; JOB=$1; WHO=$2; N=$3; DUP=$((N / 10)); DONE=$((N - DUP))
    same "$WHO: completed, lease cleared, no error" \
        "$(PG "SELECT state || ' ' || (lease_owner IS NULL) || ' ' || (finished_at IS NOT NULL) || ' ' || coalesce(last_error, '-') || ' ' || attempts FROM migration.jobs WHERE id='$JOB'")" \
        "completed true true - 0"
    same "$WHO: every item recorded exactly once" \
        "$(PG "SELECT count(*) || ' ' || count(DISTINCT source_id) FROM migration.items WHERE job_id='$JOB'")" "$N $N"
    same "$WHO: done / skipped / failed on the job" \
        "$(PG "SELECT items_done || ' ' || items_skipped || ' ' || items_failed FROM migration.jobs WHERE id='$JOB'")" "$DONE $DUP 0"
    same "$WHO: ...and the same counted from the ledger" \
        "$(PG "SELECT count(*) FILTER (WHERE outcome='done') || ' ' || count(*) FILTER (WHERE outcome='skipped') || ' ' || count(*) FILTER (WHERE outcome='failed') FROM migration.items WHERE job_id='$JOB'")" \
        "$DONE $DUP 0"
    same "$WHO: the skipped ones are exactly every tenth item, each a duplicate of the one before" \
        "$(PG "SELECT count(*) FROM migration.items WHERE job_id='$JOB' AND outcome='skipped' AND substr(source_id,5)::int % 10 = 0 AND reason = 'duplicate of syn-' || (substr(source_id,5)::int - 1)")" "$DUP"
    same "$WHO: no dedupe key was written twice" \
        "$(PG "SELECT count(*) FROM (SELECT dedupe_key FROM migration.items WHERE job_id='$JOB' AND outcome='done' GROUP BY dedupe_key HAVING count(*) > 1) d")" "0"
    same "$WHO: the cursor ended at the last item" "$(PG "SELECT cursor FROM migration.jobs WHERE id='$JOB'")" "$N"
done
same "every item is in its own job's organisation" \
    "$(PG "SELECT count(*) FROM migration.items i JOIN migration.jobs j ON j.id = i.job_id WHERE i.tenant_id <> j.tenant_id")" "0"
same "the job with no target person was never claimed" \
    "$(PG "SELECT state || ' ' || (started_at IS NULL) FROM migration.jobs WHERE id='$NO_TARGET'")" "pending true"
same "the PLANNED job was never claimed, though it has a target person" \
    "$(PG "SELECT state || ' ' || (started_at IS NULL) FROM migration.jobs WHERE id='$PLANNED'")" "planned true"
if grep -q "Migration sweep failed" "$SCRATCH"/api-*.log; then fail "a sweep failed: $(grep -m1 "sweep failed" "$SCRATCH"/api-*.log | head -c 300)"
else pass "neither run logged a sweep failure"; fi

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks   (database %s)\n\n" "$PASSED" "$TDB_NAME"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
