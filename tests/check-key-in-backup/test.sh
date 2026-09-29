#!/usr/bin/env bash
# infra/scripts/check-key-in-backup.sh, locally: a fake .env, a fake local
# set, and a fake off-box object encrypted exactly as backup.sh encrypts.
#   bash tests/check-key-in-backup/test.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
T=".tmp/ckb-$$"; rm -rf "$T"; mkdir -p "$T/backups/20260928-0900" "$T/bucket"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  ✗ %s\n' "$1"; }
has()  { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$2]"; fi; }
KEYV="k$(date +%s)$$0123456789abcdef0123456789abcdef"
printf 'OTHER=1\nPERSONAL_PHONE_HASH_KEY=%s\n' "$KEYV" > "$T/.env"
printf "BACKUP_S3_REMOTE='fake:bucket'\nBACKUP_ENC_PASSPHRASE='test-passphrase'\n" > "$T/backups/.backup-env"
make_object() { # stamp env-contents
    mkdir -p "$T/stage/$1"; printf '%s' "$2" > "$T/stage/$1/env.txt"
    tar -czf - -C "$T/stage" "$1" | BACKUP_ENC_PASSPHRASE=test-passphrase \
        openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENC_PASSPHRASE > "$T/bucket/$1.tar.gz.enc"
}
export CK_ENV_FILE="$T/.env" CK_BACKUP_DIR="$T/backups"
export CK_REMOTE_LIST="ls -1 $T/bucket" CK_REMOTE_CAT="cat_in_bucket"
cat_in_bucket() { cat "$T/bucket/$1"; }; export -f cat_in_bucket; export T
run() { bash infra/scripts/check-key-in-backup.sh PERSONAL_PHONE_HASH_KEY 2>&1; }

cp "$T/.env" "$T/backups/20260928-0900/env.txt"
make_object 20260928-0900 "$(cat "$T/.env")"
out=$(run); rc=$?
has "both copies carry the key: SAME, SAME" "$out" "SAME     local  20260928-0900/env.txt"
has "…off-box too" "$out" "SAME     off-box 20260928-0900.tar.gz.enc"
[ $rc = 0 ] && pass "…exit 0" || fail "exit $rc"
if printf '%s' "$out" | grep -qF -- "$KEYV"; then fail "THE KEY WAS PRINTED"; else pass "the key's value is never printed"; fi

# RED: the backups predate the key (the case Mr. Singh named).
mkdir -p "$T/backups/20260928-1100"; printf 'OTHER=1\n' > "$T/backups/20260928-1100/env.txt"
make_object 20260928-1100 "OTHER=1"
out=$(run); rc=$?
has "a set made before the key: MISSING, local" "$out" "MISSING  local  20260928-1100/env.txt has no PERSONAL_PHONE_HASH_KEY"
has "…and off-box" "$out" "MISSING  off-box 20260928-1100.tar.gz.enc"
[ $rc != 0 ] && pass "…exit non-zero" || fail "exit 0 with the key missing"

# RED: a different key in the backup (a regenerated key).
mkdir -p "$T/backups/20260928-1300"; printf 'PERSONAL_PHONE_HASH_KEY=someotherkey0123456789abcdef0123456789\n' > "$T/backups/20260928-1300/env.txt"
make_object 20260928-1300 "PERSONAL_PHONE_HASH_KEY=someotherkey0123456789abcdef0123456789"
out=$(run); rc=$?
has "another value: DIFFERENT" "$out" "DIFFERENT local"
has "…off-box too" "$out" "DIFFERENT off-box"
[ $rc != 0 ] && pass "…exit non-zero" || fail "exit 0 on a different key"

# A wrong passphrase: the object will not open — never SAME.
cp "$T/.env" "$T/backups/20260928-1300/env.txt"
sed -i "s/test-passphrase/wrong/" "$T/backups/.backup-env"
make_object 20260928-1500 "$(cat "$T/.env")"; mkdir -p "$T/backups/20260928-1500"; cp "$T/.env" "$T/backups/20260928-1500/env.txt"
out=$(run); rc=$?
has "wrong passphrase: the off-box copy is MISSING, not SAME" "$out" "MISSING  off-box 20260928-1500.tar.gz.enc"

out=$(bash infra/scripts/check-key-in-backup.sh 'bad name' 2>&1); has "a bad key name: usage" "$out" "usage:"
rm -rf "$T"
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"; [ "$FAILED" = 0 ]
