#!/usr/bin/env bash
#
# Apply the tester seed to a running stack, without wiping the database.
#
#   ./scripts/seed-testers.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

docker ps --format '{{.Names}}' | grep -qx tv-postgres || {
    echo "Postgres is not running. Start the stack first: docker compose up -d"
    exit 1
}

echo "Applying tester seed..."
docker exec -i tv-postgres psql -U postgres -d tatvaos_mail < postgres/seed-testers.sql

echo
echo "Done. Start the tester webmail:"
echo "  docker compose --profile testers up -d"
echo "  open http://localhost:8000"
