#!/usr/bin/env bash
# ============================================================================
#  A throwaway stack for making render-gate fixtures in the REAL editor
# ============================================================================
#
#  House rule 13 (and Mr. Singh, 30 Sept 2026): fixtures made from real
#  documents live only in a throwaway database, dropped at the end of the run.
#  Nothing made from a real customer's or Amit's document is kept unscrubbed.
#
#  This builds its own database (tests/lib/throwaway-db.sh: every init file,
#  twice), gives hr@techvein.local the test phone +919999900002, starts the
#  API on :5141 against it, switches Docs on for Techvein (allowed only on a
#  developer machine), then WAITS. While it waits, the web app on :3073
#  (NEXT_PUBLIC_API_URL=http://localhost:5141/api) is used in a browser to
#  load each fixture's editor document and read back what the editor shows.
#  Creating the file named by DONE ends the run: the API stops and the
#  database is DROPPED, pass or fail.
#
#    dotnet build apps/api -c Release
#    DONE=/some/file bash tests/docs-render/capture-harness.sh
#
#  Prints "READY <database name>" when the browser can start.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DONE="${DONE:?set DONE to a file path; creating it ends the run}"
API="http://localhost:5141"
SCRATCH="$(mktemp -d)"
# shellcheck source=../lib/throwaway-db.sh
source "$ROOT/tests/lib/throwaway-db.sh"
tdb_create render || exit 2
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PG "UPDATE core.users SET phone='+919999900002' WHERE email='hr@techvein.local'" >/dev/null
[ "$(PG "SELECT count(*) FROM core.users WHERE phone='+919999900002'")" = "1" ] || { echo "could not give the test phone to hr@techvein.local"; exit 1; }
TECHVEIN="$(PG "SELECT tenant_id FROM core.users WHERE email='hr@techvein.local'")"

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TDB_HOST;Port=5432;Database=$TDB_NAME;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Cors__Origins__0="http://localhost:3073"
export BOOTSTRAP_ADMIN_EMAIL="platform@docs.local" BOOTSTRAP_ADMIN_PASSWORD="dev-only-platform-pass"
export Smtp__Host=localhost Smtp__Port=5871
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$ROOT/apps/api/TatvaOS.Api.csproj" > "$SCRATCH/api.log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null; tdb_drop' EXIT
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 || { echo "API did not start"; tail -5 "$SCRATCH/api.log"; exit 1; }

TOKEN="$(curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  --data '{"email":"platform@docs.local","password":"dev-only-platform-pass"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')"
curl -s -o /dev/null -w "Docs on for Techvein (local): %{http_code}\n" -X PUT "$API/api/admin/organisations/$TECHVEIN/docs" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data '{"enabled":true}'

echo "READY $TDB_NAME"
while [ ! -e "$DONE" ]; do sleep 2; done
echo "DONE: stopping the API and dropping $TDB_NAME"
