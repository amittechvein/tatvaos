#!/usr/bin/env bash
# =============================================================================
#  check-key-in-backup.sh — is this key in the backups, exactly as in .env?
# =============================================================================
#
#  For the keys that must never change (docs/runbooks/backup-and-restore.md,
#  "Keys that must never change"). A key that exists only in the server's
#  .env until the next scheduled backup is a key a disk failure can lose
#  (Mr. Singh on PR 311, 28 Sept 2026). So after generating one: run a backup
#  at once, then this, and see SAME twice.
#
#  It compares the key's line in infra/docker/.env with the same line in
#    1. the newest LOCAL set's env.txt   (/srv/backups/tatvaos/<stamp>/env.txt)
#    2. the newest OFF-BOX object         (decrypted as a stream, never to disk)
#  and prints SAME, DIFFERENT or MISSING for each. It NEVER prints the value —
#  not the key, not a hash of it. Exit 0 only if both are SAME.
#
#  USAGE — on the server, from the repo root:
#      bash infra/scripts/check-key-in-backup.sh PERSONAL_PHONE_HASH_KEY
#
#  Test: tests/check-key-in-backup (local, with a fake set and object;
#  CK_* variables stand in for the server paths and for rclone).
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/bin:$PATH"

KEY="${1:-}"
case "$KEY" in
    ''|*[!A-Z0-9_]*) echo "usage: $0 KEY_NAME   (capitals, digits, underscores)"; exit 2 ;;
esac

ENV_FILE="${CK_ENV_FILE:-infra/docker/.env}"
DEST="${CK_BACKUP_DIR:-${BACKUP_DIR:-/srv/backups/tatvaos}}"
fail=0

# The line from a stream, or nothing. Values stay in variables; never echoed.
line_of() { grep -m1 -- "^${KEY}=" 2>/dev/null; }

want=$(line_of < "$ENV_FILE")
if [ -z "$want" ] || [ "$want" = "${KEY}=" ]; then
    echo "MISSING  ${KEY} is not set in ${ENV_FILE}. Nothing to compare."; exit 1
fi

# ---- 1. the newest local set ------------------------------------------------
newest=$(ls -1d "$DEST"/*/ 2>/dev/null | sort | while read -r d; do [ -f "${d}env.txt" ] && echo "$d"; done | tail -1)
if [ -z "$newest" ]; then
    echo "MISSING  no local backup set with an env.txt under ${DEST}"; fail=1
else
    got=$(line_of < "${newest}env.txt")
    if [ -z "$got" ]; then echo "MISSING  local  $(basename "$newest")/env.txt has no ${KEY}"; fail=1
    elif [ "$got" = "$want" ]; then echo "SAME     local  $(basename "$newest")/env.txt"
    else echo "DIFFERENT local  $(basename "$newest")/env.txt holds another value for ${KEY}"; fail=1; fi
fi

# ---- 2. the newest off-box object -------------------------------------------
CONF="${CK_BACKUP_CONF:-${DEST}/.backup-env}"
if [ ! -f "$CONF" ]; then echo "MISSING  no ${CONF}: cannot reach the off-box copy"; exit 1; fi
set -a
# shellcheck disable=SC1090
. "$CONF"
set +a
list() { if [ -n "${CK_REMOTE_LIST:-}" ]; then $CK_REMOTE_LIST; else rclone lsf --files-only "$BACKUP_S3_REMOTE"; fi; }
cat_obj() { if [ -n "${CK_REMOTE_CAT:-}" ]; then $CK_REMOTE_CAT "$1"; else rclone cat "${BACKUP_S3_REMOTE}/$1"; fi; }
latest=$(list 2>/dev/null | grep -- '\.tar\.gz\.enc$' | sort | tail -1)
if [ -z "$latest" ]; then
    echo "MISSING  no off-box object in the bucket"; fail=1
else
    got=$(cat_obj "$latest" 2>/dev/null \
          | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE 2>/dev/null \
          | tar -xzOf - --wildcards '*env.txt' 2>/dev/null | line_of)
    if [ -z "$got" ]; then echo "MISSING  off-box ${latest}: no ${KEY} (or the object would not open)"; fail=1
    elif [ "$got" = "$want" ]; then echo "SAME     off-box ${latest}"
    else echo "DIFFERENT off-box ${latest} holds another value for ${KEY}"; fail=1; fi
    # The newest object should be the set just made. Say which, so a person
    # can see the off-box copy is the new one and not yesterday's.
    [ -n "$newest" ] && [ "${latest%.tar.gz.enc}" != "$(basename "$newest")" ] \
        && echo "NOTE     the newest off-box object (${latest}) is not the newest local set ($(basename "$newest")): is the upload still running?"
fi

exit $fail
