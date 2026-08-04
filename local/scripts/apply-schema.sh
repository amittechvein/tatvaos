#!/usr/bin/env bash
#
# Apply schema changes to a RUNNING stack without wiping data.
#
#   ./scripts/apply-schema.sh
#
# Files in postgres/init/ only execute on an empty volume, so an existing
# database never sees them. This applies them by hand, in order. Every script
# there is written to be idempotent, so re-running is safe.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); C=$(c $'\033[36m'); D=$(c $'\033[90m'); X=$(c $'\033[0m')

docker ps --format '{{.Names}}' | grep -qx tv-postgres || {
    printf '%sPostgres is not running. docker compose up -d%s\n' "$R" "$X"; exit 1; }

fail=0
for f in postgres/init/*.sql; do
    printf '\n%s>> %s%s\n' "$C" "$f" "$X"
    if docker exec -i tv-postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 < "$f" 2>&1 \
        | sed 's/^/   /'; then
        printf '   %sapplied%s\n' "$G" "$X"
    else
        printf '   %sFAILED%s\n' "$R" "$X"; fail=1
    fi
done

printf '\n%s%s%s\n' "$C" "----------------------------------------" "$X"
if [ "$fail" -eq 0 ]; then
    printf '  %sSchema up to date.%s\n' "$G" "$X"
    printf '  %sCheck the API:  curl http://localhost:5000/health/db%s\n\n' "$D" "$X"
else
    printf '  %sOne or more scripts failed — see above.%s\n\n' "$R" "$X"
    exit 1
fi
