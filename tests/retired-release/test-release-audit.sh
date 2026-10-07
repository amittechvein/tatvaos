#!/usr/bin/env bash
#
# TatvaOS - releasing a retired address: the release and its audit line commit
# together, or neither does.
#
# WHY (Mr. Singh, 6 Oct 2026, after the round-one deploy). The startup check
# (OperatorWriteTransaction.Report) logged POST /api/admin/retired-addresses/
# {id}/release as an operator write route NOT covered by the operator
# transaction. The release's UPDATE ran through ExecuteSqlInterpolatedAsync
# and committed on its own; the audit line ("address.released") was a second,
# separate write. If that write failed, the address was released and nothing
# recorded who released it or why - while the class comment promised "every
# release is audited, so a mistaken one can be traced to who and why". Unlike
# the five personal-account routes beside it in that report, this one is in
# daily reach: it is the step that lets a used address be issued to someone else.
#
# WHAT IT PROVES, against the built API, on its own throwaway database
# (tests/lib/throwaway-db.sh, house rule 13):
#   1. with the database refusing every "address.released" audit line (a
#      trigger, the same way tests/audit-actor does it), a release FAILS and
#      the address stays held - released_at is still NULL
#   2. calibration: with the trigger gone, the same release succeeds, the row
#      is released, and the audit line names the operator - so (1)'s "still
#      held" was the refusal, not a request that could never work
#   3. the boot report no longer names the release route as uncovered, and
#      still names the five personal-account routes (unreachable today; they
#      wait for switch-on) - so the line is read, not assumed absent
#
# Build first:  dotnet build apps/api -c Release
# TATVAOS_ROOT=<another checkout> runs the same checks against that build
# (how the red run on main is taken).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${TATVAOS_ROOT:-$HERE}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_RETIRED_RELEASE_TEST_PORT:-5107}"
API="http://localhost:$PORT"
RUN=$(date +%s)
SCRATCH="$HERE/.tmp/retired-release-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$HERE/tests/lib/throwaway-db.sh"
    tdb_create retrel || exit 2
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
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
# Here-strings, not printf | grep -q (PR 389).
has()   { if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to look in/for"; elif grep -qF -- "$3" <<< "$2"; then pass "$1"; else fail "$1 - [$3] not found"; fi; }
hasnt() { if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to look in/for"; elif grep -qF -- "$3" <<< "$2"; then fail "$1 - [$3] FOUND"; else pass "$1"; fi; }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" -H "Authorization: Bearer $2" -d "$3"; }

API_PID=""
cleanup() {
    PG "DROP TRIGGER IF EXISTS zz_refuse_release_audit ON core.audit_logs" >/dev/null
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

printf "\n  Retired-address release: the change and its audit line, together\n  tree under test: %s\n  database: %s\n" \
    "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. The API, the operator, and an address ready to release"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=${TDB_NAME:-tatvaos_mail};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
export Personal__PhoneHashKey="test-only-phone-hash-key-at-least-32-characters"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

# The operator: the seeded principal, made super_admin for this run's database only.
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET role='super_admin', login_otp_sent_at=NULL, login_otp_attempts=0 WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR_ID=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900003"}' | j "d.get('devCode') or ''")
OPERATOR=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900003\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$OPERATOR" ] && pass "signed in as the operator" || { fail "operator sign-in failed"; exit 1; }

# A held address that meets every release condition: counted at zero files, no
# floor, and no mailbox or alias at it.
ADDR="rr-$RUN@techvein.local"
ID=$(PG "WITH x AS (INSERT INTO core.retired_addresses (address, tenant_id, source, files_left, files_checked_at) VALUES ('$ADDR', '11111111-1111-1111-1111-111111111111', 'user_deleted', 0, now()) RETURNING id) SELECT id FROM x")
[ -n "$ID" ] && pass "a releasable held address (id $ID)" || { fail "could not create the held address"; exit 1; }
held() { PG "SELECT (released_at IS NULL)::text FROM core.retired_addresses WHERE id=$ID"; }
audited() { PG "SELECT count(*) FROM core.audit_logs WHERE action='address.released' AND target_id='$ID'"; }

step "1. The database refuses the audit line: the release must not happen"
PG "CREATE OR REPLACE FUNCTION public.zz_refuse_release_audit() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION 'test: release audit refused'; END \$\$" >/dev/null
PG "CREATE TRIGGER zz_refuse_release_audit BEFORE INSERT ON core.audit_logs FOR EACH ROW WHEN (NEW.action = 'address.released') EXECUTE FUNCTION public.zz_refuse_release_audit()" >/dev/null
same "the refusing trigger is in place" "$(PG "SELECT count(*) FROM pg_trigger WHERE tgname='zz_refuse_release_audit'")" "1"
r=$(post "/api/admin/retired-addresses/$ID/release" "$OPERATOR" '{"reason":"retired-release test, refused"}')
same "the release fails (500: the audit line was refused)" "$(status "$r")" "500"
same "THE ADDRESS IS STILL HELD (released_at is NULL)" "$(held)" "true"
same "...and no audit line exists for it" "$(audited)" "0"

step "2. Calibration: the trigger gone, the same release works and is audited"
PG "DROP TRIGGER zz_refuse_release_audit ON core.audit_logs" >/dev/null
same "the trigger is gone" "$(PG "SELECT count(*) FROM pg_trigger WHERE tgname='zz_refuse_release_audit'")" "0"
r=$(post "/api/admin/retired-addresses/$ID/release" "$OPERATOR" '{"reason":"retired-release test, allowed"}')
same "the release succeeds" "$(status "$r")" "200"
same "the address is released" "$(held)" "false"
same "one audit line" "$(audited)" "1"
same "...naming the operator" "$(PG "SELECT actor_user_id FROM core.audit_logs WHERE action='address.released' AND target_id='$ID'")" "$OPERATOR_ID"
same "...and the row records who released it" "$(PG "SELECT released_by FROM core.retired_addresses WHERE id=$ID")" "$OPERATOR_ID"

step "3. The boot report: the release route is covered now"
REPORT=$(grep -A1 'OperatorWriteTransaction' "$LOG" | tr '\n' ' ')
has   "the report line was written (it is read, not assumed absent)" "$REPORT" "Operator write transaction"
hasnt "the release route is no longer named as uncovered" "$REPORT" "retired-addresses/{id:long}/release"
has   "the five personal-account routes still are (they wait for switch-on)" "$REPORT" "personal-lifecycle/run"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
