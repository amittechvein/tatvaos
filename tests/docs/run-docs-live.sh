#!/usr/bin/env bash
# ============================================================================
#  Docs end-to-end, in its own throwaway database (house rule 13)
# ============================================================================
#
#  Builds a database from every file in local/postgres/init/ (twice — the
#  re-run check), gives the three people the test uses their phones, starts
#  the API on :5141 against it with Docs:RenderUrl pointing at the render
#  service the test itself starts (and stops, to prove a failed render fails
#  the save), runs tests/docs/docs-live.test.mjs, and drops the database on
#  the way out, pass or fail.
#
#    dotnet build apps/api -c Release
#    bash tests/docs/run-docs-live.sh
#
#  People: amit@techvein.local (owner, +919999900002), hr@techvein.local
#  (colleague, +919999900003), principal@abcschool.local (another
#  organisation, +919999900004). The platform operator is bootstrapped.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# CALIBRATION ONLY: DOCS_API_ROOT runs THIS test against the API (and schema)
# of another checkout — e.g. main, to show the proofs fail there first.
API_ROOT="${DOCS_API_ROOT:-$ROOT}"
export TATVAOS_ROOT="$API_ROOT"
API="http://localhost:5141"
RENDER_PORT="${DOCS_RENDER_PORT:-18450}"

# REFUSE A STALE BINARY. dotnet run --no-build runs whatever was last built:
# on 30 Sept a planted calibration failed to COMPILE and this test then ran
# the previous binary and passed — a green that proved nothing. So the API
# DLL must be newer than every source file under apps/api.
DLL="$(ls -t "$API_ROOT"/apps/api/bin/Release/net*/TatvaOS.Api.dll 2>/dev/null | head -1)"
[ -n "$DLL" ] || { echo "no Release build of the API: dotnet build apps/api -c Release"; exit 2; }
NEWER="$(find "$API_ROOT/apps/api" \( -name '*.cs' -o -name '*.csproj' -o -name 'appsettings*.json' \) -newer "$DLL" -not -path '*/obj/*' -not -path '*/bin/*' | head -3)"
[ -z "$NEWER" ] || { echo "the API build is OLDER than its source — rebuild first (dotnet build apps/api -c Release). Newer: $NEWER"; exit 2; }
SCRATCH="$(mktemp -d)"
# shellcheck source=../lib/throwaway-db.sh
source "$ROOT/tests/lib/throwaway-db.sh"
tdb_create docs_live || exit 2
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PG "UPDATE core.users SET phone = CASE email
      WHEN 'amit@techvein.local' THEN '+919999900002'
      WHEN 'hr@techvein.local' THEN '+919999900003'
      WHEN 'principal@abcschool.local' THEN '+919999900004' END
    WHERE email IN ('amit@techvein.local','hr@techvein.local','principal@abcschool.local')" >/dev/null
[ "$(PG "SELECT count(*) FROM core.users WHERE phone IN ('+919999900002','+919999900003','+919999900004')")" = "3" ] \
  || { echo "could not give the three test phones"; exit 1; }

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TDB_HOST;Port=5432;Database=$TDB_NAME;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export BOOTSTRAP_ADMIN_EMAIL="platform@docs.local" BOOTSTRAP_ADMIN_PASSWORD="dev-only-platform-pass"
export Docs__RenderUrl="http://127.0.0.1:$RENDER_PORT"
export Smtp__Host=localhost Smtp__Port=5871
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$API_ROOT/apps/api/TatvaOS.Api.csproj" > "$SCRATCH/api.log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null; tdb_drop' EXIT
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 || { echo "API did not start"; tail -5 "$SCRATCH/api.log"; exit 1; }

export DOCS_API="$API/api" DOCS_RENDER_PORT="$RENDER_PORT" TATVAOS_PSQL
NODE_PATH="${NODE_PATH:-}" node "$ROOT/tests/docs/docs-live.test.mjs"
RC=$?
echo "  (API log: $SCRATCH/api.log; database $TDB_NAME is dropped now)"
exit $RC
