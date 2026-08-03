#!/bin/bash
#
# Postfix container entrypoint.
#
# main.cf and master.cf are bind-mounted read-only from the host, so anything
# that would rewrite them is expected to fail and is tolerated.

set -uo pipefail

echo "[postfix] preparing"

# Postfix insists on an aliases database even when purely virtual
: > /etc/aliases
newaliases 2>/dev/null || true

# Fix spool permissions (does not touch the read-only config files)
postfix set-permissions 2>/dev/null || true

# Wait for Postgres - depends_on only guarantees the container started,
# and Postfix will happily start and then reject everything if lookups fail.
echo "[postfix] waiting for postgres"
for i in $(seq 1 30); do
    if (echo > /dev/tcp/postgres/5432) 2>/dev/null; then
        echo "[postfix] postgres reachable"
        break
    fi
    [ "$i" -eq 30 ] && echo "[postfix] WARNING: postgres never became reachable"
    sleep 2
done

# Validate config; print problems but keep going so logs are inspectable
postfix check || echo "[postfix] WARNING: postfix check reported issues"

echo "[postfix] starting in foreground"
echo "[postfix]   inbound     -> host port 2525"
echo "[postfix]   submission  -> host port 5870"
echo "[postfix]   all outbound relays to mailpit (nothing leaves this machine)"

exec postfix start-fg
