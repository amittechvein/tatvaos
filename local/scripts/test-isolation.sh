#!/usr/bin/env bash
#
# Runs the tenant isolation test against the local Docker stack.
#
# The assertions live in tests/isolation/test-isolation.sh and are NOT
# duplicated here. This file only says how to reach Postgres.
#
# That separation is deliberate. This script and the CI job used to be two
# copies of the same assertions; they drifted, and a bug already fixed in one
# reappeared in the other. If you find yourself about to add a check here,
# add it to the canonical script instead - CI runs the same file.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$HERE/../../tests/isolation/test-isolation.sh"

[ -f "$CANONICAL" ] || {
    printf 'Cannot find %s\n' "$CANONICAL" >&2
    exit 1
}

export TATVAOS_PSQL_MODE=docker
export TATVAOS_PG_CONTAINER="${TATVAOS_PG_CONTAINER:-tv-postgres}"
export PGDATABASE="${PGDATABASE:-tatvaos_mail}"

exec bash "$CANONICAL" "$@"
