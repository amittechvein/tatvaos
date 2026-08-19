#!/usr/bin/env bash
# ============================================================================
#  Connect recording and notes — post-deploy verification, PRODUCTION-SAFE.
#
#  Run on the box, from the repo root, AFTER ./infra/scripts/deploy.sh:
#
#      bash infra/scripts/connect-recording-verify.sh
#
#  READ-ONLY. It writes no rows, creates no fixtures, starts no recording and
#  deletes nothing, so it is safe on a box holding customer data. The one
#  thing it touches outside the database is `ls` inside the recordings volume,
#  which it needs in order to check the ownership step.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHAT THIS CANNOT TELL YOU.
#
#   That a recording actually records. That needs two people in a room and
#   somebody pressing the button; the test plan calls it T8. Everything below
#   is the set of preconditions that, when one of them is wrong, makes that
#   test fail in a way nobody can read — a missing volume, an unwritable
#   directory, an egress that cannot reach the bus. Those are worth catching
#   from a terminal in ten seconds rather than from a meeting.
#  ─────────────────────────────────────────────────────────────────────────
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")

PASSED=0; FAILED=0; WARNED=0
ok()   { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad()  { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
warn() { echo "  WARN  $1"; WARNED=$((WARNED+1)); }

# tail -n1 for the reason spelled out in connect-phase1-verify.sh: psql prints
# a command tag for every non-SELECT statement even under -tA, so a script that
# sets a variable and then counts gets two lines back and "SET0" compares
# equal to nothing.
q() {
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" \
        2>/dev/null | tail -n1 | tr -d '[:space:]'
}

echo "== the migration landed =="
n=$(q "SELECT count(*) FROM information_schema.tables
        WHERE table_schema='connect'
          AND table_name IN ('recordings','transcripts','meeting_notes')")
[ "${n:-0}" -eq 3 ] && ok "recordings, transcripts, meeting_notes" \
                    || bad "expected 3 recording tables, found ${n:-0} — 20260902-connect-recording.sql has not applied"

n=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='connect' AND c.relname IN ('recordings','transcripts','meeting_notes')
          AND c.relrowsecurity AND c.relforcerowsecurity")
[ "${n:-0}" -eq 3 ] && ok "all 3 ENABLE + FORCE row level security" \
                    || bad "only ${n:-0} of 3 are forced — a table without FORCE is readable by its owner"

# ILIKE, not LIKE: PostgreSQL re-renders the stored expression and NULLIF comes
# back uppercase, so a case-sensitive match here reported zero against a
# perfectly correct policy the first time this was written.
n=$(q "SELECT count(*) FROM pg_policies
        WHERE schemaname='connect' AND policyname='tenant_isolation'
          AND tablename IN ('recordings','transcripts','meeting_notes')
          AND qual ILIKE '%nullif%' AND qual ILIKE '%connect.meetings%'")
[ "${n:-0}" -eq 3 ] && ok "3 policies scope through connect.meetings" \
                    || bad "expected 3 scoped policies, found ${n:-0}"

n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.prosecdef AND p.proname IN
          ('pending_transcription','pending_notes','stuck_recordings','recording_tenant',
           'reconcile_recording_storage','storage_headroom','recording_bytes','recording_allowed')")
[ "${n:-0}" -eq 8 ] && ok "8 SECURITY DEFINER functions for the worker and storage" \
                    || bad "expected 8, found ${n:-0}"

# Every definer function must pin search_path. Without it a caller can shadow
# a schema with their own and have the function write somewhere unintended —
# which is exactly why the rule exists rather than being a preference.
n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.prosecdef
          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c
                           WHERE c LIKE 'search\_path=%')")
[ "${n:-0}" -eq 0 ] && ok "every definer function pins search_path" \
                    || bad "${n:-0} definer function(s) do NOT pin search_path"

n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='core' AND table_name='tenants'
          AND column_name='allow_connect_recording'")
[ "${n:-0}" -eq 1 ] && ok "core.tenants.allow_connect_recording present" \
                    || bad "the org kill-switch column is missing"

# The kind CHECK must accept egress events. If it does not, the FIRST egress
# webhook fails its constraint, the handler answers 500, and LiveKit retries a
# request that can never succeed — for ever.
n=$(q "SELECT count(*) FROM pg_constraint con
        JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=rel.relnamespace
       WHERE ns.nspname='connect' AND rel.relname='meeting_events' AND con.contype='c'
         AND pg_get_constraintdef(con.oid) LIKE '%egress_ended%'")
[ "${n:-0}" -eq 1 ] && ok "meeting_events accepts egress_started/updated/ended" \
                    || bad "the kind CHECK has not been widened — every egress webhook will 500"

echo
echo "== notes without a transcript =="
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='meeting_notes'
          AND column_name IN ('attendance','had_transcript')")
[ "${n:-0}" -eq 2 ] && ok "meeting_notes carries attendance and had_transcript" \
                    || bad "expected both columns, found ${n:-0} — 20260903-connect-notes-attendance.sql has not applied"

n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.proname='attendance'")
[ "${n:-0}" -eq 1 ] && ok "connect.attendance() present" || bad "connect.attendance() is missing"

# pending_notes must no longer require a transcript. Read from the definition
# rather than by running it, because running it on production would mean
# asserting against real customers' meetings.
#
# THE MATCH IS DONE IN SQL, NOT IN THE SHELL. The first version of this piped
# pg_get_functiondef through q() and grepped it — and q() ends in
# `tail -n1 | tr -d '[:space:]'`, which is correct for the scalars everything
# else here asks for and destroys a multi-line function body: it kept the last
# line and then deleted every space, so the pattern could never match. It
# reported a red FAIL against a perfectly correct migration. Ask the database
# for a COUNT, which is what q() is for.
n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.proname='pending_notes'
          AND pg_get_functiondef(p.oid) LIKE '%status = ''ended''%'")
[ "${n:-0}" -eq 1 ] && ok "pending_notes covers every ended meeting, not only transcribed ones" \
                    || bad "pending_notes still requires a transcript — notes will never appear for meetings that were not recorded"

# How much has actually been produced. Not an assertion — a number to look at.
meetings=$(q "SELECT count(*) FROM connect.meetings WHERE status='ended'")
noted=$(q "SELECT count(*) FROM connect.meeting_notes WHERE status='ready'")
echo "  ..    ${noted:-0} set(s) of notes for ${meetings:-0} ended meeting(s)"
if [ "${meetings:-0}" -gt 0 ] && [ "${noted:-0}" -eq 0 ]; then
    warn "meetings have ended and none has notes. The worker runs a minute after start and once a minute after that — check: $(printf '%s' "${COMPOSE[*]}") logs --tail 50 api | grep -i notes"
fi

echo
echo "== minutes of meeting (20260904) =="
# ─────────────────────────────────────────────────────────────────────────
#  THIS SECTION EXISTS BECAUSE ITS ABSENCE WAS NOTICED THE HARD WAY.
#
#  20260904 was deployed and this script reported 25 ok, 0 failed without
#  looking at a single thing the migration added. A verification script that
#  is silent about the newest migration is worse than no script for it: the
#  green line reads as "everything is fine" and it means "everything I was
#  told about in August is fine".
# ─────────────────────────────────────────────────────────────────────────
n=$(q "SELECT count(*) FROM information_schema.tables
        WHERE table_schema='connect' AND table_name='meeting_chat'")
if [ "${n:-0}" -ne 1 ]; then
    bad "connect.meeting_chat is missing — 20260904-connect-minutes.sql has not applied"
else
    ok "connect.meeting_chat"

    n=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
            WHERE ns.nspname='connect' AND c.relname='meeting_chat'
              AND c.relrowsecurity AND c.relforcerowsecurity")
    [ "${n:-0}" -eq 1 ] && ok "meeting_chat has ENABLE + FORCE row level security" \
                        || bad "meeting_chat is not FORCED — the owning role would bypass the policy"

    # Scoped through the parent meeting, like recordings and notes: a chat line
    # must be exactly as reachable as the meeting it belongs to and no more.
    n=$(q "SELECT count(*) FROM pg_policies
            WHERE schemaname='connect' AND tablename='meeting_chat'
              AND qual ILIKE '%connect.meetings%' AND qual ILIKE '%app.tenant_id%'")
    [ "${n:-0}" -ge 1 ] && ok "its policy scopes through connect.meetings" \
                        || bad "meeting_chat's policy does not scope through the meeting"

    # The de-duplication. Without this UNIQUE index the ON CONFLICT clause in
    # the endpoint has nothing to conflict on and every client that saw a
    # guest's line stores its own copy of it.
    n=$(q "SELECT count(*) FROM pg_indexes
            WHERE schemaname='connect' AND tablename='meeting_chat'
              AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%client_id%'")
    [ "${n:-0}" -ge 1 ] && ok "the (meeting_id, client_id) index is UNIQUE — one line, one row" \
                        || bad "no unique index on client_id — a guest's chat line will be stored once per client that saw it"
fi

n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='meeting_notes'
          AND column_name IN ('emailed_at','email_attempts','email_error','email_recipients')")
[ "${n:-0}" -eq 4 ] && ok "meeting_notes records where the minutes email got to" \
                    || bad "expected 4 email columns on meeting_notes, found ${n:-0}"

n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.prosecdef AND p.proname IN
          ('pending_minutes_email','notes_tenant','minutes_recipients',
           'minutes_unreachable','meeting_chat_lines')")
[ "${n:-0}" -eq 5 ] && ok "5 more definer functions for the minutes worker" \
                    || bad "expected 5 minutes functions, found ${n:-0}"

# ── The switch, and whether anybody is actually being emailed. ─────────────
#
# Reported either way, and loudly when it is ON. Outbound mail about what was
# said in a meeting, to people including guests, is not something anybody
# should discover by receiving it.
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='core' AND table_name='tenants'
          AND column_name='connect_email_minutes'")
if [ "${n:-0}" -ne 1 ]; then
    bad "core.tenants.connect_email_minutes is missing"
else
    on=$(q "SELECT count(*) FROM core.tenants WHERE connect_email_minutes")
    if [ "${on:-0}" -eq 0 ]; then
        ok "minutes email is OFF for every organisation (the default)"
    else
        names=$(q "SELECT string_agg(name, ', ') FROM core.tenants WHERE connect_email_minutes")
        ok "minutes email is ON for ${on} organisation(s): ${names}"
    fi
fi

# Numbers to look at, not assertions.
chat=$(q "SELECT count(*) FROM connect.meeting_chat" 2>/dev/null)
sent=$(q "SELECT count(*) FROM connect.meeting_notes WHERE emailed_at IS NOT NULL")
echo "  ..    ${chat:-0} chat line(s) kept, ${sent:-0} set(s) of minutes emailed"

# Three strikes and the worker stops offering the row. Worth surfacing,
# because nothing else will ever mention it again.
stuck=$(q "SELECT count(*) FROM connect.meeting_notes
            WHERE emailed_at IS NULL AND email_attempts >= 3")
if [ "${stuck:-0}" -gt 0 ]; then
    warn "${stuck} set(s) of minutes gave up after 3 send attempts — see meeting_notes.email_error"
fi

echo
echo "== host controls (20260905) =="
# The 20260904 lesson, applied on the day rather than a day late: the newest
# migration gets its section BEFORE it ships, so a green run can never mean
# "everything I was told about last time is fine".
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='meetings'
          AND column_name IN ('auto_record','share_policy')")
[ "${n:-0}" -eq 2 ] && ok "meetings carries auto_record and share_policy" \
                    || bad "expected 2 host-control columns on meetings, found ${n:-0} — 20260905 has not applied"

n=$(q "SELECT count(*) FROM pg_constraint
        WHERE conname='meetings_share_policy_check'
          AND conrelid='connect.meetings'::regclass")
[ "${n:-0}" -eq 1 ] && ok "share_policy has its CHECK constraint" \
                    || bad "share_policy is unconstrained — a typo'd policy would silently mean 'everyone'"

n=$(q "SELECT count(*) FROM information_schema.tables
        WHERE table_schema='connect' AND table_name='meeting_blocks'")
if [ "${n:-0}" -ne 1 ]; then
    bad "connect.meeting_blocks is missing — Remove does not survive a rejoin"
else
    ok "connect.meeting_blocks"

    n=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
            WHERE ns.nspname='connect' AND c.relname='meeting_blocks'
              AND c.relrowsecurity AND c.relforcerowsecurity")
    [ "${n:-0}" -eq 1 ] && ok "meeting_blocks has ENABLE + FORCE row level security" \
                        || bad "meeting_blocks RLS is not forced — readable by its owner"

    n=$(q "SELECT count(*) FROM pg_policies
            WHERE schemaname='connect' AND tablename='meeting_blocks'
              AND qual ILIKE '%meetings%'")
    [ "${n:-0}" -ge 1 ] && ok "its policy scopes through connect.meetings" \
                        || bad "meeting_blocks has no meeting-scoped policy"

    n=$(q "SELECT count(*) FROM pg_indexes
            WHERE schemaname='connect' AND tablename='meeting_blocks'
              AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%user_id%'")
    [ "${n:-0}" -ge 1 ] && ok "the (meeting_id, user_id) index is UNIQUE — re-removing is a no-op" \
                        || bad "no unique index on meeting_blocks.user_id"
fi

# A number to look at, not an assertion: rooms carrying the auto-record flag.
autorec=$(q "SELECT count(*) FROM connect.meetings WHERE auto_record" 2>/dev/null)
blocks=$(q "SELECT count(*) FROM connect.meeting_blocks" 2>/dev/null)
echo "  ..    ${autorec:-0} meeting(s) set to auto-record, ${blocks:-0} block row(s)"

echo
echo "== notes timing and retention (20260906, 20260907) =="
# The on-the-day rule again: the newest migrations get their section before
# they ship, so a green run can never mean "everything I was told about last
# time is fine".
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='meeting_notes'
          AND column_name='had_recording'")
[ "${n:-0}" -eq 1 ] && ok "meeting_notes.had_recording present" \
                    || bad "had_recording missing — minutes cannot tell 'not recorded' from 'not transcribed'"

# The check that would have caught the first proven run's wrong sentence:
# pending_notes must defer on RECORDINGS, not only transcripts. Asked of the
# function's actual definition, not of a comment about it.
n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.proname='pending_notes'
          AND pg_get_functiondef(p.oid) ILIKE '%connect.recordings%'")
[ "${n:-0}" -eq 1 ] && ok "pending_notes defers while a recording is still settling" \
                    || bad "pending_notes ignores recordings — notes will claim 'not recorded' beside a processing egress"

n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='core' AND table_name='tenants'
          AND column_name='connect_recording_retention_days'")
if [ "${n:-0}" -ne 1 ]; then
    bad "core.tenants.connect_recording_retention_days is missing — 20260907 has not applied"
else
    ok "retention column present"

    n=$(q "SELECT count(*) FROM pg_constraint
            WHERE conname='tenants_connect_retention_check'
              AND conrelid='core.tenants'::regclass")
    [ "${n:-0}" -eq 1 ] && ok "retention is constrained to 7/30/90/180/365" \
                        || bad "retention is unconstrained — a free-form day count is somebody's bad day"

    # Reported per org, loudly when SHORT: a 7-day retention that nobody
    # remembers choosing is a bulk delete on a timer.
    short=$(q "SELECT count(*) FROM core.tenants WHERE connect_recording_retention_days < 90")
    if [ "${short:-0}" -gt 0 ]; then
        names=$(q "SELECT string_agg(name || ' (' || connect_recording_retention_days || 'd)', ', ')
                     FROM core.tenants WHERE connect_recording_retention_days < 90")
        warn "retention shorter than the 90-day default for: ${names}"
    else
        ok "no organisation below the 90-day default"
    fi
fi

n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='recordings'
          AND column_name='keep_until_at'")
[ "${n:-0}" -eq 1 ] && ok "recordings.keep_until_at (the 'keep this one' exemption) present" \
                    || bad "keep_until_at missing — the sweep has no exemption and the first board meeting it eats is a ticket"

n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.prosecdef AND p.proname='expired_recordings'
          AND pg_get_functiondef(p.oid) ILIKE '%search_path%'")
[ "${n:-0}" -eq 1 ] && ok "expired_recordings is SECURITY DEFINER with a pinned search_path" \
                    || bad "expired_recordings missing or unpinned — the sweep has no queue"

# Numbers to look at, not assertions.
kept=$(q "SELECT count(*) FROM connect.recordings WHERE keep_until_at IS NOT NULL" 2>/dev/null)
due=$(q "SELECT count(*) FROM connect.expired_recordings(50)" 2>/dev/null)
echo "  ..    ${kept:-0} recording(s) under a keep hold, ${due:-0} currently due for the sweep"

echo
echo "== the org pool, not the person =="
# Recordings must NOT appear in core.user_storage_usage. Charging the host
# would move a colleague's remaining space when somebody else records.
n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='core' AND p.proname='user_storage_usage'
          AND pg_get_functiondef(p.oid) ILIKE '%connect.%'")
[ "${n:-0}" -eq 0 ] && ok "core.user_storage_usage does NOT count recordings" \
                    || bad "recordings are being charged to a PERSON — they belong to the organisation"

n=$(q "SELECT count(*) FROM core.products WHERE code='connect'")
[ "${n:-0}" -eq 1 ] && ok "'connect' exists in core.products" \
                    || bad "core.storage_allocations.product_code is a foreign key to core.products; without this row the reconcile cannot write"

echo
echo "== the services =="
running() { "${COMPOSE[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | tr -d '\r' | grep -qx "$1"; }

if running egress; then
    ok "egress container is running"
else
    bad "egress is NOT running — 'docker compose ... up -d egress', then check its logs"
fi

# LiveKit and Egress talk over Redis. Without it the SFU starts, works, and no
# egress can ever register with it — and the SFU says nothing about that.
lk_redis=$("${COMPOSE[@]}" exec -T livekit sh -c 'echo "${REDIS_HOST:-}"' 2>/dev/null | tr -d '[:space:]')
[ -n "$lk_redis" ] && ok "livekit has REDIS_HOST=$lk_redis" \
                   || bad "livekit has no REDIS_HOST — egress cannot reach it, and neither will report an error"

if running egress; then
    # A registered egress logs its handshake. Absence is not proof of failure
    # on a long-running container whose logs have rotated, so this WARNS.
    if "${COMPOSE[@]}" logs --tail 200 egress 2>&1 | grep -qiE 'starting|worker registered|egress'; then
        ok "egress has logged startup"
    else
        warn "no recognisable startup line in the last 200 egress log lines — check them by hand"
    fi
    if "${COMPOSE[@]}" logs --tail 200 egress 2>&1 | grep -qiE 'connection refused|NOAUTH|WRONGPASS|no such host'; then
        bad "egress logs a Redis connection error — the bus password or address is wrong"
    else
        ok "no Redis connection errors in the egress log"
    fi
fi

echo
echo "== the recordings volume =="
# Egress WRITES as its own uid; the API READS and DELETES as its own gid. The
# directory must therefore be owned by egress, group-owned by the API, and
# setgid so new files inherit the group. This is a ONE-TIME step, like
# spaceblobs, and it is invisible until the first recording fails to appear.
# Both ids, and the volume name, are ASKED FOR below rather than written down.
# ─────────────────────────────────────────────────────────────────────────
#  ASK EGRESS WHAT UID IT IS. DO NOT ASSUME ONE.
#
#  This block used to assert the directory was owned by uid 1000, a number
#  read out of LiveKit's Dockerfile — `useradd` with no explicit uid — and
#  assumed to land on the Debian default. It does not. The check passed,
#  because it compared the directory against the constant it had itself been
#  told to write, and the first real recording died with
#
#      Local upload failed: open /var/lib/connect/recordings/....ogg:
#      permission denied
#
#  after running for 52 seconds. A check that asserts a constant proves
#  nothing; a check that compares two things which must agree proves the
#  thing you care about. So the uid comes from the container.
# ─────────────────────────────────────────────────────────────────────────
EGUID=$("${COMPOSE[@]}" exec -T egress id -u 2>/dev/null | tr -d '[:space:]')
[ -n "$EGUID" ] && ok "egress runs as uid $EGUID" \
                || warn "could not ask the egress container for its uid — is it running?"

# ─────────────────────────────────────────────────────────────────────────
#  AND ASK THE API WHAT GID IT IS, FOR EXACTLY THE SAME REASON.
#
#  This block hardcoded 5000 for a whole day AFTER the uid-1000 lesson above
#  was written directly on top of it. Same shape: a number taken from a
#  Dockerfile, asserted against a directory the same script tells you to
#  chown to that number. It happened to be right, which is the only reason
#  it did not cost a second night — and "happened to be right" is not a
#  check.
#
#  If the API image ever changes its user, the hardcoded version would keep
#  saying OK while deletes started failing. This version cannot.
# ─────────────────────────────────────────────────────────────────────────
APIGID=$("${COMPOSE[@]}" exec -T api id -g 2>/dev/null | tr -d '[:space:]')
[ -n "$APIGID" ] && ok "the api runs as gid $APIGID" \
                 || warn "could not ask the api container for its gid — is it running?"

# The volume name is derived too. 'tatvaos_connectrec' was a guess about the
# compose project name, which comes from the directory the stack was deployed
# into and is not this script's to assume — a printed fix command that does
# not work is worse than no fix command, because it is followed.
EGCID=$("${COMPOSE[@]}" ps -q egress 2>/dev/null | head -n1)
VOLNAME=""
if [ -n "$EGCID" ]; then
    VOLNAME=$(docker inspect -f \
        '{{range .Mounts}}{{if eq .Destination "/var/lib/connect/recordings"}}{{.Name}}{{end}}{{end}}' \
        "$EGCID" 2>/dev/null | tr -d '[:space:]')
fi
FIXCMD="docker run --rm -v ${VOLNAME:-<recordings-volume>}:/r alpine sh -c 'chown ${EGUID:-<egress-uid>}:${APIGID:-<api-gid>} /r && chmod 2775 /r'"
[ -n "$VOLNAME" ] && ok "the recordings volume is $VOLNAME" \
                  || warn "could not work out the recordings volume name from the egress container"

perm=$("${COMPOSE[@]}" exec -T api sh -c 'stat -c "%u %g %a" /var/lib/connect/recordings' 2>/dev/null | tr -d '\r')
if [ -z "$perm" ]; then
    bad "the api container cannot see /var/lib/connect/recordings — is the volume mounted?"
else
    set -- $perm
    owner=$1; group=$2; mode=$3
    if [ -z "$APIGID" ]; then
        warn "recordings dir gid is $group; could not confirm the api's own gid"
    elif [ "$group" = "$APIGID" ] || [ "$APIGID" = "0" ]; then
        ok "recordings dir is group-owned by the api (gid $group)"
    else
        bad "recordings dir gid is $group but THE API RUNS AS GID $APIGID — it will not be able to delete recordings. Fix: $FIXCMD"
    fi
    case "$mode" in
        2775|2777|3775) ok "recordings dir is setgid and group-writable (mode $mode)" ;;
        *) bad "recordings dir mode is $mode, expected 2775 — without setgid, files egress writes will not be readable by the API. Fix: $FIXCMD" ;;
    esac
    # FAIL, not warn. This is the difference between recording and not
    # recording, and it fails ~52 seconds AFTER somebody has finished
    # talking — the most expensive moment to find out.
    if [ -z "$EGUID" ]; then
        warn "recordings dir uid is $owner; could not confirm egress's own uid"
    elif [ "$owner" = "$EGUID" ] || [ "$EGUID" = "0" ]; then
        ok "recordings dir is owned by egress (uid $owner)"
    else
        bad "recordings dir uid is $owner but EGRESS RUNS AS $EGUID — it cannot write, and the recording will fail at the end with 'permission denied'. Fix: $FIXCMD"
    fi
fi

# The proof that beats all of the above: actually write a file as egress.
# Everything else is inference about permissions; this is the permission.
if [ -n "$EGUID" ]; then
    probe=".verify-write-probe"
    if "${COMPOSE[@]}" exec -T egress sh -c "touch /var/lib/connect/recordings/$probe" >/dev/null 2>&1; then
        ok "egress can actually create a file in the recordings directory"
        # Tidy up as the API, which is the container that owns deletion.
        "${COMPOSE[@]}" exec -T api sh -c "rm -f /var/lib/connect/recordings/$probe" >/dev/null 2>&1 \
            && ok "the api can delete it again" \
            || bad "the api could NOT delete that file — recordings can be made but never removed. Fix: $FIXCMD"
    else
        bad "egress CANNOT create a file in the recordings directory. Every recording will run to completion and then fail. Fix: $FIXCMD"
    fi
fi

echo
echo "== the API's own view =="
enabled=$("${COMPOSE[@]}" exec -T api sh -c 'echo "${Connect__Recording__Enabled:-}"' 2>/dev/null | tr -d '[:space:]')
case "$enabled" in
    true|True|TRUE|1) ok "the API has recording switched on" ;;
    *) warn "Connect__Recording__Enabled is '${enabled:-unset}' — every recording endpoint will answer 'not switched on for this server'. Set CONNECT_RECORDING_ENABLED=true in infra/docker/.env" ;;
esac

stt=$("${COMPOSE[@]}" exec -T api sh -c 'echo "${Connect__Recording__TranscriptionUrl:-}"' 2>/dev/null | tr -d '[:space:]')
if [ -n "$stt" ]; then
    ok "transcription is configured (${stt})"
else
    warn "no transcription service configured — recordings will be kept as audio and transcripts marked 'unavailable'. This is a deliberate default: nothing leaves the box until you set one."
fi

notes=$("${COMPOSE[@]}" exec -T api sh -c 'echo "${Connect__Recording__NotesModel:-}"' 2>/dev/null | tr -d '[:space:]')
if [ -n "$notes" ]; then
    ok "a notes model is configured (${notes})"
else
    warn "no notes model configured — notes will be a mechanical DIGEST of the transcript, labelled as such. Useful, but not a written summary."
fi

echo
echo "== the image is pinned =="
# livekit and coturn are pinned by digest so a later 'compose pull' cannot swap
# them under a deployment that is known to work. egress ships unpinned because
# the digest could not be resolved when it was written. Pin it after the first
# successful recording:
#   docker inspect --format='{{index .RepoDigests 0}}' livekit/egress:latest
if grep -qE '^\s+image:\s+livekit/egress:.*@sha256:' infra/docker/docker-compose.base.yml; then
    ok "egress image is pinned by digest"
else
    bad "egress image is NOT pinned by digest — run: docker inspect --format='{{index .RepoDigests 0}}' livekit/egress:latest  and put the result in docker-compose.base.yml"
fi

echo
echo "== how much is stored =="
bytes=$(q "SELECT COALESCE(SUM(used_bytes),0) FROM core.storage_allocations WHERE product_code='connect'")
echo "  ..    recordings across all organisations: ${bytes:-0} bytes"
rows=$(q "SELECT count(*) FROM connect.recordings")
echo "  ..    ${rows:-0} recording row(s), $(q "SELECT count(*) FROM connect.transcripts") transcript(s), $(q "SELECT count(*) FROM connect.meeting_notes") set(s) of notes"

echo
echo "  $PASSED ok, $FAILED failed, $WARNED warning(s)"
[ "$FAILED" -eq 0 ] || exit 1
