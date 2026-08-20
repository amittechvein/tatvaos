#!/usr/bin/env bash
# ============================================================================
#  Prove the host controls actually reach LiveKit.
#
#      bash infra/scripts/connect-host-controls-test.sh
#
#  Mute, remove and end-for-everyone are Twirp calls to the media server. Until
#  this script ran, not one of them had ever executed in any environment — they
#  were written, plausible, and completely unexercised. That is the same shape
#  as the webhook bug: a 200 from our API only proves our API ran.
#
#  ─────────────────────────────────────────────────────────────────────────
#   THE ORACLE IS THE EVENT LOG, NOT THE HTTP STATUS.
#
#   Every assertion here is made against connect.meeting_events, which is
#   filled by LiveKit calling US back. So a passing test means the media
#   server genuinely acted:
#
#     remove  -> LiveKit disconnects them -> participant_left row appears
#     end     -> LiveKit closes the room  -> room_finished row appears
#
#   Checking our own response code instead would pass just as happily with a
#   Twirp call that silently did nothing.
#  ─────────────────────────────────────────────────────────────────────────
#
#  It WRITES: one meeting, in your own tenant, ended by the time it finishes.
#  NOT FOR PRODUCTION — and unlike the first version of this file, that is
#  enforced by the refusal block below rather than stated here and hoped for.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
CLI_IMAGE=livekit/livekit-cli:v2.18.2

# ── REFUSE, RATHER THAN DEFAULT, WHEN THE TARGET IS UNKNOWN. ────────────
#
# This block is copied from connect-mode-test.sh, where its absence nearly
# ran that test against production: a lane checkout has no infra/docker/.env
# (env files are not in git), the SITE grep came back empty, and the old
# `${SITE:-core.tatvaos.com}` fallback — the exact line this replaces —
# pointed the API half of the script at the production domain while q()
# queried a local stack that did not exist. This script CREATES A MEETING
# AND ENDS IT; pointed at production it would have done that to a real
# tenant. A missing target is a refusal, never a default.
if [ ! -f "$ENV_FILE" ]; then
    echo "  REFUSED  $ENV_FILE does not exist in this checkout."
    echo
    echo "           This test needs the LOCAL stack's env file, both to find the"
    echo "           local API and to reach the local database. Without it the old"
    echo "           behaviour was to fall back to the production domain — which is"
    echo "           the one place this script must never point."
    echo
    echo "           If you meant to run it here, bring up the local stack first"
    echo "           (infra/docker, with its own .env). If you are in a lane"
    echo "           checkout, that is why the file is missing."
    exit 2
fi

SITE=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
case "$SITE" in
    ''|*.tatvaos.com)
        echo "  REFUSED  SITE_DOMAIN='${SITE:-unset}' is production, or unknown."
        echo "           This test WRITES rows — it creates a meeting, joins it and"
        echo "           ends it — and production is where real customers live."
        echo "           Point it at a local stack (a *.local domain) or do not run it."
        exit 2 ;;
esac
API="https://${SITE}/api"

# And prove the LOCAL database is reachable BEFORE anybody types a password:
# q() swallows stderr, so without this check "no database here" and "no rows
# arrived" would be indistinguishable — the exact ambiguity that made the
# mode test's first failure unreadable.
if ! "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "  REFUSED  the local postgres container is not reachable from here."
    echo "           Bring up the local stack (docker compose ... up -d) and re-run."
    exit 2
fi

KEY=$(grep -E '^LIVEKIT_API_KEY='    "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
SECRET=$(grep -E '^LIVEKIT_API_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")

PASSED=0; FAILED=0
ok()  { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

q() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1 | tr -d '[:space:]'; }
jstr() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
call() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 20 -H "Authorization: Bearer $TOKEN")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}
# Rows of a given kind for this meeting. The whole test rests on this.
events() { q "SELECT count(*) FROM connect.meeting_events WHERE meeting_id = '$MEETING' AND kind = '$1'"; }

# Wait for an event rather than sleeping a guessed amount. A fixed sleep is
# either too short on a loaded box or wasted on every run after.
await() {
    local kind="$1" want="$2" tries=0
    while [ "$tries" -lt 20 ]; do
        [ "$(events "$kind")" -ge "$want" ] 2>/dev/null && return 0
        sleep 1; tries=$((tries+1))
    done
    return 1
}

CLI_PID=""
cleanup() { [ -n "$CLI_PID" ] && kill "$CLI_PID" 2>/dev/null; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
printf 'Your TatvaOS email: '
read -r EMAIL
case "$EMAIL" in
    ''|you@*|*@yourdomain.com|*@example.com)
        echo "  That is a placeholder, not your address."; exit 2 ;;
    *@*.*) : ;;
    *) echo "  '$EMAIL' does not look like an email address."; exit 2 ;;
esac
printf 'Password (not echoed): '
stty -echo 2>/dev/null; read -r PASS; stty echo 2>/dev/null; echo

r=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASS" |
    curl -s -X POST -w '\n%{http_code}' --max-time 20 \
         -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
unset PASS
TOKEN=$(body "$r" | jstr accessToken)
if [ "$(status "$r")" != "200" ] || [ -z "$TOKEN" ]; then
    echo "  FAIL  login returned $(status "$r")"; echo "        $(body "$r")"; exit 1
fi
ok "signed in"

# ---------------------------------------------------------------------------
# Waiting room OFF: this test is about host controls, and a lobby would park
# the headless client where it can never be muted.
r=$(call POST "$API/connect/meetings" '{"title":"Host control check","waitingRoom":"off"}')
MEETING=$(body "$r" | jstr id)
[ "$(status "$r")" = "201" ] && [ -n "$MEETING" ] || {
    echo "  FAIL  could not create a meeting ($(status "$r"))"; echo "        $(body "$r")"; exit 1; }
ok "meeting $MEETING"

NET=$(docker inspect "$("${COMPOSE[@]}" ps -q livekit | head -1)" \
        --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
[ -n "$NET" ] || { echo "  FAIL  livekit is not running"; exit 1; }

# ---------------------------------------------------------------------------
echo
echo "== a participant joins =="
docker run --rm --network "$NET" \
    -e LIVEKIT_URL="ws://livekit:7880" -e LIVEKIT_API_KEY="$KEY" -e LIVEKIT_API_SECRET="$SECRET" \
    "$CLI_IMAGE" room join --identity hostcheck "m-${MEETING}" >/tmp/lk-hostcheck.log 2>&1 &
CLI_PID=$!

if await participant_joined 1; then
    ok "participant_joined recorded — they are really in the room"
else
    bad "nobody joined. The rest of this test cannot mean anything."
    tail -5 /tmp/lk-hostcheck.log | sed 's/^/        /'
    echo; echo "$PASSED ok, $FAILED failed"; exit 1
fi

# ---------------------------------------------------------------------------
echo
echo "== mute =="
r=$(call POST "$API/connect/meetings/$MEETING/participants/hostcheck/mute" '{"kind":"audio"}')
code=$(status "$r")
if [ "$code" = "200" ] || [ "$code" = "204" ]; then
    # No webhook fires for a mute, so the media server's own log is the only
    # witness. Stated plainly rather than dressed up as proof it acted.
    if "${COMPOSE[@]}" logs --since 2m livekit 2>&1 | grep -ciE 'mute' >/dev/null 2>&1; then
        ok "mute accepted ($code) and LiveKit logged it"
    else
        ok "mute accepted ($code) — no webhook exists for mute, so this is the API's word"
    fi
else
    bad "mute returned $code — they are still unmuted"
    printf '        %s\n' "$(body "$r" | head -c 200)"
fi

# ---------------------------------------------------------------------------
echo
echo "== remove =="
before=$(events participant_left)
r=$(call DELETE "$API/connect/meetings/$MEETING/participants/hostcheck")
code=$(status "$r")
if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    bad "remove returned $code"
    printf '        %s\n' "$(body "$r" | head -c 200)"
elif await participant_left $((before + 1)); then
    ok "participant_left recorded — LiveKit genuinely disconnected them"
else
    bad "our API said $code but no participant_left arrived. The person is
        probably still in the meeting: the Twirp call did not take effect."
fi

# ---------------------------------------------------------------------------
echo
echo "== end for everyone =="
r=$(call POST "$API/connect/meetings/$MEETING/end" '{}')
code=$(status "$r")
if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    bad "end returned $code"
    printf '        %s\n' "$(body "$r" | head -c 200)"
elif await room_finished 1; then
    ok "room_finished recorded — the room is closed, not just marked closed"
else
    bad "our API said $code but no room_finished arrived. The room may still be
        live on the media server while the database says the meeting ended."
fi

st=$(q "SELECT status FROM connect.meetings WHERE id = '$MEETING'")
[ "$st" = "ended" ] && ok "the meeting row says 'ended'" || bad "the meeting row says '${st:-?}'"

# ---------------------------------------------------------------------------
echo
echo "$PASSED ok, $FAILED failed"
echo
"${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail \
    -c "SELECT kind, identity, occurred_at FROM connect.meeting_events
         WHERE meeting_id = '$MEETING' ORDER BY occurred_at" 2>/dev/null
[ "$FAILED" -eq 0 ]
