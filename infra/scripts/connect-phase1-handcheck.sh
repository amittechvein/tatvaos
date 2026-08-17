#!/usr/bin/env bash
# ============================================================================
#  Connect Phase 1 — the signed-in checks, which no automated gate can fake.
#
#      bash infra/scripts/connect-phase1-handcheck.sh you@yourdomain.com
#
#  Prompts for the password. It is never echoed, never written to disk, and
#  never passed on a command line where `ps` could read it.
#
#  ─────────────────────────────────────────────────────────────────────────
#   THIS ONE WRITES. It creates ONE real meeting in your own tenant — which
#   is not test litter, it is a person using the product, and it is the only
#   way to exercise the code path. It does NOT delete it, because you will
#   want to join it; the cancel command is printed at the end.
#  ─────────────────────────────────────────────────────────────────────────
#
#  What it is really for: `GET /api/connect/meetings` is the one query nothing
#  has run. Phase 1 was deployed straight to production, so no local stack and
#  no CI job ever asked EF Core to translate `mineIds.Contains(m.Id)` or the
#  three `range` branches into SQL. A translation failure is a 500 the first
#  time a human loads /connect. All three branches are called below, on
#  purpose — they build three different queries, and `today` is the shakiest
#  because it compares against a client-evaluated date.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

EMAIL="${1:-}"
[ -n "$EMAIL" ] || { echo "usage: bash infra/scripts/connect-phase1-handcheck.sh <email>"; exit 2; }

ENV_FILE=infra/docker/.env
DOM=$(grep -E '^CONNECT_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
# SITE_DOMAIN, the same variable deploy.sh prints as "App" — the core host is
# where /api/* is served from, not the connect subdomain.
CORE=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
API="https://${CORE:-core.tatvaos.com}/api"

PASSED=0; FAILED=0
ok()  { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

# A flat-JSON string field. No jq dependency: this box may not have it, and a
# missing tool would look exactly like a failing endpoint.
jstr() {
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 |
        sed 's/.*:[[:space:]]*"//; s/"$//'
}
# Body and status in one request. Splitting them into two calls would ask the
# server twice and let the two answers disagree.
call() {
    local method="$1" url="$2" data="${3:-}" auth="${4:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 20)
    [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

# ---------------------------------------------------------------------------
printf 'Password for %s: ' "$EMAIL"
stty -echo 2>/dev/null; read -r PASS; stty echo 2>/dev/null; echo

echo
echo "== signing in =="
# The password is fed to curl on STDIN, not in the argv, so it never appears
# in the process list of a shared box.
r=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASS" |
    curl -s -X POST -w '\n%{http_code}' --max-time 20 \
         -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
unset PASS
code=$(status "$r"); payload=$(body "$r")
TOKEN=$(printf '%s' "$payload" | jstr accessToken)

if [ "$code" != "200" ] || [ -z "$TOKEN" ]; then
    bad "login returned $code"
    echo "        $payload"
    echo
    echo "If this says MFA or a password change is required, finish that in the"
    echo "browser first — this script deliberately does not implement those flows."
    exit 1
fi
ok "signed in"

# ---------------------------------------------------------------------------
echo
echo "== create a meeting =="
r=$(call POST "$API/connect/meetings" '{"title":"Phase 1 check"}' "$TOKEN")
code=$(status "$r"); payload=$(body "$r")
ID=$(printf '%s' "$payload" | jstr id)
CODE=$(printf '%s' "$payload" | jstr code)

if [ "$code" = "201" ] && [ -n "$ID" ] && [ ${#CODE} -eq 22 ]; then
    ok "201, id $ID, 22-char code $CODE"
else
    bad "expected 201 with an id and a 22-char code, got $code"
    echo "        $payload"
    echo "        Nothing below can run without a meeting. Stopping."
    exit 1
fi

# ---------------------------------------------------------------------------
echo
echo "== list meetings — THE untested query, all three branches =="
for range in upcoming today past; do
    r=$(call GET "$API/connect/meetings?range=$range" '' "$TOKEN")
    code=$(status "$r")
    if [ "$code" = "200" ]; then
        ok "range=$range → 200"
    else
        bad "range=$range → $code — if this is 500, EF could not translate the query"
        printf '        %s\n' "$(body "$r" | head -c 400)"
    fi
done

r=$(call GET "$API/connect/meetings?range=nonsense" '' "$TOKEN")
[ "$(status "$r")" = "400" ] && ok "an unknown range is refused, not guessed at" \
                             || bad "range=nonsense returned $(status "$r"), expected 400"

# ---------------------------------------------------------------------------
echo
echo "== read it back =="
r=$(call GET "$API/connect/meetings/$ID" '' "$TOKEN")
[ "$(status "$r")" = "200" ] && ok "GET /meetings/{id} → 200" || bad "GET /meetings/{id} → $(status "$r")"

r=$(call GET "$API/connect/meetings/$ID/participants" '' "$TOKEN")
[ "$(status "$r")" = "200" ] && ok "participants → 200" || bad "participants → $(status "$r")"

# A meeting id that is well-formed but not ours must be 404, never 403:
# 403 would confirm the row exists in somebody else's tenant.
r=$(call GET "$API/connect/meetings/00000000-0000-0000-0000-000000000001" '' "$TOKEN")
[ "$(status "$r")" = "404" ] && ok "a meeting we cannot see is 404, not 403" \
                             || bad "an invisible meeting returned $(status "$r") — 403 would confirm it exists"

# ---------------------------------------------------------------------------
echo
echo "== mint a join token =="
r=$(call POST "$API/connect/meetings/$ID/join" '{}' "$TOKEN")
code=$(status "$r"); payload=$(body "$r")
LKTOKEN=$(printf '%s' "$payload" | jstr token)
WSURL=$(printf '%s' "$payload" | jstr wsUrl)

if [ "$code" = "200" ] && [ -n "$LKTOKEN" ]; then
    ok "200, token minted, wsUrl $WSURL"
    case "$WSURL" in
        */rtc|*/rtc/) bad "wsUrl ends in /rtc — livekit-client appends /rtc/v1 itself, so this becomes /rtc/rtc/v1 and 401s" ;;
        wss://*)      ok "wsUrl is an origin, not a path — correct for livekit-client" ;;
        *)            bad "wsUrl is '$WSURL', expected a wss:// origin" ;;
    esac
else
    bad "join returned $code"
    echo "        $payload"
fi

# ---------------------------------------------------------------------------
echo
echo "== the guest doorstep, signed out =="
r=$(call GET "https://${DOM}/api/connect/g/$CODE")
code=$(status "$r"); payload=$(body "$r")
if [ "$code" = "200" ] && printf '%s' "$payload" | grep -q 'Phase 1 check'; then
    ok "a real code answers 200 with the title"
else
    bad "the doorstep returned $code for a code that exists"
    echo "        $payload"
fi

# The failure sentence must be byte-identical to the one an unknown code gets.
# Anything else lets a stranger tell a real meeting from an invented one.
r1=$(call GET "https://${DOM}/api/connect/g/ZZZZZZZZZZZZZZZZZZZZZZ")
r2=$(call GET "https://${DOM}/api/connect/g/notavalidcodeatall")
if [ "$(body "$r1")" = "$(body "$r2")" ] && [ "$(status "$r1")" = "$(status "$r2")" ]; then
    ok "unknown and malformed still answer identically ($(status "$r1"))"
else
    bad "the two failures differ — that is an oracle"
fi

# ---------------------------------------------------------------------------
echo
echo "$PASSED ok, $FAILED failed"
echo
echo "─────────────────────────────────────────────────────────────────────"
echo "Now the part a script cannot do. Open:"
echo "    https://${DOM}/connect/dev"
echo "and paste this token:"
echo
echo "$LKTOKEN"
echo
echo "Join, then run this — it must gain rows, exactly one per event however"
echo "many times LiveKit retries:"
echo
echo "    docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env exec -T postgres psql -U postgres -d tatvaos_mail -c \"SELECT kind, count(*) FROM connect.meeting_events GROUP BY 1 ORDER BY 1\""
echo
echo "Empty means the webhook never arrived: the meeting works and attendance"
echo "does not exist. Check: docker compose ... logs --tail 40 api | grep -i webhook"
echo
echo "When you are done, cancel the meeting:"
echo "    curl -X DELETE -H 'Authorization: Bearer <token>' $API/connect/meetings/$ID"
echo "─────────────────────────────────────────────────────────────────────"
[ "$FAILED" -eq 0 ]
