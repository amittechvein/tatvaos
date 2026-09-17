#!/usr/bin/env bash
# =============================================================================
#  tests/connect-invitations/verify-schema.sh
#
#  What CI Migrations does NOT prove about 20260917-b-connect-meeting-invitations.sql
#  (CTO review, 17 Sept 2026): CI applies the schema twice and nothing else. It
#  never updates a meeting, never reads the new table as the application role,
#  and its isolation suite has no case for a table it does not know exists — so
#  it passed without looking. This script looks, against a real Postgres:
#
#    1. the `mode` immutability trigger stays QUIET when invite_sequence is
#       updated — and still FIRES when mode is (so a quiet trigger is not a
#       missing one);
#    2. tenant isolation on connect.meeting_invitations, as tatvaos_app
#       (NOBYPASSRLS): another tenant's rows are invisible, cannot be updated,
#       deleted, or inserted under a spoofed tenant_id; no tenant set sees nothing;
#    3. withdraw then re-invite: the unique index refuses a second row for the
#       same person in any letter case, so a re-invite must reuse the row —
#       which is what the API does;
#    4. retention: connect.sweep_meeting_invitations() deletes invitations 90+
#       days after the meeting is over, keeps everything else, and works as
#       tatvaos_app with NO tenant set (as the worker calls it), where a plain
#       DELETE removes nothing.
#
#  Runs against PostgreSQL in WSL (tests/oidc/README.md), in its OWN database
#  so it never touches tatvaos_mail. Every non-seed schema file is applied
#  twice in C-locale order first, as deploy.sh does.
#
#  Usage:  bash tests/connect-invitations/verify-schema.sh
#  Exit:   0 = every check passed; 1 = at least one failed.
# =============================================================================
set -uo pipefail
# Git Bash rewrites anything that looks like a POSIX path in a command's
# arguments into a Windows one, so /mnt/c/... reached WSL as
# "C:/Program Files/Git/mnt/c/..." and psql could not open a single file.
export MSYS_NO_PATHCONV=1

DB=tatvaos_invites_check
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INIT="$ROOT/local/postgres/init"

# WSL stops its VM seconds after the last wsl process ends, and Postgres with it.
wsl -e sleep 1800 >/dev/null 2>&1 &
KEEPALIVE=$!
trap 'kill $KEEPALIVE 2>/dev/null' EXIT

SU()  { wsl -u postgres -e psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@" 2>&1 | grep -v '^wsl:'; }
# One statement batch as the application role, via localhost TCP (the local
# development password from 0000-core-schema.sql, not a secret).
APP() { wsl -e psql -X -q -At -v ON_ERROR_STOP=1 "postgresql://tatvaos_app:dev_app_pw@localhost/$DB" -c "$1" 2>&1 | grep -v '^wsl:'; }
SUQ() { wsl -u postgres -e psql -X -q -At -d "$DB" -c "$1" 2>&1 | grep -v '^wsl:'; }

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '    ok  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n        got: %s\n' "$1" "$2"; }
expect()      { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2 (wanted $3)"; fi; }
expect_like() { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1" "$2"; fi; }

echo
echo "  connect.meeting_invitations — what CI Migrations does not prove"
echo "  ═════════════════════════════════════════════════════════════"

echo; echo "  building $DB from local/postgres/init (twice, non-seed, C order)"
wsl -u postgres -e psql -X -q -c "DROP DATABASE IF EXISTS $DB" 2>&1 | grep -v '^wsl:\|NOTICE' ; \
wsl -u postgres -e psql -X -q -c "CREATE DATABASE $DB" 2>&1 | grep -v '^wsl:'
for pass_no in 1 2; do
    count=0
    while IFS= read -r f; do
        name=$(basename "$f")
        case "$name" in *seed*) continue ;; esac
        # </dev/null on BOTH wsl calls: wsl reads stdin, and without it the
        # first file swallowed the rest of the file list ("applied 1 files",
        # caught by the table-exists check below on the first run).
        #
        # Success is psql's EXIT CODE under ON_ERROR_STOP, not a grep of its
        # output. Two earlier versions grepped: matching "ERROR" missed psql's
        # own lower-case "could not open file" and reported 75 files applied
        # while applying none; matching "error" in any case then failed on the
        # word inside a harmless NOTICE. wsl passes the exit code through.
        wpath=$(wsl wslpath -a "$(cygpath -m "$f")" </dev/null | tr -d '\r')
        err=$(wsl -u postgres -e psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$wpath" </dev/null 2>&1 >/dev/null)
        rc=$?
        if [ "$rc" -ne 0 ]; then
            echo "  FAIL  pass $pass_no: $name (psql exit $rc)"
            printf '%s\n' "$err" | grep -v '^wsl:' | grep -v 'NOTICE' | head -5
            exit 1
        fi
        count=$((count+1))
    done < <(LC_ALL=C ls "$INIT"/*.sql)
    echo "    applied $count files (pass $pass_no)"
done
expect "the new table exists" "$(SUQ "SELECT to_regclass('connect.meeting_invitations') IS NOT NULL")" "t"

# ---- fixtures, as the superuser ------------------------------------------------
A=aaaaaaaa-0000-4000-8000-000000000001
B=bbbbbbbb-0000-4000-8000-000000000002
MA=aaaaaaaa-1111-4000-8000-000000000001
MB=bbbbbbbb-1111-4000-8000-000000000002
MOLD=aaaaaaaa-2222-4000-8000-000000000003
MFUT=aaaaaaaa-3333-4000-8000-000000000004
fixture=$(SU -c "
  INSERT INTO core.tenants (id, name) VALUES ('$A','Tenant A'), ('$B','Tenant B');
  INSERT INTO connect.meetings (id, tenant_id, code, title, kind, status, mode, scheduled_start)
    VALUES ('$MA','$A','codeAAAAAAAAAAAAAAAAAA','A meeting','scheduled','scheduled','recorded', now() + interval '1 day'),
           ('$MB','$B','codeBBBBBBBBBBBBBBBBBB','B meeting','scheduled','scheduled','recorded', now() + interval '1 day');
  INSERT INTO connect.meeting_invitations (tenant_id, meeting_id, email, status)
    VALUES ('$A','$MA','ravi@example.com','sent'), ('$B','$MB','priya@example.com','sent');
" 2>&1)
[ -z "$fixture" ] || { echo "  FAIL  fixtures: $fixture"; exit 1; }

# ---- 1. the mode trigger -----------------------------------------------------
echo; echo "  1. mode immutability trigger vs invite_sequence"
out=$(SU -c "UPDATE connect.meetings SET invite_sequence = invite_sequence + 1 WHERE id = '$MA'" 2>&1)
expect "updating invite_sequence raises nothing" "${out:-quiet}" "quiet"
expect "…and the update landed" "$(SUQ "SELECT invite_sequence FROM connect.meetings WHERE id = '$MA'")" "1"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); UPDATE connect.meetings SET invite_sequence = invite_sequence + 1 WHERE id = '$MA' RETURNING invite_sequence;")
expect_like "the same update as tatvaos_app with the tenant set (the API's path)" "$out" "^2$"
out=$(SU -c "UPDATE connect.meetings SET mode = 'private' WHERE id = '$MA'" 2>&1)
expect_like "CALIBRATION: changing mode still raises (the trigger is present, not absent)" "$out" "mode is immutable"

# ---- 2. tenant isolation -----------------------------------------------------
echo; echo "  2. tenant isolation on connect.meeting_invitations (as tatvaos_app)"
expect "tenant A sees exactly its own row" \
  "$(APP "SELECT set_config('app.tenant_id', '$A', false); SELECT string_agg(email, ',') FROM connect.meeting_invitations;" | tail -n1)" "ravi@example.com"
expect "tenant B sees exactly its own row" \
  "$(APP "SELECT set_config('app.tenant_id', '$B', false); SELECT string_agg(email, ',') FROM connect.meeting_invitations;" | tail -n1)" "priya@example.com"
expect "no tenant set: nothing" \
  "$(APP "SELECT count(*) FROM connect.meeting_invitations;")" "0"
expect "A cannot read B's row by id-less filter on B's meeting" \
  "$(APP "SELECT set_config('app.tenant_id', '$A', false); SELECT count(*) FROM connect.meeting_invitations WHERE meeting_id = '$MB';" | tail -n1)" "0"
expect "A's UPDATE of B's row changes nothing" \
  "$(APP "SELECT set_config('app.tenant_id', '$A', false); WITH u AS (UPDATE connect.meeting_invitations SET note = 'x' WHERE meeting_id = '$MB' RETURNING 1) SELECT count(*) FROM u;" | tail -n1)" "0"
expect "A's DELETE of B's row removes nothing" \
  "$(APP "SELECT set_config('app.tenant_id', '$A', false); WITH d AS (DELETE FROM connect.meeting_invitations WHERE meeting_id = '$MB' RETURNING 1) SELECT count(*) FROM d;" | tail -n1)" "0"
expect "B's row is still there (superuser view)" \
  "$(SUQ "SELECT count(*) FROM connect.meeting_invitations WHERE meeting_id = '$MB' AND note IS NULL")" "1"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); INSERT INTO connect.meeting_invitations (tenant_id, meeting_id, email) VALUES ('$B', '$MB', 'spoof@example.com');")
expect_like "A cannot INSERT a row claiming tenant B" "$out" "row-level security"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); INSERT INTO connect.meeting_invitations (tenant_id, meeting_id, email) VALUES ('$A', '$MA', 'sam@example.com') RETURNING email;")
expect_like "A can INSERT its own (the policy is not simply closed)" "$out" "sam@example.com"

# ---- 3. withdraw then re-invite ------------------------------------------------
echo; echo "  3. withdraw, then invite the same person again"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); INSERT INTO connect.meeting_invitations (tenant_id, meeting_id, email) VALUES ('$A', '$MA', 'Ravi@Example.com');")
expect_like "a second row for the same person (other letter case) is refused" "$out" "meeting_invitations_meeting_email_uq"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); UPDATE connect.meeting_invitations SET status = 'withdrawn', sequence_sent = 1 WHERE meeting_id = '$MA' AND email = 'ravi@example.com' RETURNING status;")
expect_like "withdraw keeps the row, marked withdrawn" "$out" "withdrawn"
out=$(APP "SELECT set_config('app.tenant_id', '$A', false); UPDATE connect.meeting_invitations SET status = 'pending' WHERE meeting_id = '$MA' AND email = 'ravi@example.com' RETURNING sequence_sent;")
expect_like "re-invite reuses that row and still knows the SEQUENCE they hold" "$out" "^1$"
out=$(SU -c "UPDATE connect.meeting_invitations SET status = 'delivered' WHERE meeting_id = '$MA'" 2>&1)
expect_like "an unknown status is refused by the CHECK" "$out" "meeting_invitations_status_check"

# ---- 4. retention sweep --------------------------------------------------------
echo; echo "  4. 90-day retention sweep"
SU -c "
  INSERT INTO connect.meetings (id, tenant_id, code, title, kind, status, mode, scheduled_start, ended_at, updated_at)
    VALUES ('$MOLD','$A','codeOLDOLDOLDOLDOLDOLDO','Old','scheduled','ended','recorded', now() - interval '92 days', now() - interval '91 days', now() - interval '91 days');
  INSERT INTO connect.meetings (id, tenant_id, code, title, kind, status, mode, scheduled_start)
    VALUES ('$MFUT','$A','codeFUTFUTFUTFUTFUTFUTF','Future','scheduled','scheduled','recorded', now() + interval '10 days');
  INSERT INTO connect.meeting_invitations (tenant_id, meeting_id, email, status)
    VALUES ('$A','$MOLD','old@example.com','sent'), ('$A','$MFUT','future@example.com','sent');
  UPDATE connect.meetings SET status = 'ended', ended_at = now() - interval '89 days' WHERE id = '$MB';
" >/dev/null
expect "a plain DELETE with no tenant set removes nothing (so a definer is needed)" \
  "$(APP "WITH d AS (DELETE FROM connect.meeting_invitations RETURNING 1) SELECT count(*) FROM d;")" "0"
expect "the sweep, as tatvaos_app with no tenant, deletes exactly the 91-day-old one" \
  "$(APP "SELECT connect.sweep_meeting_invitations();")" "1"
expect "old@example.com is gone" "$(SUQ "SELECT count(*) FROM connect.meeting_invitations WHERE email = 'old@example.com'")" "0"
expect "an 89-day-old ended meeting keeps its invitation" "$(SUQ "SELECT count(*) FROM connect.meeting_invitations WHERE email = 'priya@example.com'")" "1"
expect "a future meeting keeps its invitation" "$(SUQ "SELECT count(*) FROM connect.meeting_invitations WHERE email = 'future@example.com'")" "1"
expect "a second sweep deletes nothing more" "$(APP "SELECT connect.sweep_meeting_invitations();")" "0"
out=$(wsl -e psql -X -q -At "postgresql://tatvaos_mailedge:dev_mailedge_pw@localhost/$DB" -c "SELECT connect.sweep_meeting_invitations();" 2>&1 | grep -v '^wsl:')
expect_like "another role cannot run the sweep (EXECUTE revoked from PUBLIC)" "$out" "permission denied\|password authentication failed\|does not exist"

echo
echo "  ═════════════════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then echo "  PASS  $pass checks"; else echo "  FAIL  $fail of $((pass+fail)) checks"; fi
echo
wsl -u postgres -e psql -X -q -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
[ "$fail" -eq 0 ]
