#!/usr/bin/env bash
#
# deploy.sh's "Backing up the database" step: compressed, checked whole,
# ENCRYPTED, locked down, kept by DAYS — run for real, with docker and
# Postgres stubbed out and the real openssl doing the encryption.
#
# WHY THIS EXISTS. Until 24 September 2026 the step wrote an uncompressed
# pg_dumpall before every deploy and never deleted one. On 25 Sept the
# server held 323 of them, 31 GB back to 4 Aug, unencrypted and readable by
# every account on the box. Mr. Singh's ruling (PR 254): the window is in
# DAYS and is backup.sh's BACKUP_KEEP_DAYS, the copies are encrypted at rest,
# the permissions are set by deploy.sh itself, and the old plain copies are
# NEVER deleted by a deploy. Each of those can fail silently, so each has a
# case here that must go red.
#
# It does NOT copy the step. It cuts the real block out of deploy.sh, from
# `step "Backing up the database"` to the next section rule, and runs it in
# a scratch directory. Change the step and this runs the change.
#
# Permission checks need a filesystem that keeps Unix modes (Linux, WSL's
# own disk). On one that does not (Git Bash on NTFS) they are reported as
# SKIPPED, loudly — never as passed.
#
# Usage: bash tests/deploy/predeploy-dump.sh      (no docker needed)
# Exit:  0 all passed, 1 otherwise.

set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
deploy="$root/infra/scripts/deploy.sh"
DEPLOY_SH="${DEPLOY_SH:-$deploy}"     # a mutated copy can be swapped in

pass=0; fail=0; skipped=0
ok_()   { pass=$((pass + 1)); printf '    ok  %s\n' "$1"; }
bad_()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }
skip_() { skipped=$((skipped + 1)); printf '  SKIP  %s\n' "$1"; }

command -v openssl >/dev/null || { echo "  openssl not found — the test cannot run"; exit 1; }

# The block, exactly as deploy.sh has it.
block=$(awk '/^step "Backing up the database"/{on=1} on && /^# -{20,}/{exit} on' "$DEPLOY_SH")
if [ -z "$block" ]; then
    echo "  could not find the backup step in $DEPLOY_SH — the test cannot run"; exit 1
fi

# A test passphrase, made up here. Never a real one.
TEST_PASS="test-only-$(date +%s)-$$"

# Does this filesystem keep Unix modes? Probe once.
probe=$(mktemp -d); touch "$probe/f"; chmod 600 "$probe/f"
if [ "$(stat -c %a "$probe/f")" = 600 ]; then MODES=1; else MODES=0; fi
rm -rf "$probe"

# Runs the block in a fresh scratch dir.
#   $1 = what the fake pg_dumpall does: whole | truncated | fails
#   $2 = the scratch dir (its conf/.backup-env is the shared config file)
# ENV_NAME in the caller's environment picks the environment (default production).
run_step() {
    local mode="$1" dir="$2"
    ( cd "$dir"
      ENV="${ENV_NAME:-production}"
      BACKUP_DIR="$dir/conf"
      step() { :; }; ok() { echo "OK: $*"; }; bad() { echo "BAD: $*"; }; note() { echo "NOTE: $*"; }
      docker() { echo postgres; }                      # "docker ps" sees a database
      fake_compose() {                                 # "$COMPOSE exec -T postgres pg_dumpall"
          printf -- '--\n-- PostgreSQL database cluster dump\n--\n'
          head -c 200000 /dev/urandom | base64          # a body worth compressing
          case "$mode" in
              whole)     printf -- '\n--\n-- PostgreSQL database cluster dump complete\n--\n' ;;
              truncated) : ;;                           # cut off: no marker
              fails)     return 1 ;;                    # pg_dumpall exits non-zero
          esac
      }
      COMPOSE=fake_compose
      eval "$block"
      # What the rest of deploy.sh would inherit.
      printf 'AFTER-BLOCK pass-set=%s\n' "${PREDEPLOY_PASS+yes}"
    )
}

# Writes the config file backup.sh and deploy.sh share.
#   $2 = keep days, $3 = passphrase; "" leaves that line out.
conf() {
    local dir="$1" days="$2" pass="$3"
    mkdir -p "$dir/conf"
    : > "$dir/conf/.backup-env"
    [ -n "$days" ] && echo "BACKUP_KEEP_DAYS=$days" >> "$dir/conf/.backup-env"
    [ -n "$pass" ] && echo "BACKUP_ENC_PASSPHRASE='$pass'" >> "$dir/conf/.backup-env"
    echo "BACKUP_S3_SECRET_KEY=must-not-leak" >> "$dir/conf/.backup-env"
}

decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$2" -in "$1" 2>/dev/null; }

# Old copies with ages in DAYS. $2 = how many encrypted copies, one per day
# going back from 1 day old; $3 = how many old PLAIN copies (.sql/.sql.gz,
# like the 323 on production), all 41+ days old.
seed_old() {
    local dir="$1" nenc="$2" nplain="$3" i f
    mkdir -p "$dir/backups"
    for i in $(seq 1 "$nenc"); do
        f="$dir/backups/pre-deploy-enc-$(printf %03d "$i")d.sql.gz.enc"
        echo old > "$f"; touch -d "$i days ago" "$f"
    done
    for i in $(seq 1 "$nplain"); do
        f="$dir/backups/pre-deploy-202608$(printf %02d "$i")-000000.sql"
        [ $((i % 2)) -eq 0 ] && f="$f.gz"
        echo old > "$f"; touch -d "$((40 + i)) days ago" "$f"
    done
    echo "not a dump" > "$dir/backups/keep-me.txt"
    touch -d "400 days ago" "$dir/backups/keep-me.txt"
}

n_enc()   { find "$1/backups" -maxdepth 1 -name 'pre-deploy-*.sql.gz.enc' 2>/dev/null | wc -l | tr -d ' '; }
n_plain() { find "$1/backups" -maxdepth 1 \( -name 'pre-deploy-*.sql' -o -name 'pre-deploy-*.sql.gz' \) 2>/dev/null | wc -l | tr -d ' '; }
newest()  { ls -1t "$1"/backups/pre-deploy-*.sql.gz.enc 2>/dev/null | head -1; }
exists()  { [ -e "$1" ] && echo kept || echo gone; }

printf '\n  deploy.sh pre-deploy backup step\n  ================================\n\n'
[ "$MODES" = 1 ] || printf '  (this filesystem keeps no Unix modes — permission checks will be SKIPPED)\n\n'

# 1. A whole dump is written ENCRYPTED, decrypts with the config's
#    passphrase to the whole dump, and is not readable as gzip on its own.
d=$(mktemp -d); conf "$d" 14 "$TEST_PASS"; out=$(run_step whole "$d"); rc=$?
f=$(newest "$d")
if [ $rc -eq 0 ] && [ -n "$f" ] && [[ "$out" == *"whole, encrypted"* ]]; then
    ok_ "a whole dump is written as .sql.gz.enc and reported 'whole, encrypted'"
else bad_ "whole dump: rc=$rc file='${f:-none}' out=$out"; fi
body=""; [ -n "$f" ] && body=$(decrypt "$f" "$TEST_PASS" | gzip -dc 2>/dev/null | tail -c 200)
[[ "$body" == *"database cluster dump complete"* ]] \
    && ok_ "...it decrypts with BACKUP_ENC_PASSPHRASE to the WHOLE dump (a restore can read it)" \
    || bad_ "the copy does not decrypt and gunzip to a whole dump"
{ [ -n "$f" ] && ! gzip -t "$f" 2>/dev/null; } \
    && ok_ "...on its own it is NOT readable as gzip (it really is encrypted)" \
    || bad_ "the copy is readable as plain gzip — it was not encrypted"
{ [ -n "$f" ] && ! decrypt "$f" "wrong-$TEST_PASS" | gzip -t 2>/dev/null; } \
    && ok_ "...a wrong passphrase does not open it" \
    || bad_ "a wrong passphrase opened the copy"
[ -z "$(find "$d/backups" -maxdepth 1 \( -name '*.sql' -o -name '*.sql.gz' \))" ] \
    && ok_ "...no plain .sql or .sql.gz is left beside it" \
    || bad_ "a plain copy was written beside the encrypted one"
grep -qx 'AFTER-BLOCK pass-set=' <<<"$out" \
    && ok_ "...the passphrase is NOT still set for the rest of the deploy" \
    || bad_ "PREDEPLOY_PASS is still set after the block: $(grep AFTER-BLOCK <<<"$out")"
[[ "$out" != *"$TEST_PASS"* && "$out" != *must-not-leak* ]] \
    && ok_ "...neither the passphrase nor any other config secret is printed" \
    || bad_ "a secret appears in the step's output"
if [ "$MODES" = 1 ]; then
    [ "$(stat -c %a "$f")" = 600 ] && ok_ "the copy is mode 600" \
        || bad_ "the copy is mode $(stat -c %a "$f"), not 600"
    [ "$(stat -c %a "$d/backups")" = 700 ] && ok_ "the backups directory is mode 700" \
        || bad_ "backups/ is mode $(stat -c %a "$d/backups"), not 700"
else
    skip_ "the copy is mode 600"
    skip_ "the backups directory is mode 700"
fi
rm -rf "$d"

# 2. An existing world-readable backups/ is TIGHTENED, not just left.
d=$(mktemp -d); conf "$d" 14 "$TEST_PASS"; mkdir -p "$d/backups"; chmod 755 "$d/backups"
out=$(run_step whole "$d"); rc=$?
if [ "$MODES" = 1 ]; then
    [ $rc -eq 0 ] && [ "$(stat -c %a "$d/backups")" = 700 ] \
        && ok_ "an existing 755 backups/ is tightened to 700" \
        || bad_ "an existing backups/ was left at $(stat -c %a "$d/backups")"
else skip_ "an existing 755 backups/ is tightened to 700"; fi
rm -rf "$d"

# 3. PRODUCTION with no passphrase STOPS and writes nothing.
d=$(mktemp -d); conf "$d" 14 ""; out=$(run_step whole "$d"); rc=$?
if [ $rc -ne 0 ] && [[ "$out" == *"will not write an unencrypted copy"* ]] \
   && [ "$(n_enc "$d")" = 0 ] && [ "$(n_plain "$d")" = 0 ]; then
    ok_ "production with no BACKUP_ENC_PASSPHRASE stops the deploy and writes no copy"
else bad_ "production without a passphrase: rc=$rc enc=$(n_enc "$d") plain=$(n_plain "$d") out=$out"; fi
rm -rf "$d"
d=$(mktemp -d); out=$(run_step whole "$d"); rc=$?        # no config file at all
[ $rc -ne 0 ] && [ "$(n_plain "$d")" = 0 ] && [ "$(n_enc "$d")" = 0 ] \
    && ok_ "...and so does production with NO config file at all" \
    || bad_ "production with no config file: rc=$rc plain=$(n_plain "$d")"
rm -rf "$d"

# 4. Staging with no passphrase: allowed, compressed, and SAYS it is plain.
d=$(mktemp -d); conf "$d" 14 ""; out=$(ENV_NAME=staging run_step whole "$d"); rc=$?
if [ $rc -eq 0 ] && [ "$(n_plain "$d")" = 1 ] && [[ "$out" == *"NOT encrypted"* ]]; then
    ok_ "non-production with no passphrase writes a .sql.gz and says NOT encrypted"
else bad_ "staging without a passphrase: rc=$rc plain=$(n_plain "$d") out=$out"; fi
rm -rf "$d"

# 5. A TRUNCATED dump — encrypts fine, decrypts fine, no end marker — stops.
d=$(mktemp -d); conf "$d" 14 "$TEST_PASS"; out=$(run_step truncated "$d"); rc=$?
if [ $rc -ne 0 ] && [[ "$out" == *TRUNCATED* ]]; then
    ok_ "a dump cut off before its end-of-dump marker STOPS the deploy"
else bad_ "truncated dump was accepted: rc=$rc out=$out"; fi
rm -rf "$d"

# 6. pg_dumpall failing must stop, and leave no half file behind.
d=$(mktemp -d); conf "$d" 14 "$TEST_PASS"; out=$(run_step fails "$d"); rc=$?
if [ $rc -ne 0 ] && [[ "$out" == *"backup failed"* ]] && [ "$(n_enc "$d")" = 0 ]; then
    ok_ "a failing pg_dumpall stops the deploy and leaves no partial file"
else bad_ "failing pg_dumpall: rc=$rc files=$(n_enc "$d") out=$out"; fi
rm -rf "$d"

# 7. The window: BACKUP_KEEP_DAYS=14 from the shared config. 20 encrypted
#    copies aged 1..20 days + this deploy's -> ages 1..14 kept, plus the new
#    one = 15. 6 plain copies, 41+ days old, ALL still there.
d=$(mktemp -d); conf "$d" 14 "$TEST_PASS"; seed_old "$d" 20 6; out=$(run_step whole "$d"); rc=$?
if [ $rc -eq 0 ] && [ "$(n_enc "$d")" = 15 ]; then
    ok_ "BACKUP_KEEP_DAYS=14: 20 encrypted copies + this one -> the 15 inside 14 days kept"
else bad_ "window 14: rc=$rc kept=$(n_enc "$d") out=$out"; fi
[ "$(exists "$d/backups/pre-deploy-enc-014d.sql.gz.enc")" = kept ] \
  && [ "$(exists "$d/backups/pre-deploy-enc-015d.sql.gz.enc")" = gone ] \
    && ok_ "...the boundary is right: 14 days old kept, 15 days old gone" \
    || bad_ "boundary wrong: 14d $(exists "$d/backups/pre-deploy-enc-014d.sql.gz.enc"), 15d $(exists "$d/backups/pre-deploy-enc-015d.sql.gz.enc")"
[ "$(n_plain "$d")" = 6 ] && [[ "$out" == *"6 OLD UNENCRYPTED"* ]] \
    && ok_ "...the 6 OLD PLAIN copies, far older than the window, are untouched and counted aloud" \
    || bad_ "a deploy deleted or did not report the old plain copies: $(n_plain "$d") left"
[ -e "$d/backups/keep-me.txt" ] \
    && ok_ "...a 400-day-old file that is not a pre-deploy copy is never touched" \
    || bad_ "the prune deleted a file that was not a pre-deploy copy"
rm -rf "$d"

# 8. The window follows the config: BACKUP_KEEP_DAYS=3 -> 3 + the new one.
d=$(mktemp -d); conf "$d" 3 "$TEST_PASS"; seed_old "$d" 10 0; out=$(run_step whole "$d"); rc=$?
[ $rc -eq 0 ] && [ "$(n_enc "$d")" = 4 ] && [[ "$out" == *"window 3 days"* ]] \
    && ok_ "BACKUP_KEEP_DAYS=3 in the shared config -> copies within 3 days kept (4 with this one)" \
    || bad_ "BACKUP_KEEP_DAYS=3 kept $(n_enc "$d"): $out"
rm -rf "$d"

# 9. No BACKUP_KEEP_DAYS in the config -> backup.sh's default, 14.
d=$(mktemp -d); conf "$d" "" "$TEST_PASS"; seed_old "$d" 20 0; out=$(run_step whole "$d"); rc=$?
[ $rc -eq 0 ] && [ "$(n_enc "$d")" = 15 ] \
    && ok_ "no BACKUP_KEEP_DAYS -> the same default as backup.sh, 14 days" \
    || bad_ "the default window kept $(n_enc "$d")"
rm -rf "$d"

# 10. A nonsense window STOPS before anything is written or deleted.
for v in abc 0 -5; do
    d=$(mktemp -d); conf "$d" "$v" "$TEST_PASS"; seed_old "$d" 20 0; out=$(run_step whole "$d"); rc=$?
    [ $rc -ne 0 ] && [ "$(n_enc "$d")" = 20 ] \
        && ok_ "BACKUP_KEEP_DAYS=$v stops the deploy and deletes nothing" \
        || bad_ "BACKUP_KEEP_DAYS=$v: rc=$rc left=$(n_enc "$d")"
    rm -rf "$d"
done

# 11. A failed backup deletes NOTHING — pruning only follows a good copy.
d=$(mktemp -d); conf "$d" 3 "$TEST_PASS"; seed_old "$d" 10 2; out=$(run_step truncated "$d"); rc=$?
# The 10 old ones must all be there (the rejected new file is left for inspection).
if [ $rc -ne 0 ] && [ "$(find "$d/backups" -name 'pre-deploy-enc-*' | wc -l | tr -d ' ')" = 10 ] \
   && [ "$(n_plain "$d")" = 2 ]; then
    ok_ "a rejected dump prunes nothing: all 10 older encrypted copies are still there"
else bad_ "a rejected dump still pruned: $(n_enc "$d") left"; fi
rm -rf "$d"

printf '\n  ================================\n'
if [ "$fail" -eq 0 ]; then
    printf '  PASS  %s checks' "$pass"
    [ "$skipped" -gt 0 ] && printf ', %s SKIPPED (this filesystem keeps no Unix modes — run on Linux/WSL for those)' "$skipped"
    printf '\n\n'; exit 0
fi
printf '  FAIL  %s of %s checks\n\n' "$fail" "$((pass + fail))"; exit 1
