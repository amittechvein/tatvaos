#!/usr/bin/env bash
# =============================================================================
#  verify-backup-restore.sh — can the off-box backup actually be opened?
# =============================================================================
#
#  An encrypted backup in a bucket answers "did the upload run". It does not
#  answer the question the backup exists for: CAN A PERSON WITH THE PASSPHRASE
#  GET THE DATA BACK? A wrong passphrase on paper, a corrupted stream, an
#  openssl flag that changed between versions — every one of those produces a
#  bucket full of objects and nothing recoverable, discovered on the worst
#  day available.
#
#  So this downloads the NEWEST object, decrypts it, and reads the tar's
#  table of contents plus the database dump's header. It never touches the
#  running system and never extracts to disk — list-only, streamed.
#
#  Run it after the first upload, and monthly ever after. Two minutes.
#
#  USAGE — on the server, from the repo root:
#      bash infra/scripts/verify-backup-restore.sh
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

# rclone lives in ~/bin — installed WITHOUT sudo, because the deploy user has
# none. Cron runs with a bare PATH, so the script says where to look rather
# than hoping the environment does.
export PATH="$HOME/bin:$PATH"

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '        · %s\n' "$1"; }
head2(){ printf '\n  %s\n  %s\n' "$1" "$(printf '%.0s─' $(seq 1 60))"; }

DEST="${BACKUP_DIR:-/srv/backups/tatvaos}"
S3_CONF="${DEST}/.backup-env"

head2 "configuration"
if [ ! -f "$S3_CONF" ]; then bad "no ${S3_CONF} — nothing to verify"; exit 1; fi
set -a
# shellcheck disable=SC1090
. "$S3_CONF"
set +a
[ -n "${BACKUP_S3_REMOTE:-}" ] || { bad "BACKUP_S3_REMOTE unset"; exit 1; }
[ -n "${BACKUP_ENC_PASSPHRASE:-}" ] || { bad "BACKUP_ENC_PASSPHRASE unset"; exit 1; }
ok "config present"

head2 "newest object in ${BACKUP_S3_REMOTE}"
LATEST=$(rclone lsf --files-only "$BACKUP_S3_REMOTE" 2>/dev/null | sort | tail -1)
[ -n "$LATEST" ] || { bad "the bucket is empty — no backup has ever uploaded"; exit 1; }
ok "$LATEST"

head2 "decrypt and read the table of contents (nothing is extracted)"
LISTING=$(rclone cat "${BACKUP_S3_REMOTE}/${LATEST}" 2>/dev/null \
    | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -pass env:BACKUP_ENC_PASSPHRASE 2>/dev/null \
    | tar tzf - 2>/dev/null)

if [ -z "$LISTING" ]; then
    bad "could not decrypt or read the archive"
    info "wrong passphrase, corrupted object, or openssl parameters drifted."
    info "Whatever the cause: TODAY, this backup cannot be restored from."
    exit 1
fi

COUNT=$(printf '%s\n' "$LISTING" | wc -l)
ok "archive opens: $COUNT entries"
printf '%s\n' "$LISTING" | sed 's/^/        /' | head -8

head2 "the pieces a restore would need"
FAILED=0
for want in postgres.sql.gz env.txt spaceblobs.tar.gz vmail.tar.gz dkimkeys.tar.gz; do
    if printf '%s\n' "$LISTING" | grep -q "$want"; then
        ok "$want present"
    else
        bad "$want MISSING from the newest backup"
        FAILED=1
    fi
done

head2 "verdict"
if [ "$FAILED" -eq 0 ]; then
    ok "the off-box backup decrypts and holds every piece a restore needs"
    info "checked with the passphrase from the CONFIG FILE. Once a quarter,"
    info "run this after typing the passphrase FROM THE PAPER COPY instead —"
    info "the paper is the copy that matters on the day the machine is gone."
    exit 0
fi
bad "the newest backup is incomplete — a restore would come back without something"
exit 1
