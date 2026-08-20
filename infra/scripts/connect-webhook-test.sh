#!/usr/bin/env bash
# ============================================================================
#  Prove the webhook loop without a browser.
#
#      bash infra/scripts/connect-webhook-test.sh                # local stack
#      bash infra/scripts/connect-webhook-test.sh --production   # see below
#
#  By default this script REFUSES to run against production, exactly like
#  connect-mode-test.sh and connect-host-controls-test.sh. Unlike them it has
#  a legitimate production use — proving the webhook loop on the live box
#  right after a deploy — so production is reachable, but only behind BOTH
#  the --production flag AND typing the full domain when prompted. Intent
#  stated twice: once in the command, once by hand. One of the two by
#  accident is not intent.
#
#  Joins a real meeting's room as a headless participant, waits, leaves, and
#  reports what landed in connect.meeting_events.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY A REAL PARTICIPANT IS UNAVOIDABLE.
#
#   room_started fires when the FIRST PARTICIPANT JOINS an empty room — not
#   when a room is created. CreateRoom over the server API sends no webhook
#   at all, so there is no way to test this by poking an HTTP endpoint. A
#   client has to genuinely establish a session.
#  ─────────────────────────────────────────────────────────────────────────
#
#  The client is livekit/livekit-cli in a throwaway container: one Go binary,
#  removed on exit, nothing installed on this box. It is version-tagged rather
#  than digest-pinned — unlike the livekit and coturn services, this one never
#  serves a customer, so reproducibility matters less than staying current.
#
#  It joins on the COMPOSE NETWORK at ws://livekit:7880, not through the
#  public hostname. That skips Caddy, TLS and DNS: this test is about whether
#  LiveKit calls us back, and routing the client the long way around only adds
#  ways for it to fail for reasons that are not the thing being tested.
#
#  Media may or may not negotiate from inside a container, and it does not
#  matter here. participant_joined fires on the SIGNALLING join, before any
#  track exists — so nothing is published, deliberately.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

# ── arguments: an optional meeting id, and the --production flag. ─────────
PRODUCTION=0
MEETING_ARG=""
for a in "$@"; do
    case "$a" in
        --production) PRODUCTION=1 ;;
        --*) echo "  Unknown flag '$a'. This script takes an optional meeting id"
             echo "  and, for the live box only, --production."; exit 2 ;;
        *) MEETING_ARG="$a" ;;
    esac
done

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
CLI_IMAGE=livekit/livekit-cli:v2.18.2
HOLD="${HOLD:-20}"

# ── REFUSE, RATHER THAN DEFAULT, WHEN THE TARGET IS UNKNOWN. ────────────
#
# Same block as connect-mode-test.sh, for the same reason: a lane checkout
# has no infra/docker/.env, and every fallback taken from a missing file is
# a guess about which system you are pointing a test at. This script puts a
# REAL PARTICIPANT named 'webhook-test' into a REAL ROOM — in a customer's
# meeting, every person present would watch it join. A missing target is a
# refusal, never a default.
if [ ! -f "$ENV_FILE" ]; then
    echo "  REFUSED  $ENV_FILE does not exist in this checkout."
    echo
    echo "           This test drives the stack that env file describes — its"
    echo "           LiveKit, its database. Without the file there is nothing to"
    echo "           point at except a guess, and a guess once pointed a sibling"
    echo "           of this script at production. If you are in a lane checkout,"
    echo "           that is why the file is missing; run this on a box with a"
    echo "           local stack, or on the production box with --production."
    exit 2
fi

SITE=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
case "$SITE" in
    ''|*.tatvaos.com)
        # This is production (or an env file too broken to say). Reachable,
        # but only with intent stated twice.
        if [ "$PRODUCTION" -ne 1 ]; then
            echo "  REFUSED  SITE_DOMAIN='${SITE:-unset}' is production, or unknown."
            echo "           This test joins a real meeting's room as a visible"
            echo "           participant. If you genuinely mean to prove the webhook"
            echo "           loop on the live box, re-run with --production and be"
            echo "           ready to type the domain when asked."
            exit 2
        fi
        if [ -z "$SITE" ]; then
            echo "  REFUSED  --production was given but SITE_DOMAIN is unset in $ENV_FILE."
            echo "           A flag cannot vouch for a target the env file cannot name."
            exit 2
        fi
        echo "  This stack is PRODUCTION ($SITE). The test will join the most recent"
        echo "  meeting's room as a participant named 'webhook-test' — if that is a"
        echo "  customer's meeting, everyone in it will see that participant appear."
        echo "  Pass a meeting id of your own as an argument to control which room."
        printf '  Type the full domain to continue: '
        read -r TYPED
        if [ "$TYPED" != "$SITE" ]; then
            echo "  REFUSED  '$TYPED' does not match '$SITE'. Nothing was run."
            exit 2
        fi
        ;;
esac

# And prove the database is reachable BEFORE doing anything else: q() swallows
# stderr, so without this check "no database here" and "no events arrived"
# print the same failure — an ambiguity a sibling of this script already hit.
if ! "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "  REFUSED  the postgres container is not reachable from here."
    echo "           Bring up the stack (docker compose ... up -d) and re-run."
    exit 2
fi

q() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1; }

KEY=$(grep -E '^LIVEKIT_API_KEY='    "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
SECRET=$(grep -E '^LIVEKIT_API_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
[ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing from $ENV_FILE"; exit 1; }

# ---------------------------------------------------------------------------
# A room whose name does not resolve to a meeting is not a test: the handler
# reads the id out of m-<uuid>, finds no row, and returns 200 having written
# nothing — which is indistinguishable from a webhook that never arrived.
MEETING="${MEETING_ARG:-$(q "SELECT id FROM connect.meetings WHERE status <> 'cancelled' ORDER BY created_at DESC LIMIT 1")}"
if [ -z "$MEETING" ]; then
    echo "No meeting to join. Create one first:"
    echo "    bash infra/scripts/connect-phase1-handcheck.sh"
    exit 1
fi
ROOM="m-${MEETING}"
echo "  meeting  $MEETING"
echo "  room     $ROOM"

NET=$(docker inspect "$("${COMPOSE[@]}" ps -q livekit | head -1)" \
        --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
[ -n "$NET" ] || { echo "Could not find livekit's docker network — is it running?"; exit 1; }
echo "  network  $NET"

before=$(q "SELECT count(*) FROM connect.meeting_events")
echo "  events before: ${before:-0}"

# ---------------------------------------------------------------------------
echo
echo "== joining for ${HOLD}s =="
# Credentials go in the ENVIRONMENT, not argv: a secret on a command line is
# readable by every user on the box via ps, for as long as the process lives.
# The CLI reads LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET itself.
timeout "$((HOLD + 15))" docker run --rm --network "$NET" \
    -e LIVEKIT_URL="ws://livekit:7880" \
    -e LIVEKIT_API_KEY="$KEY" \
    -e LIVEKIT_API_SECRET="$SECRET" \
    "$CLI_IMAGE" room join --identity webhook-test "$ROOM" 2>&1 &
CLI_PID=$!

sleep "$HOLD"
kill "$CLI_PID" 2>/dev/null
wait "$CLI_PID" 2>/dev/null

# room_finished waits for the room's empty timeout, so it will NOT appear
# within this run. room_started and participant_joined should.
echo
echo "== waiting 5s for delivery =="
sleep 5

# ---------------------------------------------------------------------------
after=$(q "SELECT count(*) FROM connect.meeting_events")
echo "  events after: ${after:-0}"
echo

if [ "${after:-0}" -gt "${before:-0}" ]; then
    echo "  OK — the webhook loop is closed. Attendance exists."
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail \
        -c "SELECT kind, identity, occurred_at FROM connect.meeting_events ORDER BY occurred_at" 2>/dev/null
    echo "  Expect room_started and participant_joined. room_finished arrives"
    echo "  later — an empty room is only closed once its empty timeout expires."
    exit 0
fi

echo "  NOTHING ARRIVED."
echo
# ─────────────────────────────────────────────────────────────────────────
#  THE API'S OWN EXCEPTIONS COME FIRST, AND THAT ORDERING IS THE LESSON.
#
#  The first time this test reported zero, LiveKit's log was full of
#  "sent webhook ... status: 200 OK" and that was read as the delivery
#  working. It was not: those 200s were the track_published events this
#  handler deliberately IGNORES and answers before touching anything. The
#  events that mattered were in the same log saying "giving up after 5
#  attempt(s)", and the reason was an unhandled exception in the API that
#  nobody looked at for a day.
#
#  So: ask the API what it threw, before showing anything else.
# ─────────────────────────────────────────────────────────────────────────
echo "  1. WHAT THE API THREW — if anything appears here, this is your answer:"
if "${COMPOSE[@]}" logs --since 3m api 2>&1 \
     | grep -iE 'ConnectWebhookEndpoints|unverifiable|webhook handler threw' \
     | grep -viE 'Executed DbCommand|^ *SELECT|^ *FROM|^ *WHERE' | tail -12; then :; fi
echo
echo "  2. WHAT LIVEKIT SAW. Read the STATUS on each line, and mind which"
echo "     EVENT it belongs to — a 200 on track_published proves nothing,"
echo "     because that event is ignored before any work happens."
"${COMPOSE[@]}" logs --since 3m livekit 2>&1 \
    | grep -iE 'failed to send|giving up|sent webhook' | tail -10
echo
echo "  3. The client never actually joined — read the CLI output above. A"
echo "     token or connection error there means this test never ran."
echo
echo "  2. LiveKit joined but sent nothing: the webhook block is not in the"
echo "     RUNNING process. The file can be right on disk and in the container"
echo "     and still not be loaded — it is read once, at boot."
echo "       bash infra/scripts/connect-phase1-verify.sh"
echo
echo "  3. It arrived and we refused it — the signature did not verify:"
"${COMPOSE[@]}" logs --since 3m api 2>&1 | grep -iE 'unverifiable|webhook' | tail -8
exit 1
