#!/usr/bin/env bash
#
# TatvaOS — the nightly backup
#
#   ./infra/scripts/backup.sh            # run it now
#   ./infra/scripts/backup.sh --install  # install the 02:30 cron entry
#
# Run ON the production server, from the repo checkout.
#
# ─────────────────────────────────────────────────────────────────────────
#  WHY THIS EXISTS SEPARATELY FROM deploy.sh
#
#  deploy.sh takes a pre-deploy Postgres dump, and until Space shipped that
#  was genuinely everything: mail lives in the maildir, but the maildir was
#  reproducible from nothing that mattered more than the database.
#
#  It is no longer everything. Space stores FILE BYTES on a docker volume,
#  behind opaque blob keys whose only index is the database. A lost volume is
#  not "restore from yesterday" — it is every document every customer has
#  uploaded, gone, with a database full of rows pointing at nothing. And the
#  maildir is the actual mail.
#
#  It is deliberately NOT part of deploy.sh: copying tens of gigabytes of
#  blobs on every deploy makes deploying slow enough that people stop doing
#  it, and a backup that only runs when someone deploys is not a backup.
#
#  THIS IS STILL A ONE-MACHINE BACKUP. It protects against deleting a volume,
#  a bad migration, a corrupted file. It does NOT protect against losing the
#  server. Getting BACKUP_REMOTE set below is the difference between a backup
#  and a comforting ritual.
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); B=$(c $'\033[1m'); X=$(c $'\033[0m')
step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; }
warn() { printf '   %s[warn]%s %s\n' "$Y" "$X" "$1"; }
note() { printf '   %s%s%s\n' "$D" "$1" "$X"; }

DEST="${BACKUP_DIR:-/srv/backups/tatvaos}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# rsync/scp target for off-box copies, e.g. user@host:/backups/tatvaos.
# Empty means local only — which is a single point of failure, loudly.
REMOTE="${BACKUP_REMOTE:-}"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${DEST}/${STAMP}"

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--install" ]; then
    LINE="30 2 * * * cd $(pwd) && ./infra/scripts/backup.sh >> /var/log/tatvaos-backup.log 2>&1"
    # Idempotent: re-running --install must not stack duplicate entries.
    if crontab -l 2>/dev/null | grep -Fq 'infra/scripts/backup.sh'; then
        ok "cron entry already installed"
    else
        (crontab -l 2>/dev/null; echo "$LINE") | crontab -
        ok "installed: nightly at 02:30, logging to /var/log/tatvaos-backup.log"
    fi
    crontab -l | grep -F 'backup.sh' | sed 's/^/   /'
    exit 0
fi

mkdir -p "$OUT" || { bad "cannot write $OUT"; exit 1; }

failed=0

# ---------------------------------------------------------------------------
step "Database"
if docker ps --format '{{.Names}}' | grep -q postgres; then
    PG=$(docker ps --format '{{.Names}}' | grep postgres | head -1)
    # Compressed on the way out — a plain dump of a mail database is mostly
    # text and gzip takes roughly 90% of it away.
    if docker exec -t "$PG" pg_dumpall -U postgres 2>/dev/null | gzip > "${OUT}/postgres.sql.gz"; then
        ok "postgres.sql.gz ($(du -h "${OUT}/postgres.sql.gz" | cut -f1))"
    else
        bad "pg_dumpall failed"; failed=1
    fi
else
    bad "no postgres container running"; failed=1
fi

# ---------------------------------------------------------------------------
# Volumes, read through a throwaway alpine container: the volumes are owned by
# container users (5000 for blobs and vmail), so tarring them from the host as
# root works but reading them as the deploy user does not.
#
# Each volume is its own tarball. One combined archive means a single corrupt
# byte costs everything, and it makes "restore just the blobs" impossible.
# ---------------------------------------------------------------------------
backup_volume() {
    local vol="$1" name="$2"
    if ! docker volume inspect "$vol" >/dev/null 2>&1; then
        warn "$name: volume $vol does not exist — skipped"
        return
    fi
    if docker run --rm -v "${vol}:/src:ro" -v "${OUT}:/out" alpine \
           tar czf "/out/${name}.tar.gz" -C /src . 2>/dev/null; then
        ok "${name}.tar.gz ($(du -h "${OUT}/${name}.tar.gz" | cut -f1))"
    else
        bad "$name failed"; failed=1
    fi
}

step "Space file bytes"
# The database knows blob keys; only this volume has the bytes behind them.
backup_volume tatvaos_spaceblobs spaceblobs

step "Mail store"
backup_volume tatvaos_vmail vmail

step "DKIM keys"
# Small, and losing them means re-publishing DNS for every customer domain.
backup_volume tatvaos_dkimkeys dkimkeys

# ---------------------------------------------------------------------------
step "Environment"
# The one file that is deliberately never committed, and without which none of
# the above can be brought back up.
if cp infra/docker/.env "${OUT}/env.txt" 2>/dev/null; then
    chmod 600 "${OUT}/env.txt"
    ok "env.txt (secrets — 0600)"
else
    warn "infra/docker/.env not readable — skipped"
fi

# ---------------------------------------------------------------------------
step "Off-box copy"
if [ -n "$REMOTE" ]; then
    if rsync -a --delete-after "${OUT}/" "${REMOTE}/${STAMP}/" 2>&1 | sed 's/^/   /'; then
        ok "copied to ${REMOTE}/${STAMP}"
    else
        bad "off-box copy FAILED — this backup exists only on this machine"; failed=1
    fi
else
    warn "BACKUP_REMOTE is not set — this backup exists only on this machine."
    note "A backup on the machine it is protecting does not survive losing it."
    note "Set BACKUP_REMOTE=user@host:/path (ssh key, no passphrase) to fix."
fi

# ---------------------------------------------------------------------------
step "Retention"
# Only ever prunes inside DEST, and only whole timestamped directories.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS}" \
     -exec rm -rf {} + 2>/dev/null
ok "keeping $KEEP_DAYS days — $(find "$DEST" -mindepth 1 -maxdepth 1 -type d | wc -l) set(s) on disk"

# ---------------------------------------------------------------------------
step "Verdict"
printf '   total %s in %s\n' "$(du -sh "$OUT" | cut -f1)" "$OUT"
if [ "$failed" -eq 0 ]; then
    ok "backup complete"
else
    bad "backup finished WITH FAILURES — read the log above"
    exit 1
fi
