#!/usr/bin/env bash
#
# The Google migration's Dovecot MASTER login: on, off, status.
# Decision 0019 §2 (proposed). Run where the mail stack runs.
#
#   infra/scripts/migration-master.sh on      # a fresh password; master login works
#   infra/scripts/migration-master.sh off     # emptied; master login refused
#   infra/scripts/migration-master.sh status  # on or off, and the allowed networks
#
# WHAT "ON" DOES, inside the Dovecot container, writing straight into the
# files that use the password (house rule 5 - it is never printed, never in a
# variable on this host, never in .env):
#   /etc/dovecot/migration/master.password  the password, for the API
#                                            (uid 5000, mode 0400)
#   /etc/dovecot/migration/master.passwd    the master passdb entry Dovecot
#                                            reads: user "migration", the hash,
#                                            and allow_nets
# The volume is mounted into the API read-only at /run/migration.
#
# ALLOWED NETWORKS. MIGRATION_MASTER_NETS, default the private ranges. On a
# server, set it to the API container's network ONLY, e.g. the compose
# network's subnet:
#   docker network inspect tatvaos_mailnet -f '{{(index .IPAM.Config 0).Subnet}}'
# and after turning it on, PROVE it from outside the server:
#   a1 LOGIN someone@yourdomain*migration <anything>   ->  must be NO
# Docker's userland proxy can present an outside connection as coming from the
# bridge's gateway address; if that address is inside the allowed range, the
# allow-list is not doing its job and only the password is. Measure it.
#
# Turn it OFF when no migration is running. Off = the file is empty, which
# Dovecot reads as "no master user"; the file itself always stays (see the
# master passdb note in local/dovecot/dovecot.conf for why).
#
# DOVECOT_CONTAINER: the container's name (default tv-dovecot, the local stack).
set -euo pipefail
CONTAINER="${DOVECOT_CONTAINER:-tv-dovecot}"
NETS="${MIGRATION_MASTER_NETS:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8}"
DIR=/etc/dovecot/migration

case "${1:-status}" in
on)
    case "$NETS" in *[!0-9./,:a-fA-F]*|"") echo "MIGRATION_MASTER_NETS is not a list of networks: $NETS" >&2; exit 2;; esac
    docker exec -e NETS="$NETS" "$CONTAINER" sh -c '
        set -eu
        umask 077
        DIR=/etc/dovecot/migration
        head -c 33 /dev/urandom | base64 | tr -d "=+/\n" > "$DIR/master.password.new"
        hash=$(doveadm pw -s SHA512-CRYPT -p "$(cat "$DIR/master.password.new")")
        printf "migration:%s::::::allow_nets=%s\n" "$hash" "$NETS" > "$DIR/master.passwd.new"
        chown 5000:5000 "$DIR/master.password.new"; chmod 0400 "$DIR/master.password.new"
        chown root:dovecot "$DIR/master.passwd.new"; chmod 0640 "$DIR/master.passwd.new"
        mv "$DIR/master.password.new" "$DIR/master.password"
        mv "$DIR/master.passwd.new" "$DIR/master.passwd"
        doveadm auth cache flush >/dev/null 2>&1 || true
    '
    echo "migration master login: ON (allowed from $NETS) - turn it off when the migration is done"
    ;;
off)
    docker exec "$CONTAINER" sh -c '
        set -eu
        DIR=/etc/dovecot/migration
        : > "$DIR/master.passwd"
        rm -f "$DIR/master.password"
        doveadm auth cache flush >/dev/null 2>&1 || true
    '
    echo "migration master login: off"
    ;;
status)
    docker exec "$CONTAINER" sh -c '
        f=/etc/dovecot/migration/master.passwd
        if [ -s "$f" ]; then echo "migration master login: ON (allowed from $(sed -n "s/.*allow_nets=//p" "$f"))"
        else echo "migration master login: off"; fi'
    ;;
*) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
