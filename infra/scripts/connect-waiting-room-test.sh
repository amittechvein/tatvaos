#!/usr/bin/env bash
# ============================================================================
#  The guest path, end to end — the part Core has to review.
#
#      bash infra/scripts/connect-waiting-room-test.sh
#
#  Doorstep → guest join → parked in the waiting room → host admits → the
#  guest collects ONE token. Then the same wait token is presented a second
#  time and must come back empty.
#
#  ─────────────────────────────────────────────────────────────────────────
#   THE ONE-SHOT CLAIM IS THE POINT.
#
#   connect.claim_lobby_admission is an UPDATE-as-check: the row moves to
#   'claimed' only if every condition still holds at the instant of the write,
#   and the RETURNING says whether this caller won. So two polls racing cannot
#   both be handed a seat, and a stolen wait token cannot be replayed into a
#   second one after the real guest has used it.
#
#   That property has never been exercised outside a sandbox. It is the whole
#   security argument for the waiting room, so it is asserted here explicitly.
#  ─────────────────────────────────────────────────────────────────────────
#
#  Also asserted: a denied guest is told "denied" and gets no token, and every
#  failure answers with the SAME sentence — the no-oracle rule.
#
#  It WRITES: one meeting and two guest participant rows, in your own tenant.
#  The meeting is ended at the finish.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
SITE=$(grep -E '^SITE_DOMAIN='    "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
DOM=$(grep -E '^CONNECT_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
API="https://${SITE:-core.tatvaos.com}/api"
GUEST="https://${DOM:-connect.tatvaos.com}/api/connect/g"

PASSED=0; FAILED=0
ok()  { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

q() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1 | tr -d '[:space:]'; }
jstr() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
authed() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 20 -H "Authorization: Bearer $TOKEN")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}
anon() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 20)
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}

# ---------------------------------------------------------------------------
printf 'Your TatvaOS email: '
read -r EMAIL
case "$EMAIL" in
    ''|you@*|*@yourdomain.com|*@example.com) echo "  That is a placeholder."; exit 2 ;;
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
[ "$(status "$r")" = "200" ] && [ -n "$TOKEN" ] || {
    echo "  FAIL  login returned $(status "$r")"; echo "        $(body "$r")"; exit 1; }
ok "signed in"

# The organisation-wide kill switch. If this is off, every guest is refused no
# matter what the meeting says — and the refusal looks identical to a bad code,
# which would make the rest of this test fail for a reason worth naming now.
GUESTS_ON=$(q "SELECT allow_connect_guests FROM core.tenants t
                JOIN core.users u ON u.tenant_id = t.id
               WHERE u.email = '$(printf '%s' "$EMAIL" | sed "s/'/''/g")'")
if [ "$GUESTS_ON" != "t" ]; then
    echo "  NOTE  core.tenants.allow_connect_guests is '${GUESTS_ON:-unset}' for your"
    echo "        organisation, so guests are refused org-wide and every check below"
    echo "        would fail for that reason alone. Turn it on to run this test:"
    echo "          UPDATE core.tenants SET allow_connect_guests = true WHERE id = ...;"
    exit 1
fi
ok "guests are allowed for this organisation"

# ---------------------------------------------------------------------------
r=$(authed POST "$API/connect/meetings" \
     '{"title":"Waiting room check","waitingRoom":"everyone","allowGuests":true}')
MEETING=$(body "$r" | jstr id)
CODE=$(body "$r" | jstr code)
[ "$(status "$r")" = "201" ] && [ -n "$MEETING" ] || {
    echo "  FAIL  create returned $(status "$r")"; echo "        $(body "$r")"; exit 1; }
ok "meeting $MEETING, code $CODE"

finish() {
    [ -n "${MEETING:-}" ] && authed POST "$API/connect/meetings/$MEETING/end" '{}' >/dev/null 2>&1
    return 0
}
trap finish EXIT

# ---------------------------------------------------------------------------
echo
echo "== the doorstep, with no session at all =="
r=$(anon GET "$GUEST/$CODE")
if [ "$(status "$r")" = "200" ] && printf '%s' "$(body "$r")" | grep -q 'Waiting room check'; then
    ok "a real code answers 200 with the title"
else
    bad "doorstep returned $(status "$r") for a code that exists"
    printf '        %s\n' "$(body "$r")"
fi

# Every failure is the same sentence. Three different reasons, one answer.
a=$(body "$(anon GET "$GUEST/ZZZZZZZZZZZZZZZZZZZZZZ")")
b=$(body "$(anon GET "$GUEST/notavalidshape")")
c=$(body "$(anon GET "$GUEST/${CODE}x")")
if [ "$a" = "$b" ] && [ "$b" = "$c" ] && printf '%s' "$a" | grep -q 'does not work'; then
    ok "unknown, malformed and near-miss codes are indistinguishable"
else
    bad "the failure answers differ — that is an oracle"
    printf '        unknown   %s\n        malformed %s\n        near-miss %s\n' "$a" "$b" "$c"
fi

# ---------------------------------------------------------------------------
echo
echo "== a guest knocks =="
r=$(anon POST "$GUEST/$CODE/join" '{"displayName":"Ravi Guest"}')
WAIT1=$(body "$r" | jstr waitToken)
ST=$(body "$r" | jstr status)
if [ "$ST" = "waiting" ] && [ -n "$WAIT1" ]; then
    ok "parked in the waiting room, not admitted"
else
    bad "guest join returned status '$ST' ($(status "$r")) — expected 'waiting'"
    printf '        %s\n' "$(body "$r")"
    echo; echo "$PASSED ok, $FAILED failed"; exit 1
fi

r=$(anon GET "$GUEST/wait/$WAIT1")
[ "$(body "$r" | jstr status)" = "waiting" ] && ok "polling says still waiting" \
    || bad "poll said '$(body "$r" | jstr status)' before anybody admitted them"

# ---------------------------------------------------------------------------
echo
echo "== the host sees them and lets them in =="
r=$(authed GET "$API/connect/meetings/$MEETING/lobby")
REQ=$(body "$r" | jstr requestId)
if [ -n "$REQ" ] && printf '%s' "$(body "$r")" | grep -q 'Ravi Guest'; then
    ok "the lobby lists them by name"
else
    bad "the lobby did not list the guest"
    printf '        %s\n' "$(body "$r")"
fi

r=$(authed POST "$API/connect/meetings/$MEETING/lobby/$REQ/admit")
# Written as a case rather than `[ a ] || [ b ] && ok || bad`. That chain does
# happen to evaluate correctly, but only because of how || and && associate —
# it is a line that breaks silently the next time somebody edits it.
case "$(status "$r")" in
    200|204) ok "admit accepted" ;;
    *)       bad "admit returned $(status "$r")"; printf '        %s\n' "$(body "$r")" ;;
esac

# ---------------------------------------------------------------------------
echo
echo "== the guest collects a seat, ONCE =="
r=$(anon GET "$GUEST/wait/$WAIT1")
SEAT=$(body "$r" | jstr token)
WSURL=$(body "$r" | jstr wsUrl)
if [ "$(body "$r" | jstr status)" = "admitted" ] && [ -n "$SEAT" ]; then
    ok "admitted, with a LiveKit token"
    case "$WSURL" in
        */rtc|*/rtc/) bad "wsUrl ends in /rtc — the client appends /rtc/v1 and this 401s" ;;
        wss://*)      ok "wsUrl is an origin, correct for livekit-client" ;;
        *)            bad "wsUrl is '$WSURL'" ;;
    esac
else
    bad "the admitted guest got no token"
    printf '        %s\n' "$(body "$r")"
fi

# THE assertion. The same token, again.
r=$(anon GET "$GUEST/wait/$WAIT1")
AGAIN=$(body "$r" | jstr token)
if [ -z "$AGAIN" ]; then
    ok "the same wait token yields NOTHING the second time — one-shot holds"
else
    bad "SECURITY: the wait token minted a SECOND seat. claim_lobby_admission is
        not consuming the row, so a stolen token can be replayed."
fi

# ---------------------------------------------------------------------------
echo
echo "== a second guest is turned away =="
r=$(anon POST "$GUEST/$CODE/join" '{"displayName":"Priya Guest"}')
WAIT2=$(body "$r" | jstr waitToken)
if [ -n "$WAIT2" ]; then
    r=$(authed GET "$API/connect/meetings/$MEETING/lobby")
    REQ2=$(body "$r" | jstr requestId)
    if [ -n "$REQ2" ]; then
        authed POST "$API/connect/meetings/$MEETING/lobby/$REQ2/deny" >/dev/null
        r=$(anon GET "$GUEST/wait/$WAIT2")
        st=$(body "$r" | jstr status); tok=$(body "$r" | jstr token)
        if [ "$st" = "denied" ] && [ -z "$tok" ]; then
            ok "a denied guest is told so, and gets no token"
        else
            bad "denied guest saw status '$st'${tok:+ WITH A TOKEN}"
        fi
    else
        bad "the second guest never reached the lobby"
    fi
else
    bad "the second guest could not knock"
fi

# ---------------------------------------------------------------------------
echo
echo "== the meeting locks out newcomers =="
authed PATCH "$API/connect/meetings/$MEETING" '{"locked":true}' >/dev/null
r=$(anon POST "$GUEST/$CODE/join" '{"displayName":"Late Guest"}')
if [ "$(status "$r")" = "409" ]; then
    ok "a locked meeting refuses a new guest (409)"
else
    bad "locked meeting answered $(status "$r") to a new guest"
    printf '        %s\n' "$(body "$r")"
fi

echo
echo "$PASSED ok, $FAILED failed"
echo "(the meeting is ended on the way out)"
[ "$FAILED" -eq 0 ]
