#!/bin/bash
# ============================================================================
#  TatvaOS Bugs — backup (bug.tatvaos.com)
#
#  Every 6 hours from the deploy user's crontab:
#      15 */6 * * * bash ~/tatvaos-bugs/deploy/backup-bugs.sh >> ~/tatvaos-bugs/backup.log 2>&1
#
#  What a set is: one encrypted tar of a CONSISTENT database snapshot
#  (SQLite `VACUUM INTO`, safe while the app is writing) plus every attachment.
#
#  It reuses the PRODUCT's backup credentials — the same passphrase and the
#  same bucket (${BACKUP_S3_REMOTE}/bugs/), read from the product's
#  .backup-env — and the same cipher as infra/scripts/backup.sh, so one
#  passphrase on paper restores both. It never prints them, and it does not
#  touch backup.sh or the product's objects (they live in the bucket root;
#  these live under bugs/).
#
#  A set only counts once it has been READ BACK: decrypted and listed, with the
#  snapshot inside it passing SQLite's integrity check. A failed run exits 1
#  and says what did not happen.
#
#  Restore (on the server):
#      set -a; . /srv/backups/tatvaos/.backup-env; set +a
#      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE \
#          -in bugs-<stamp>.tar.gz.enc | tar -xz -C <empty dir>
#      # -> snap.db (rename to bugs.db) and files/ ; copy both into the
#      #    tatvaos-bugs_bugsdata volume with the container stopped.
# ============================================================================
set -uo pipefail
export PATH="$HOME/bin:$PATH"

ENV_FILE=/srv/backups/tatvaos/.backup-env
LOCAL_DIR="${BUGS_BACKUP_DIR:-$HOME/backups/tatvaos-bugs}"
KEEP_DAYS="${BUGS_BACKUP_KEEP_DAYS:-7}"
CONTAINER=tatvaos-bugs
STAMP=$(date -u +%Y%m%d-%H%M%S)
NAME="bugs-${STAMP}.tar.gz.enc"

ok()   { printf '[ ok ] %s\n' "$*"; }
bad()  { printf '[FAIL] %s\n' "$*"; FAILED=1; }
FAILED=0
echo "== TatvaOS Bugs backup ${STAMP}Z"

# ---- credentials (loaded, never echoed) -------------------------------------
if [ ! -r "$ENV_FILE" ]; then echo "[FAIL] cannot read $ENV_FILE — nothing backed up"; exit 1; fi
set -a; . "$ENV_FILE"; set +a
if [ -z "${BACKUP_ENC_PASSPHRASE:-}" ]; then echo "[FAIL] no BACKUP_ENC_PASSPHRASE — refusing to write an unencrypted copy"; exit 1; fi

umask 077
mkdir -p "$LOCAL_DIR" && chmod 700 "$LOCAL_DIR"
OUT="$LOCAL_DIR/$NAME"

# ---- 1. consistent snapshot inside the container ----------------------------
if ! docker exec "$CONTAINER" node -e '
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  fs.rmSync("/data/snap.db", { force: true });
  const db = new DatabaseSync("/data/bugs.db");
  db.exec("VACUUM INTO \x27/data/snap.db\x27");
  db.close();' ; then
  echo "[FAIL] snapshot failed — nothing backed up"; exit 1
fi

# ---- 2. tar -> encrypt -> local file -----------------------------------------
docker exec "$CONTAINER" tar -C /data -czf - snap.db files \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENC_PASSPHRASE -out "$OUT"
rc=("${PIPESTATUS[@]}")
docker exec "$CONTAINER" rm -f /data/snap.db
if [ "${rc[0]}" != 0 ] || [ "${rc[1]}" != 0 ] || [ ! -s "$OUT" ]; then
  rm -f "$OUT"; echo "[FAIL] tar (${rc[0]}) or encrypt (${rc[1]}) failed — nothing backed up"; exit 1
fi
chmod 600 "$OUT"

# ---- 3. read it back: decrypt, list, integrity-check the snapshot -----------
CHECK=$(mktemp -d); trap 'rm -rf "$CHECK"' EXIT
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE -in "$OUT" 2>/dev/null \
     | tar -xz -C "$CHECK" 2>/dev/null && [ -s "$CHECK/snap.db" ]; then
  # integrity + counts, using the container's node on a copy of the snapshot
  docker cp "$CHECK/snap.db" "$CONTAINER:/tmp/verify.db" >/dev/null
  VERDICT=$(docker exec "$CONTAINER" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync("/tmp/verify.db", { readOnly: true });
    const ic = d.prepare("PRAGMA integrity_check").get();
    const n = (t) => d.prepare("SELECT COUNT(*) n FROM " + t).get().n;
    console.log(Object.values(ic)[0], "users=" + n("users"), "issues=" + n("issues"), "history=" + n("activity"), "files=" + n("attachments"));' 2>&1)
  docker exec "$CONTAINER" rm -f /tmp/verify.db
  NFILES=$(find "$CHECK/files" -type f 2>/dev/null | wc -l)
  # Every attachment row must have its file in the set, or screenshots would
  # restore as rows pointing at nothing (the failure backup.sh's header warns of).
  NROWS=$(printf '%s' "$VERDICT" | grep -o 'files=[0-9]*' | cut -d= -f2)
  case "$VERDICT" in
    ok\ *) if [ "$NFILES" = "${NROWS:-x}" ]; then ok "read back: integrity ok, ${VERDICT#ok } | attachment files in set=${NFILES} (matches)"
           else bad "read back: database lists ${NROWS} attachments but the set holds ${NFILES} files"; fi ;;
    *)     bad "read back FAILED: $VERDICT" ;;
  esac
else
  bad "read back FAILED: could not decrypt/untar $NAME"
fi
[ "$FAILED" = 0 ] && ok "local copy $OUT ($(du -h "$OUT" | cut -f1)), mode 600"

# ---- 4. off the machine -------------------------------------------------------
if [ "$FAILED" = 0 ] && [ -n "${BACKUP_S3_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  REMOTE="${BACKUP_S3_REMOTE}/bugs/${NAME}"
  if rclone copyto "$OUT" "$REMOTE" 2>/dev/null; then
    LSIZE=$(stat -c %s "$OUT")
    RSIZE=$(rclone size --json "$REMOTE" 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2)
    if [ "$LSIZE" = "${RSIZE:-x}" ]; then ok "uploaded bugs/${NAME} (${RSIZE} bytes, same as local)"
    else bad "uploaded but the bucket copy is ${RSIZE:-missing} bytes, local is ${LSIZE}"; fi
  else
    bad "upload FAILED — this set exists only on this machine"
  fi
else
  [ "$FAILED" = 0 ] && bad "no off-box copy (BACKUP_S3_REMOTE unset or rclone missing)"
fi

# ---- 5. keep KEEP_DAYS, only after a good run, never the newest 3 ------------
if [ "$FAILED" = 0 ]; then
  mapfile -t old < <(ls -1t "$LOCAL_DIR"/bugs-*.tar.gz.enc 2>/dev/null | tail -n +4)
  pruned=0
  for f in "${old[@]}"; do
    if [ -n "$(find "$f" -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then rm -f "$f" && pruned=$((pruned+1)); fi
  done
  rclone delete --min-age "${KEEP_DAYS}d" "${BACKUP_S3_REMOTE}/bugs" 2>/dev/null
  ok "kept ${KEEP_DAYS} days (local pruned: ${pruned}; local sets now: $(ls -1 "$LOCAL_DIR"/bugs-*.tar.gz.enc | wc -l))"
fi

if [ "$FAILED" = 0 ]; then echo "== DONE ok"; exit 0; else echo "== DONE WITH FAILURES"; exit 1; fi
