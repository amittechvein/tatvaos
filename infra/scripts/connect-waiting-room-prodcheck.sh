#!/usr/bin/env bash
# ============================================================================
#  The waiting-room toggle, proven against a REAL deployment.
#
#      bash infra/scripts/connect-waiting-room-prodcheck.sh --production
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THIS FILE EXISTS AT ALL, GIVEN connect-waiting-room-test.sh.
#
#   That script is the full proof — the one-shot claim, the no-oracle rule,
#   the lock, the toggle — and it needs a LOCAL STACK, because it reads the
#   database directly and because it refuses production by design.
#
#   There is no local stack. Meeting mode shipped the same way: the reviewer
#   substituted a short sequence of calls against the real endpoints and
#   pasted the output. This file is that substitution, written down instead
#   of typed each time, so the check is repeatable and the assertions cannot
#   drift with whoever is running it.
#
#   It is HTTP ONLY. No docker, no psql, no compose — it can run from the box
#   or from a laptop, which is exactly why the guard below is not optional.
#  ─────────────────────────────────────────────────────────────────────────
#
#  THE ONE ASSERTION THAT CARRIES THE FEATURE, and it is the negative one:
#  after 'everyone' -> 'guests', a parked GUEST must STILL BE WAITING. A
#  release that fires on any change rather than reading the new setting
#  passes every other check here and fails that one.
#
#  It WRITES, in your own tenant: one meeting and two guest rows. The meeting
#  is ended on the way out, including when a check fails.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

PRODUCTION=0
for a in "$@"; do
    case "$a" in
        --production) PRODUCTION=1 ;;
        *) echo "  Unknown argument '$a'. This script takes --production and nothing else."
           exit 2 ;;
    esac
done

ENV_FILE=infra/docker/.env

# ── REFUSE, RATHER THAN DEFAULT, WHEN THE TARGET IS UNKNOWN. ────────────
# Same block as its sibling scripts. This one has a legitimate production
# use — it is the only way to prove the toggle without a local stack — so
# production is reachable, but only with intent stated twice: once in the
# command, once by hand at the prompt.
if [ ! -f "$ENV_FILE" ]; then
    echo "  REFUSED  $ENV_FILE does not exist in this checkout."
    echo "           Without it there is nothing to point at except a guess,"
    echo "           and a guess once pointed a sibling of this script at"
    echo "           production. Run this on the box, or on a machine with a"
    echo "           stack of its own."
    exit 2
fi

SITE=$(grep -E '^SITE_DOMAIN='    "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
DOM=$(grep -E '^CONNECT_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
[ -n "$SITE" ] || { echo "  REFUSED  SITE_DOMAIN is unset in $ENV_FILE."; exit 2; }
[ -n "$DOM" ]  || { echo "  REFUSED  CONNECT_DOMAIN is unset in $ENV_FILE."; exit 2; }

case "$SITE" in
    *.tatvaos.com)
        if [ "$PRODUCTION" -ne 1 ]; then
            echo "  REFUSED  SITE_DOMAIN='$SITE' is production."
            echo "           This script creates a real meeting and two guest rows"
            echo "           in your own tenant. If you mean it, re-run with"
            echo "           --production and type the domain when asked."
            exit 2
        fi
        echo "  This is PRODUCTION ($SITE)."
        echo "  It will create one meeting titled 'Waiting room toggle check',"
        echo "  knock on it twice as a guest, and end it. Nothing else is touched,"
        echo "  and nothing outside your own organisation is visible to it."
        printf '  Type the full domain to continue: '
        read -r TYPED
        [ "$TYPED" = "$SITE" ] || { echo "  REFUSED  '$TYPED' does not match '$SITE'. Nothing was run."; exit 2; }
        ;;
esac

API="https://${SITE}/api"
GUEST="https://${DOM}/api/connect/g"

PASSED=0; FAILED=0
ok()  { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

jstr()   { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
authed() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 25 -H "Authorization: Bearer $TOKEN")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}
anon() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 25)
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
    curl -s -X POST -w '\n%{http_code}' --max-time 25 \
         -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
unset PASS
TOKEN=$(body "$r" | jstr accessToken)
[ "$(status "$r")" = "200" ] && [ -n "$TOKEN" ] || {
    echo "  FAIL  login returned $(status "$r")"; echo "        $(body "$r")"; exit 1; }
ok "signed in"

# ---------------------------------------------------------------------------
r=$(authed POST "$API/connect/meetings" \
     '{"title":"Waiting room toggle check","waitingRoom":"everyone","allowGuests":true}')
MEETING=$(body "$r" | jstr id)
CODE=$(body "$r" | jstr code)
[ "$(status "$r")" = "201" ] && [ -n "$MEETING" ] && [ -n "$CODE" ] || {
    echo "  FAIL  create returned $(status "$r")"; echo "        $(body "$r")"; exit 1; }
ok "meeting created, waiting room 'everyone'"

finish() {
    [ -n "${MEETING:-}" ] && authed POST "$API/connect/meetings/$MEETING/end" '{}' >/dev/null 2>&1
    return 0
}
trap finish EXIT

# ---------------------------------------------------------------------------
echo
echo "== a guest knocks and is parked =="
r=$(anon POST "$GUEST/$CODE/join" '{"displayName":"Toggle Check Guest"}')
WAITTOK=$(body "$r" | jstr waitToken)
ST=$(body "$r" | jstr status)
if [ "$ST" = "waiting" ] && [ -n "$WAITTOK" ]; then
    ok "parked in the waiting room"
else
    # A 404 here is very likely the organisation-wide guest switch, not this
    # feature — and calling that a FAIL would be a wrong answer stated
    # confidently. Named as inconclusive instead, with the way to tell.
    if [ "$(status "$r")" = "404" ]; then
        echo "  INCONCLUSIVE  the guest door answered 'this link does not work'."
        echo "                That one sentence covers several causes, and the"
        echo "                likeliest by far is core.tenants.allow_connect_guests"
        echo "                being false for your organisation — in which case"
        echo "                guests are refused everywhere and this check cannot"
        echo "                run at all. It is NOT evidence about the toggle."
    else
        bad "guest join returned status '$ST' ($(status "$r")) — expected 'waiting'"
        printf '        %s\n' "$(body "$r")"
    fi
    echo; echo "$PASSED ok, $FAILED failed"; exit 1
fi

st=$(body "$(anon GET "$GUEST/wait/$WAITTOK")" | jstr status)
[ "$st" = "waiting" ] && ok "polling says still waiting" \
    || bad "poll said '$st' before anybody admitted them"

# ---------------------------------------------------------------------------
echo
echo "== THE CONTROL CASE: 'everyone' -> 'guests' must NOT free a guest =="
authed PATCH "$API/connect/meetings/$MEETING" '{"waitingRoom":"guests"}' >/dev/null
sleep 1
st=$(body "$(anon GET "$GUEST/wait/$WAITTOK")" | jstr status)
if [ "$st" = "waiting" ]; then
    ok "the parked GUEST is still waiting — the release read the new setting"
else
    bad "the guest's status became '$st'. The release is firing on ANY change
        instead of reading the new setting: 'guests' still parks guests, so
        this person should not have moved."
fi

# ---------------------------------------------------------------------------
echo
echo "== the host opens the door mid-meeting =="
authed PATCH "$API/connect/meetings/$MEETING" '{"waitingRoom":"off"}' >/dev/null
sleep 1
r=$(anon GET "$GUEST/wait/$WAITTOK")
st=$(body "$r" | jstr status); tok=$(body "$r" | jstr token)
if [ "$st" = "admitted" ] && [ -n "$tok" ]; then
    ok "the person already waiting was admitted, with a token"
else
    bad "after the waiting room was turned off, the parked guest saw '$st'.
        Before this feature that was the behaviour: they waited forever on a
        door that no longer existed."
    printf '        %s\n' "$(body "$r")"
fi

# The seat is one-shot whichever way the admission happened — worth asserting
# here too, because this admission took a different route to the same row.
tok2=$(body "$(anon GET "$GUEST/wait/$WAITTOK")" | jstr token)
[ -z "$tok2" ] && ok "the wait token yields nothing the second time — one-shot holds" \
    || bad "SECURITY: the wait token minted a SECOND seat after a bulk admit."

# ---------------------------------------------------------------------------
echo
echo "== and the setting still governs the next arrival =="
r=$(anon POST "$GUEST/$CODE/join" '{"displayName":"Walk-in Check"}')
st=$(body "$r" | jstr status); tok=$(body "$r" | jstr token)
if [ "$st" = "joined" ] && [ -n "$tok" ]; then
    ok "with the waiting room off, a new guest joins directly"
else
    bad "waiting room is off but a new guest got '$st' ($(status "$r"))"
    printf '        %s\n' "$(body "$r")"
fi

echo
echo "$PASSED ok, $FAILED failed"
echo "(the meeting is ended on the way out)"
[ "$FAILED" -eq 0 ]
