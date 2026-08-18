#!/usr/bin/env bash
# ============================================================================
#  Prove the webhook loop without a browser.
#
#      bash infra/scripts/connect-webhook-test.sh
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

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
CLI_IMAGE=livekit/livekit-cli:v2.18.2
HOLD="${HOLD:-20}"

q() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1; }

KEY=$(grep -E '^LIVEKIT_API_KEY='    "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
SECRET=$(grep -E '^LIVEKIT_API_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
[ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing from $ENV_FILE"; exit 1; }

# ---------------------------------------------------------------------------
# A room whose name does not resolve to a meeting is not a test: the handler
# reads the id out of m-<uuid>, finds no row, and returns 200 having written
# nothing — which is indistinguishable from a webhook that never arrived.
MEETING="${1:-$(q "SELECT id FROM connect.meetings WHERE status <> 'cancelled' ORDER BY created_at DESC LIMIT 1")}"
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
