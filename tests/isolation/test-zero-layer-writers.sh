#!/usr/bin/env bash
#
# TatvaOS - the writers of the two zero-layer tables still work under RLS
# (decision 0007, 20260927-d-zero-layer-rls.sql).
#
# Forcing row-level security on a table breaks, silently, any path that writes
# it without its organisation set: the WITH CHECK refuses the row. The
# isolation suite proves strangers are kept out; this proves the owners still
# get in, through the real API, on the paths that write:
#
#   core.departments  the operator creating an organisation inserts its default
#                     departments (OrganisationEndpoints.CreateAsync). Signup
#                     does the same through SignupEndpoints, which enters the
#                     new tenant the same way (read, not driven: signup needs a
#                     verified email round trip).
#   calendar.reminder_sends  CalendarReminderWorker - driven by
#                     tests/calendar/test-reminders.sh, not repeated here.
#
# Uses the Development-only operator sign-in (PR 281), which needs a loopback
# database: the API connects as Host=localhost (WSL forwards it).
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ZL_TEST_PORT:-5101}"
API="http://localhost:$PORT"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/zero-layer-writers-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TECHVEIN="11111111-1111-1111-1111-111111111111"
STARTER="a0000000-0000-0000-0000-000000000001"

# ITS OWN DATABASE (house rule 13; Mr. Singh, 29 Sept 2026): built by
# tests/lib/throwaway-db.sh from every file in local/postgres/init/ (applied
# twice: the re-run check) and dropped by cleanup(), pass or fail. Until then
# this ran in the shared local database. A caller that sets TATVAOS_PSQL is
# still obeyed.
TDB_USED=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    # shellcheck source=../lib/throwaway-db.sh
    source "$(cd "$(dirname "$0")/../.." && pwd)/tests/lib/throwaway-db.sh"
    tdb_create zerolayer_writers || exit 2
    TDB_USED=1
    TATVAOS_PG_HOST="$TDB_HOST"
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}

ORG_ID=""
API_PID=""
cleanup() {
    [ -n "$ORG_ID" ] && [ -z "$TDB_USED" ] && PG "DELETE FROM core.tenants WHERE id='$ORG_ID'" >/dev/null
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
trap cleanup EXIT

printf "\n  Zero-layer tables: the writers still work under RLS\n  tree under test: %s\n  database: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" "${TDB_NAME:-given by the caller (TATVAOS_PSQL)}"

step "0. RLS really is forced on both tables (else this proves nothing)"
same "core.departments: RLS forced" "$(PG "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'core.departments'::regclass")" "t"
same "calendar.reminder_sends: RLS forced" "$(PG "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'calendar.reminder_sends'::regclass")" "t"

step "1. Start the API as the Development operator"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API" DevOperatorSignIn__Enabled=true
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
# localhost, NOT the WSL address: the development operator sign-in refuses any
# database that is not on a loopback host, and WSL forwards localhost:5432.
export ConnectionStrings__Postgres="Host=localhost;Port=5432;Database=${TDB_NAME:-tatvaos_mail};Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
OP=$(curl -s -X POST "$API/api/dev/operator-session" | j "d.get('accessToken') or ''")
[ -n "$OP" ] && pass "operator signed in" || { fail "operator sign-in failed: $(curl -s -X POST "$API/api/dev/operator-session" | head -c 200)"; exit 1; }

step "2. The operator creates an organisation - its default departments are written under RLS"
BODY="{\"name\":\"ZL Org $RUN\",\"type\":\"business\",\"country\":\"India\",\"adminName\":\"ZL Admin\",\"adminEmail\":\"zl-admin-$RUN@zl$RUN.test\",\"primaryDomain\":\"zl$RUN.test\",\"planId\":\"$STARTER\",\"storageModel\":\"per_user\",\"maxUsers\":10}"
r=$(curl -s -w "\n%{http_code}" -X POST "$API/api/admin/organisations" -H "Content-Type: application/json" -H "Authorization: Bearer $OP" -d "$BODY")
code=$(printf '%s' "$r" | tail -n1)
ORG_ID=$(printf '%s' "$r" | sed '$d' | j "d.get('id') or ''")
[ -n "$ORG_ID" ] && [ "${code#2}" != "$code" ] && pass "organisation created  [got $code]" \
    || { fail "organisation not created - got $code: $(printf '%s' "$r" | sed '$d' | head -c 240)"; exit 1; }
N=$(PG "SELECT count(*) FROM core.departments WHERE tenant_id = '$ORG_ID'")
[ "${N:-0}" -ge 1 ] && pass "its default departments exist  [got $N]" \
    || fail "no departments for the new organisation - the RLS WITH CHECK refused the insert"
if grep -qiE "row-level security|42501" "$LOG"; then fail "the API log shows an RLS refusal: $(grep -m1 -iE "row-level security|42501" "$LOG" | head -c 200)"
else pass "no RLS refusal anywhere in the API log"; fi

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
