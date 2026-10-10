#!/usr/bin/env bash
#
# Runs tests/migration-enrol (MigrationEnrolment against a real database) in
# a throwaway database of its own (house rule 13), dropped at the end.
# Needs psql on PATH and the PG* variables for a superuser, e.g. the local
# stack: PGHOST=localhost PGUSER=postgres PGPASSWORD=devpass
# Exit 0 pass, 1 fail, 2 could not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create enrol || exit 2
printf "  tree under test: %s%s\n" "$(git -C "$HERE" rev-parse HEAD)" \
    "$(git -C "$HERE" diff --quiet HEAD || echo ' (+ UNCOMMITTED CHANGES - not a proof of any commit)')"
TDB_SUPER="Host=$TDB_HOST;Port=${PGPORT:-5432};Database=$TDB_NAME;Username=${PGUSER:-postgres};Password=${PGPASSWORD:-}" \
TDB_CONN="$TDB_CONN" dotnet run --project "$HERE/tests/migration-enrol"
rc=$?
[ $rc -eq 0 ] || { printf "  database: %s\n" "$TDB_NAME"; exit $rc; }

# ---------------------------------------------------------------------------
#  The endpoint, over HTTP, on the jobs the run above left: GET
#  /api/org/migration/people for each organisation's own admin, an ordinary
#  employee, and nobody. Needs a Release build of apps/api.
# ---------------------------------------------------------------------------
DLL="$HERE/apps/api/bin/Release/net10.0/TatvaOS.Api.dll"
[ -f "$DLL" ] || { echo "  no build at $DLL - run: dotnet build apps/api -c Release"; exit 2; }
PORT="${TATVAOS_ENROL_TEST_PORT:-5099}"; API="http://localhost:$PORT"
SCRATCH="$HERE/.tmp/migration-enrol-$$"; mkdir -p "$SCRATCH"
PG() { $TATVAOS_PSQL "$1" 2>&1 | tr -d "\r" | tail -n1; }
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"; else fail "$1 - got [$2], wanted [$3]"; fi
}
J() { python3 -c "import sys,json; d=json.loads(sys.stdin.read() or 'null'); print(eval(sys.argv[1]))" "$1"; }

# Started FROM its build folder: the content root is the working directory,
# and appsettings.json (Jwt:Audience among it) is read from there. Started from
# the repo root it found none, and every token was refused with "The audience
# 'empty' is invalid" - the existing storage endpoint too.
(cd "$(dirname "$DLL")" && JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API" \
ConnectionStrings__Postgres="$TDB_CONN" Oidc__KeyDirectory="$SCRATCH/keys" exec dotnet "$DLL") > "$SCRATCH/api.log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null; wait $API_PID 2>/dev/null; tdb_drop; rm -rf "$SCRATCH"' EXIT
for _ in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && break; sleep 1; done

signin() { # signin USER_ID PHONE ROLE -> access token (development one-time code)
    PG "UPDATE core.users SET phone='$2', role='$3', status='active', login_otp_sent_at=NULL WHERE id='$1'" >/dev/null
    local c; c=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$2\"}" | J "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"$2\",\"code\":\"$c\"}" | J "d.get('accessToken') or ''"
}
TV=$(signin d1111111-1111-1111-1111-111111111111 +919999900421 org_owner)
SC=$(signin d2222222-2222-2222-2222-222222222222 +919999900422 org_owner)
EMP=$(signin d1111111-1111-1111-1111-111111111112 +919999900423 employee)
[ -n "$TV" ] && [ -n "$SC" ] && [ -n "$EMP" ] && pass "signed in: Techvein's owner, ABC School's owner, a Techvein employee" \
    || { fail "could not sign in [$TV] [$SC] [$EMP]: $(tail -3 "$SCRATCH/api.log")"; exit 1; }

get() { curl -s -H "Authorization: Bearer $1" "$API/api/org/migration/people"; }
code() { curl -s -o /dev/null -w "%{http_code}" ${1:+-H "Authorization: Bearer $1"} "$API/api/org/migration/people"; }
same "Techvein's owner: its five enrolled people" "$(get "$TV" | J "d['totals']['people']")" "5"
same "...and its two shared drives, counted apart" "$(get "$TV" | J "d['totals']['sharedDrives']")" "2"
same "...three matched to a TatvaOS person" "$(get "$TV" | J "d['totals']['matched']")" "3"
same "...amit's mail pending, contacts planned" \
    "$(get "$TV" | J "','.join(t['dataType']+'='+t['state'] for p in d['people'] if p['googleAddress']=='amit@techvein.local' for t in p['types'])")" \
    "contacts=planned,mail=pending"
same "ABC School's owner: only its own two" "$(get "$SC" | J "','.join(sorted(p['googleAddress'] for p in d['people']))")" \
    "amit@techvein.local,principal@abcschool.local"
same "...and none of Techvein's (ghost is Techvein's)" "$(get "$SC" | J "sum(1 for p in d['people'] if p['googleAddress']=='ghost@techvein.local')")" "0"
same "an ordinary employee is refused" "$(code "$EMP")" "403"
same "no sign-in is refused" "$(code "")" "401"

printf "\n  -----------------------------------------------\n"
printf "  endpoint: %s  %d checks   (database %s)\n" "$([ $FAILED -eq 0 ] && echo PASS || echo FAIL)" $((PASSED+FAILED)) "$TDB_NAME"
[ $FAILED -eq 0 ]
