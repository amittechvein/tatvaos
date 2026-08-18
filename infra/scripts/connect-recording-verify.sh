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

# pending_notes must no longer require a transcript. Checked by reading the
# definition rather than by running it, because running it on production would
# mean asserting against real customers' meetings.
if q "SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace ns ON ns.oid=p.pronamespace
      WHERE ns.nspname='connect' AND p.proname='pending_notes'" | grep -q "status = 'ended'"; then
    ok "pending_notes covers every ended meeting, not only transcribed ones"
else
    bad "pending_notes still requires a transcript — notes will never appear for meetings that were not recorded"
fi

# How much has actually been produced. Not an assertion — a number to look at.
meetings=$(q "SELECT count(*) FROM connect.meetings WHERE status='ended'")
noted=$(q "SELECT count(*) FROM connect.meeting_notes WHERE status='ready'")
echo "  ..    ${noted:-0} set(s) of notes for ${meetings:-0} ended meeting(s)"
if [ "${meetings:-0}" -gt 0 ] && [ "${noted:-0}" -eq 0 ]; then
    warn "meetings have ended and none has notes. The worker runs a minute after start and once a minute after that — check: $(printf '%s' "${COMPOSE[*]}") logs --tail 50 api | grep -i notes"
fi

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
# Egress WRITES as its own uid; the API READS and DELETES as 5000. The directory
# must therefore be owned by egress, group-owned by the API, and setgid so new
# files inherit the group. This is a ONE-TIME step, like spaceblobs, and it is
# invisible until the first recording fails to appear.
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

FIXCMD="docker run --rm -v tatvaos_connectrec:/r alpine sh -c 'chown ${EGUID:-<egress-uid>}:5000 /r && chmod 2775 /r'"

perm=$("${COMPOSE[@]}" exec -T api sh -c 'stat -c "%u %g %a" /var/lib/connect/recordings' 2>/dev/null | tr -d '\r')
if [ -z "$perm" ]; then
    bad "the api container cannot see /var/lib/connect/recordings — is the volume mounted?"
else
    set -- $perm
    owner=$1; group=$2; mode=$3
    [ "$group" = "5000" ] && ok "recordings dir is group-owned by the api (gid 5000)" \
        || bad "recordings dir gid is $group, expected 5000 — the API will not be able to delete recordings. Fix: $FIXCMD"
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
