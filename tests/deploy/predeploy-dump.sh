#!/usr/bin/env bash
#
# deploy.sh's "Backing up the database" step: compressed, checked whole,
# and capped — run for real, with docker and Postgres stubbed out.
#
# WHY THIS EXISTS. Until 24 September 2026 the step wrote an uncompressed
# pg_dumpall before every deploy and never deleted one: 313 files, 38 GB of
# a 157 GB production disk at 81%. The fix compresses, checks the dump is
# WHOLE (pg_dumpall's end-of-dump marker), and keeps the newest N. Each of
# those can fail silently, so each has a case here that must go red.
#
# It does NOT copy the step. It cuts the real block out of deploy.sh, from
# `step "Backing up the database"` to the next section rule, and runs it in
# a scratch directory. Change the step and this runs the change.
#
# Usage: bash tests/deploy/predeploy-dump.sh      (no docker needed)
# Exit:  0 all passed, 1 otherwise.

set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
deploy="$root/infra/scripts/deploy.sh"
DEPLOY_SH="${DEPLOY_SH:-$deploy}"     # a mutated copy can be swapped in

pass=0; fail=0
ok_()  { pass=$((pass + 1)); printf '    ok  %s\n' "$1"; }
bad_() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }

# The block, exactly as deploy.sh has it.
block=$(awk '/^step "Backing up the database"/{on=1} on && /^# -{20,}/{exit} on' "$DEPLOY_SH")
if [ -z "$block" ]; then
    echo "  could not find the backup step in $DEPLOY_SH — the test cannot run"; exit 1
fi

# Runs the block in a fresh scratch dir. $1 = what the fake pg_dumpall does:
#   whole | truncated | fails
run_step() {
    local mode="$1" dir="$2"
    ( cd "$dir"
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
    )
}

# Old dumps with staggered ages, newest last. Mixed .sql / .sql.gz, as the
# folder really is across the switch.
seed_old() {
    local dir="$1" n="$2" i
    mkdir -p "$dir/backups"
    for i in $(seq 1 "$n"); do
        local f="$dir/backups/pre-deploy-202608$(printf %02d "$i")-000000.sql"
        [ $((i % 2)) -eq 0 ] && f="$f.gz"
        echo old > "$f"
        touch -d "2026-08-01 +$i hours" "$f"
    done
    echo "not a dump" > "$dir/backups/keep-me.txt"
}

count() { ls -1 "$1"/backups/pre-deploy-* 2>/dev/null | wc -l | tr -d ' '; }

printf '\n  deploy.sh pre-deploy backup step\n  ================================\n\n'

# 1. A whole dump is written compressed and passes.
d=$(mktemp -d); out=$(run_step whole "$d"); rc=$?
f=$(ls "$d"/backups/pre-deploy-*.sql.gz 2>/dev/null | head -1)
if [ $rc -eq 0 ] && [ -n "$f" ] && gzip -t "$f" && [[ "$out" == *"whole)"* ]]; then
    ok_ "a whole dump is written as .sql.gz, passes gzip -t, and says 'whole'"
else bad_ "whole dump: rc=$rc file='${f:-none}' out=$out"; fi
[ -z "$(ls "$d"/backups/pre-deploy-*.sql 2>/dev/null)" ] \
    && ok_ "...and no uncompressed .sql is left beside it" \
    || bad_ "an uncompressed .sql was written"
rm -rf "$d"

# 2. A TRUNCATED dump — readable, valid gzip, no end marker — must stop.
d=$(mktemp -d); out=$(run_step truncated "$d"); rc=$?
if [ $rc -ne 0 ] && [[ "$out" == *TRUNCATED* ]]; then
    ok_ "a dump cut off before its end-of-dump marker STOPS the deploy"
else bad_ "truncated dump was accepted: rc=$rc out=$out"; fi
rm -rf "$d"

# 3. pg_dumpall failing must stop, and leave no half file behind.
d=$(mktemp -d); out=$(run_step fails "$d"); rc=$?
if [ $rc -ne 0 ] && [[ "$out" == *"backup failed"* ]] && [ "$(count "$d")" = 0 ]; then
    ok_ "a failing pg_dumpall stops the deploy and leaves no partial file"
else bad_ "failing pg_dumpall: rc=$rc files=$(count "$d") out=$out"; fi
rm -rf "$d"

# 4. The cap: 25 old + 1 new -> the newest 20 remain, the new one among them.
d=$(mktemp -d); seed_old "$d" 25; out=$(run_step whole "$d"); rc=$?
newest=$(ls -1t "$d"/backups/pre-deploy-* | head -1)
if [ $rc -eq 0 ] && [ "$(count "$d")" = 20 ] && [[ "$newest" == *.sql.gz ]] && gzip -t "$newest"; then
    ok_ "25 old + this deploy's dump -> newest 20 kept, this deploy's among them"
else bad_ "cap: rc=$rc kept=$(count "$d") newest=$newest"; fi
[ -e "$d/backups/pre-deploy-20260801-000000.sql" ] \
    && bad_ "the OLDEST dump survived the cap" \
    || ok_ "...and it is the OLDEST that go"
[ -e "$d/backups/keep-me.txt" ] \
    && ok_ "a file that is not a pre-deploy dump is never touched" \
    || bad_ "the prune deleted a file that was not a pre-deploy dump"
rm -rf "$d"

# 5. A failed backup deletes NOTHING — pruning only follows a good dump.
d=$(mktemp -d); seed_old "$d" 25; out=$(run_step truncated "$d"); rc=$?
# 25 old, plus the rejected new file, which is left for inspection.
if [ $rc -ne 0 ] && [ "$(ls -1 "$d"/backups/pre-deploy-202608* | wc -l | tr -d ' ')" = 25 ]; then
    ok_ "a rejected dump prunes nothing: all 25 older dumps are still there"
else bad_ "a rejected dump still pruned: $(count "$d") left"; fi
rm -rf "$d"

# 6. PREDEPLOY_KEEP is honoured.
d=$(mktemp -d); seed_old "$d" 10
out=$(PREDEPLOY_KEEP=3 run_step whole "$d"); rc=$?
[ $rc -eq 0 ] && [ "$(count "$d")" = 3 ] \
    && ok_ "PREDEPLOY_KEEP=3 keeps exactly 3" \
    || bad_ "PREDEPLOY_KEEP=3 kept $(count "$d")"
rm -rf "$d"

printf '\n  ================================\n'
if [ "$fail" -eq 0 ]; then printf '  PASS  %s checks\n\n' "$pass"; exit 0; fi
printf '  FAIL  %s of %s checks\n\n' "$fail" "$((pass + fail))"; exit 1
