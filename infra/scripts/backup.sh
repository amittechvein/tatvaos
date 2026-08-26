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

# rclone lives in ~/bin — installed WITHOUT sudo, because the deploy user has
# none. Cron runs with a bare PATH, so the script says where to look rather
# than hoping the environment does.
export PATH="$HOME/bin:$PATH"

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
    # The log lives beside the backups, NOT in /var/log: that directory is
    # root-owned, the deploy user cannot create a file there, and cron would
    # have failed on the redirect before the script ever ran — silently,
    # every night, which is the worst way for a backup to be broken.
    mkdir -p "$DEST"
    LINE="30 2 * * * cd $(pwd) && ./infra/scripts/backup.sh >> ${DEST}/backup.log 2>&1"
    # Idempotent: re-running --install must not stack duplicate entries.
    if crontab -l 2>/dev/null | grep -Fq 'infra/scripts/backup.sh'; then
        ok "cron entry already installed"
    else
        (crontab -l 2>/dev/null; echo "$LINE") | crontab -
        ok "installed: nightly at 02:30, logging to ${DEST}/backup.log"
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
step "Meeting recordings"
#
#  Connect's recordings live in tatvaos_connectrec and were in no backup at
#  all until this was written — a new volume arrived with a new product and
#  nothing swept it up.
#
#  They are NOT backed up by default, and that is a judgement rather than an
#  oversight: nothing expires a recording yet, so this volume grows without
#  limit, and a nightly tar of unbounded video would eventually take longer
#  than a night and fill the disk it is protecting against. Retention is
#  decided (7/30/90/180/365, default 90 - docs/CONNECT_DECISIONS.md) but not
#  built. Turn this on once it is.
#
#  What it does unconditionally is REPORT THE SIZE, every night, so the gap
#  is visible rather than silently absent. A backup that quietly covers less
#  than you think is the failure mode this whole script exists to avoid.
# ---------------------------------------------------------------------------
rec_size=$(docker run --rm -v tatvaos_connectrec:/v alpine du -sh /v 2>/dev/null | cut -f1)
if [ "${BACKUP_RECORDINGS:-}" = "1" ]; then
    backup_volume tatvaos_connectrec connectrec
else
    note "recordings NOT backed up (${rec_size:-unknown} in tatvaos_connectrec)."
    note "Set BACKUP_RECORDINGS=1 once retention is enforced."
fi

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
step "Off-box copy — object storage"
#
#  THE WARNING BELOW FIRED EVERY NIGHT AND NOBODY HEARD IT. "This backup
#  exists only on this machine" was printed into a log that lives on the same
#  machine — the failure it warns about would have destroyed the warning too.
#  As of 24 Aug 2026 (Amit's ruling) the nightly set also goes to an
#  S3-compatible bucket in Mumbai.
#
#  ENCRYPTED BEFORE IT LEAVES, ALWAYS. env.txt inside this set is every secret
#  the platform has; a bucket is one leaked credential away from public, and
#  an unencrypted backup in it would be the single worst object to leak.
#  openssl AES-256 with a passphrase that lives in TWO places: the config file
#  below (so cron can encrypt), and ON PAPER with Amit (so losing this machine
#  does not mean holding backups nobody can open). The passphrase is typed in,
#  never generated-and-printed — every secret that has ever appeared on a
#  screen in this project has ended up in a chat transcript.
#
#  Credentials live in ${DEST}/.backup-env (0600), DELIBERATELY NOT in
#  infra/docker/.env: the app's env file is itself inside every backup, and
#  bucket credentials stored inside the thing the bucket holds is a loop that
#  hands both to whoever gets either.
#
#  Expected in ${DEST}/.backup-env:
#      BACKUP_S3_REMOTE='linode:tatvaos-backups'   # rclone remote:bucket
#      BACKUP_ENC_PASSPHRASE='...'                 # also on paper, offline
#      BACKUP_S3_KEEP_DAYS=30                      # optional
# ---------------------------------------------------------------------------
S3_CONF="${DEST}/.backup-env"
if [ -f "$S3_CONF" ]; then
    # set -a EXPORTS everything the file sets. Without it the passphrase was
    # a plain shell variable, invisible to openssl (a child process), which
    # died on "env:" lookup and broke the whole tar|encrypt|upload pipe with
    # a SIGPIPE that pointed at tar — the first upload failed exactly so.
    set -a
    # shellcheck disable=SC1090
    . "$S3_CONF"
    set +a
fi

if [ -n "${BACKUP_S3_REMOTE:-}" ] && [ -n "${BACKUP_ENC_PASSPHRASE:-}" ]; then
    if ! command -v rclone >/dev/null 2>&1; then
        bad "rclone is not installed — the off-box copy did NOT happen"
        failed=1
    else
        OBJECT="${BACKUP_S3_REMOTE}/${STAMP}.tar.gz.enc"
        # Streamed: tar -> encrypt -> upload, nothing large touches /tmp.
        # -pbkdf2 -iter 200000 because openssl's default key derivation is
        # weak enough to be a finding on its own.
        if tar czf - -C "$DEST" "$STAMP" \
             | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
                 -pass env:BACKUP_ENC_PASSPHRASE 2>/dev/null \
             | rclone rcat "$OBJECT" 2>&1 | sed 's/^/   /'; then

            # PROVE the object exists and is a plausible size. rcat returning
            # zero after writing zero bytes is exactly the false-pass shape
            # this project keeps finding; the listing is the receipt.
            SIZE=$(rclone size --json "$OBJECT" 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2)
            if [ -n "$SIZE" ] && [ "$SIZE" -gt 1024 ]; then
                ok "uploaded ${STAMP}.tar.gz.enc ($((SIZE / 1024 / 1024)) MB) — encrypted, off this machine"
            else
                bad "upload reported success but the object is missing or empty"
                failed=1
            fi

            # Bucket retention, independent of local retention.
            rclone delete --min-age "${BACKUP_S3_KEEP_DAYS:-30}d" "$BACKUP_S3_REMOTE" 2>/dev/null
            note "bucket keeps ${BACKUP_S3_KEEP_DAYS:-30} days"
        else
            bad "encrypt/upload FAILED — this backup exists only on this machine"
            failed=1
        fi
    fi
else
    warn "object-storage copy not configured (${S3_CONF} missing or incomplete)"
    note "This backup exists only on this machine and will not survive losing it."
fi

# ---------------------------------------------------------------------------
step "Off-box copy — rsync (legacy hook)"
if [ -n "$REMOTE" ]; then
    if rsync -a --delete-after "${OUT}/" "${REMOTE}/${STAMP}/" 2>&1 | sed 's/^/   /'; then
        ok "copied to ${REMOTE}/${STAMP}"
    else
        bad "off-box copy FAILED — this backup exists only on this machine"; failed=1
    fi
else
    note "BACKUP_REMOTE not set — fine, the object-storage copy above is the off-box path."
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
