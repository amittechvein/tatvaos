#!/bin/bash
# TatvaOS Bugs — restore drill. Downloads the NEWEST set from the bucket (not
# the local copy), proves a wrong passphrase is refused, restores with the real
# one into a scratch folder, and compares every table's row count with live.
# Touches nothing live: the restored database is opened read-only in /tmp.
# Counts can differ if people used the tracker between the backup and the
# drill, so run it straight after backup-bugs.sh.
set -uo pipefail
export PATH="$HOME/bin:$PATH"
set -a; . /srv/backups/tatvaos/.backup-env; set +a
T=$(mktemp -d); trap 'rm -rf "$T"; docker exec tatvaos-bugs rm -f /tmp/drill.db' EXIT
OBJ=$(rclone lsf --files-only "${BACKUP_S3_REMOTE}/bugs" | grep '^bugs-.*\.tar\.gz\.enc$' | sort | tail -1)
[ -n "$OBJ" ] || { echo "[FAIL] no set in the bucket"; exit 1; }
echo "newest bucket object: bugs/$OBJ"
rclone copyto "${BACKUP_S3_REMOTE}/bugs/$OBJ" "$T/set.enc" || { echo "[FAIL] download"; exit 1; }
echo "downloaded $(stat -c %s "$T/set.enc") bytes"

echo "-- control: wrong passphrase"
mkdir "$T/w"
if WRONG=not-the-passphrase openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:WRONG -in "$T/set.enc" 2>/dev/null \
     | tar -xz -C "$T/w" 2>/dev/null && [ -s "$T/w/snap.db" ]; then
  echo "[FAIL] CONTROL BROKEN: a wrong passphrase produced a database"; exit 1
fi
echo "wrong passphrase refused (good)"

echo "-- restore with the real passphrase"
mkdir "$T/r"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE -in "$T/set.enc" | tar -xz -C "$T/r"
echo "decrypt | untar exit codes: ${PIPESTATUS[*]}"
echo "restored: $(ls "$T/r" | tr '\n' ' ')| attachment files: $(find "$T/r/files" -type f | wc -l)"
docker cp "$T/r/snap.db" tatvaos-bugs:/tmp/drill.db >/dev/null
docker exec tatvaos-bugs node -e '
const { DatabaseSync } = require("node:sqlite");
const r = new DatabaseSync("/tmp/drill.db", { readOnly: true });
const l = new DatabaseSync("/data/bugs.db", { readOnly: true });
console.log("integrity:", Object.values(r.prepare("PRAGMA integrity_check").get())[0]);
let same = 0, all = 0;
for (const t of ["users","modules","submodules","issues","activity","attachments","settings"]) {
  const a = r.prepare("SELECT COUNT(*) n FROM " + t).get().n, b = l.prepare("SELECT COUNT(*) n FROM " + t).get().n;
  all++; if (a === b) same++;
  console.log("  " + t.padEnd(12), "restored", String(a).padStart(3), " live", String(b).padStart(3), a === b ? " same" : " DIFFERENT");
}
const sig = (d) => JSON.stringify(d.prepare("SELECT id, status, title, assignee_id FROM issues ORDER BY id").all());
console.log("issue rows identical to live:", sig(r) === sig(l));
console.log("tables matching:", same + "/" + all);'
