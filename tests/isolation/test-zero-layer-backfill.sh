#!/usr/bin/env bash
#
# TatvaOS - the zero-layer backfill cannot fail a deploy.
#
# WHY THIS EXISTS. Mr. Singh, 30 Sept 2026, reviewing PR 330: the migration
# fills calendar.reminder_sends.tenant_id from each row's event, then sets it
# NOT NULL, and it runs again on EVERY deploy. If a row's event is gone, the
# fill leaves it NULL, SET NOT NULL fails - and so does every deploy after that
# (decision 0001's lesson: a migration that works on an empty database and
# fails on real rows). Production's table was empty when this was written, but
# PR 329 fills it from the day it deploys, before this does.
#
# THE ORPHAN. events -> event_reminders -> reminder_sends is ON DELETE CASCADE
# at both steps (20260816-calendar.sql), so deleting an event deletes its sends.
# An orphan can only exist if the foreign-key triggers were bypassed. This test
# makes one exactly that way (session_replication_role = replica, superuser
# only), because that is the only way one can exist.
#
#   1. a database from every migration EXCEPT this one: production's state on
#      the morning of the deploy
#   2. a real send row, and an orphaned one whose event is gone
#   3. apply 20260927-d-zero-layer-rls.sql: it must succeed, say how many it
#      removed, keep the real row with its organisation, and leave no NULL
#   4. apply it again: every file re-runs on every deploy
#
# Its own throwaway database (house rule 13), dropped at the end.
# Usage: bash tests/isolation/test-zero-layer-backfill.sh
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$HERE/local/postgres/init/20260927-d-zero-layer-rls.sql"
TECHVEIN="11111111-1111-1111-1111-111111111111"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}

# The migrations WITHOUT this one, in a scratch copy: the helper builds the
# database from TATVAOS_ROOT's local/postgres/init/.
SCRATCH="$HERE/.tmp/zero-layer-backfill-$$"
mkdir -p "$SCRATCH/local/postgres"
cp -r "$HERE/local/postgres/init" "$SCRATCH/local/postgres/"
rm -f "$SCRATCH/local/postgres/init/$(basename "$MIG")"

# Set BEFORE tdb_create: the helper chains it, so it runs after the drop.
trap 'rm -rf "$SCRATCH"' EXIT
# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
TATVAOS_ROOT="$SCRATCH" tdb_create zl_backfill || exit 2

PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }
# Several statements in ONE session (session_replication_role is per session).
PGS() { $TATVAOS_PSQL "$1" 2>&1 | grep -v "^wsl:" | tr -d "\r"; }
# Apply the migration the way deploy.sh does: the whole file on stdin, with
# ON_ERROR_STOP. Output and exit code both kept.
apply() {
    local base="${TATVAOS_PSQL% -Atc}"
    APPLY_OUT="$($base -v ON_ERROR_STOP=1 < "$MIG" 2>&1 | grep -v "^wsl:" | tr -d "\r")"
    APPLY_RC=${PIPESTATUS[0]}
}

printf "\n  Zero-layer backfill\n  tree under test: %s\n  database: %s\n" "$(git -C "$HERE" rev-parse HEAD 2>/dev/null)" "$TDB_NAME"

step "1. The database is production's shape before the deploy"
same "reminder_sends has no tenant_id yet" "$(PG "SELECT count(*) FROM information_schema.columns WHERE table_schema='calendar' AND table_name='reminder_sends' AND column_name='tenant_id'")" "0"
same "events -> event_reminders is ON DELETE CASCADE" "$(PG "SELECT confdeltype FROM pg_constraint WHERE conrelid='calendar.event_reminders'::regclass AND confrelid='calendar.events'::regclass AND contype='f'")" "c"
same "event_reminders -> reminder_sends is ON DELETE CASCADE" "$(PG "SELECT confdeltype FROM pg_constraint WHERE conrelid='calendar.reminder_sends'::regclass AND confrelid='calendar.event_reminders'::regclass AND contype='f'")" "c"

step "2. A real send, and an orphaned one whose event is gone"
plant() { # plant TAG -> reminder id
    local cal ev
    cal=$(PG "WITH x AS (INSERT INTO calendar.calendars (tenant_id, name) VALUES ('$TECHVEIN', 'Backfill test $1') RETURNING id) SELECT id FROM x")
    ev=$(PG "WITH x AS (INSERT INTO calendar.events (tenant_id, calendar_id, uid, title, starts_at, ends_at) VALUES ('$TECHVEIN', '$cal', 'bf-$1@test', 'Backfill test $1', now(), now() + interval '30 minutes') RETURNING id) SELECT id FROM x")
    PG "WITH x AS (INSERT INTO calendar.event_reminders (event_id, minutes_before, method) VALUES ('$ev', 10, 'email') RETURNING id) SELECT id FROM x"
}
R_REAL=$(plant real); R_ORPHAN=$(plant orphan)
PG "INSERT INTO calendar.reminder_sends (reminder_id, occurrence_starts_at) VALUES ('$R_REAL', now()), ('$R_ORPHAN', now())" >/dev/null
# The only way an orphan can exist: delete its event with the foreign-key
# triggers bypassed, so the cascade does not run.
PGS "SET session_replication_role = replica; DELETE FROM calendar.events WHERE title = 'Backfill test orphan';" >/dev/null
same "two send rows before the migration" "$(PG "SELECT count(*) FROM calendar.reminder_sends")" "2"
same "...one of them has no event any more (the orphan)" "$(PG "SELECT count(*) FROM calendar.reminder_sends s JOIN calendar.event_reminders r ON r.id = s.reminder_id LEFT JOIN calendar.events e ON e.id = r.event_id WHERE e.id IS NULL")" "1"

step "3. Apply the migration (deploy day)"
apply
same "the migration succeeds (psql exit 0)" "$APPLY_RC" "0"
[ "$APPLY_RC" -eq 0 ] || printf "        %s\n" "$(printf '%s\n' "$APPLY_OUT" | grep -m2 -E "ERROR|DETAIL")"
same "it says how many orphaned rows it removed" "$(printf '%s\n' "$APPLY_OUT" | grep -c "removed 1 reminder_sends row(s) whose event is gone")" "1"
same "no send row is left without an organisation" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE tenant_id IS NULL")" "0"
same "tenant_id is NOT NULL" "$(PG "SELECT is_nullable FROM information_schema.columns WHERE table_schema='calendar' AND table_name='reminder_sends' AND column_name='tenant_id'")" "NO"
same "the real send is kept, with its organisation" "$(PG "SELECT tenant_id FROM calendar.reminder_sends WHERE reminder_id='$R_REAL'")" "$TECHVEIN"
same "the orphaned send is gone" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id='$R_ORPHAN'")" "0"
same "row security is forced on reminder_sends" "$(PG "SELECT relforcerowsecurity FROM pg_class WHERE oid='calendar.reminder_sends'::regclass")" "t"

step "4. Apply it again (every file re-runs on every deploy)"
apply
same "the second run succeeds too" "$APPLY_RC" "0"
same "...and has nothing to remove, so says nothing" "$(printf '%s\n' "$APPLY_OUT" | grep -c "whose event is gone")" "0"
same "the real send is still there" "$(PG "SELECT count(*) FROM calendar.reminder_sends WHERE reminder_id='$R_REAL'")" "1"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
