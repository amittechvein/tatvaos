#!/usr/bin/env bash
# LOCAL ONLY. Times this branch's two migrations on the production-sized copy,
# first run then second run, the way deploy.sh re-runs every init file.
# For each run: wall time, whether mail.messages was REWRITTEN (relfilenode
# changes), and how many sequential scans of it the run caused.
set -u
DB=tatvaos_mailperf
PSQL() { wsl -u postgres -e psql -d "$DB" -Atc "$1" 2>&1 | grep -av "^wsl:"; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)

stat() { PSQL "select pg_relation_filenode('mail.messages') || ' ' || seq_scan from pg_stat_user_tables where relid='mail.messages'::regclass"; }

echo "rows: $(PSQL "select count(*) from mail.messages")   size: $(PSQL "select pg_size_pretty(pg_total_relation_size('mail.messages'))")"
# What starting psql through wsl costs on its own, to subtract by eye.
t0=$(date +%s%N); PSQL "select 1" >/dev/null; t1=$(date +%s%N)
echo "baseline: an empty psql call through wsl = $(( (t1 - t0) / 1000000 )) ms"
for run in 1 2; do
  for f in 20260925-mail-ai-switch.sql 20260925-b-mail-ai-triage.sql; do
    PSQL "select pg_stat_force_next_flush()" >/dev/null 2>&1
    before=$(stat)
    t0=$(date +%s%N)
    wsl -u postgres -e psql -d "$DB" -v ON_ERROR_STOP=1 -q -f - < "$ROOT/local/postgres/init/$f" > /dev/null 2>&1
    rc=$?
    t1=$(date +%s%N)
    sleep 1
    after=$(stat)
    echo "run $run  $f  exit=$rc  $(( (t1 - t0) / 1000000 )) ms   filenode+seqscans before=[$before] after=[$after]"
  done
done
