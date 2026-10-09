#!/usr/bin/env bash
#
# Runs tests/migration-drive (GoogleDriveSource against a real database) in
# a throwaway database of its own (house rule 13), dropped at the end.
# Needs psql on PATH and the PG* variables for a superuser, e.g. the local
# stack: PGHOST=localhost PGUSER=postgres PGPASSWORD=devpass
# Exit 0 pass, 1 fail, 2 could not run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create drive || exit 2
printf "  tree under test: %s%s\n" "$(git -C "$HERE" rev-parse HEAD)" \
    "$(git -C "$HERE" diff --quiet HEAD || echo ' (+ UNCOMMITTED CHANGES - not a proof of any commit)')"
TDB_SUPER="Host=$TDB_HOST;Port=${PGPORT:-5432};Database=$TDB_NAME;Username=${PGUSER:-postgres};Password=${PGPASSWORD:-}" \
TDB_CONN="$TDB_CONN" dotnet run --project "$HERE/tests/migration-drive"
rc=$?
printf "  database: %s\n" "$TDB_NAME"
exit $rc
