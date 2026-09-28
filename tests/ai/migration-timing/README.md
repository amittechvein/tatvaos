# Timing the Mail AI migrations at production size

Mr. Singh, 25 Sept 2026: every file in `local/postgres/init/` re-runs on every
deploy, so time the first run AND the second on a copy at a realistic size.

1. Copy a local database that already has the schema, e.g.
   `wsl -u postgres -e psql -c "CREATE DATABASE tatvaos_mailperf TEMPLATE tatvaos_mailai"`
2. Fill it to production's measured size (mail.messages 708 MB). At ~2.2 KB
   per message of ordinary words that is ~355,000 rows. The first 20,000 tell
   you the per-row size; scale from there. Bump the `imap_uid` base per batch.
   `wsl -u postgres -e psql -d tatvaos_mailperf -v rows=20000 -f - < fill-production-size.sql`
   (It drops this branch's columns first, so the timed run is a FIRST run.)
   Filler with unique tokens (md5 text) bloats the search index ~4x — use words.
3. `bash time-migrations.sh` — wall time per file per run (minus the printed
   psql-through-wsl baseline), whether mail.messages was rewritten
   (relfilenode), and how many sequential scans each run caused.
4. `wsl -u postgres -e psql -d tatvaos_mailperf -f - < sorter-query-explain.sql`
   — the sorter's per-minute query.

Result, 25 Sept, 355,018 rows / 709 MB: both files, first and second run,
within ~20 ms of the baseline; no rewrite; ZERO scans (after the CHECK moved
to NOT VALID — inline, it cost one full scan under the exclusive lock).
Sorter query: 15 ms warm, 159 ms cold, via idx_mail_messages_mailbox.
