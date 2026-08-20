#!/usr/bin/env bash
# ============================================================================
#  Prove a Private meeting cannot be recorded — against the shipping endpoint
#  and a real database.
#
#      bash infra/scripts/connect-mode-test.sh
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THIS TEST EXISTS IN THIS FORM.
#
#   The migration and the entity that must agree about `mode` were written by
#   the same person, in the same afternoon. Their agreement therefore proves
#   consistency and nothing else — WORKING_IN_LANES.md, "Agreement between two
#   things you wrote is not evidence". So this test does not compare my SQL to
#   my C#. It calls the REAL endpoint over HTTP, against the REAL database,
#   and asks whether the refusal actually happens.
#
#   A UI that hides the Record button proves nothing either: assume someone
#   calls the route directly, because eventually someone will. That is exactly
#   what this script is — someone calling the route directly.
#
#   THE CONTROL CASE IS HALF THE TEST. Asserting only "private is refused"
#   would pass just as happily against an endpoint that refused EVERYTHING.
#   So a recorded meeting is put through the same call and must fail
#   DIFFERENTLY — on a later gate, with a different sentence. Without that,
#   this file would be a test of nothing.
#  ─────────────────────────────────────────────────────────────────────────
#
#  It WRITES: two meetings in your own tenant, both cancelled before it exits.
#  NOT FOR PRODUCTION — same rule as connect-webhook-test.sh and
#  connect-host-controls-test.sh.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")

# ── REFUSE, RATHER THAN DEFAULT, WHEN THE TARGET IS UNKNOWN. ────────────
#
# The first run of this script did exactly what this block now prevents. It
# was run from a lane checkout, which has no infra/docker/.env (env files are
# not in git) — so the grep below came back empty, the API fell back to the
# production domain, AND IT SIGNED IN TO PRODUCTION. It survived because the
# migration check happened to be the first assertion and production did not
# have the migration yet; had that check passed, the next step CREATES
# MEETINGS. The "NOT FOR PRODUCTION" banner at the top of this file was
# decoration — a comment cannot refuse anything. This block can.
#
# A missing target is therefore a refusal, never a default. Same rule as the
# guest path's fail-closed RLS: when you do not know who you are talking to,
# the answer is nothing, not a guess.
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
        echo "           This test WRITES rows — meetings in your own tenant — and"
        echo "           production is where real customers live. Point it at a"
        echo "           local stack (a *.local domain) or do not run it."
        exit 2 ;;
esac
API="https://${SITE}/api"

# And prove the LOCAL database is reachable BEFORE anybody types a password:
# q() swallows stderr, so without this check "no database here" and "column
# missing" would print the same FAIL — an ambiguity the first run also hit.
if ! "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "  REFUSED  the local postgres container is not reachable from here."
    echo "           Bring up the local stack (docker compose ... up -d) and re-run."
    exit 2
fi

PASSED=0; FAILED=0; WARNED=0
ok()   { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad()  { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
warn() { echo "  WARN  $1"; WARNED=$((WARNED+1)); }

q() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1 | tr -d '[:space:]'; }
jstr()   { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
call() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-s -X "$method" -w '\n%{http_code}' --max-time 20 -H "Authorization: Bearer $TOKEN")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
    curl "${args[@]}" "$url"
}

PRIVATE=""; RECORDED=""
cleanup() {
    for m in "$PRIVATE" "$RECORDED"; do
        [ -n "$m" ] && call DELETE "$API/connect/meetings/$m" >/dev/null 2>&1
    done
    return 0
}
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

echo
echo "== the migration is actually here =="
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND table_name='meetings' AND column_name='mode'")
[ "${n:-0}" -eq 1 ] || { bad "connect.meetings.mode is missing — 20260908 has not applied"; exit 1; }
ok "connect.meetings.mode present"

n=$(q "SELECT count(*) FROM pg_trigger
        WHERE tgrelid='connect.meetings'::regclass AND NOT tgisinternal
          AND tgname='trg_meetings_mode_immutable'")
[ "${n:-0}" -eq 1 ] && ok "the immutability trigger is installed" \
                    || bad "trg_meetings_mode_immutable is missing — the mode is silently mutable"

# ---------------------------------------------------------------------------
echo
echo "== a private meeting can be created =="
r=$(call POST "$API/connect/meetings" '{"title":"Mode check (private)","mode":"private","waitingRoom":"off"}')
code=$(status "$r")
if [ "$code" = "503" ]; then
    echo
    echo "  CONNECT_ROOM_KEY_SECRET is not set on this server, so private meetings"
    echo "  are switched off and the rest of this test cannot run. Set it in"
    echo "  infra/docker/.env (see .env.example) and deploy, then run this again."
    echo
    echo "  $PASSED ok, $FAILED failed — INCOMPLETE"
    exit 2
fi
PRIVATE=$(body "$r" | jstr id)
[ "$code" = "201" ] && [ -n "$PRIVATE" ] || {
    bad "creating a private meeting returned $code"; printf '        %s\n' "$(body "$r" | head -c 300)"; exit 1; }
ok "private meeting $PRIVATE"

got=$(q "SELECT mode FROM connect.meetings WHERE id='$PRIVATE'")
[ "$got" = "private" ] && ok "the database row says private, not just the response" \
                       || bad "the row says '$got' — the API and the database disagree"

# ---------------------------------------------------------------------------
echo
echo "== THE POINT OF THIS FILE: recording is refused =="
r=$(call POST "$API/connect/meetings/$PRIVATE/recordings" '{"mode":"audio"}')
code=$(status "$r"); msg=$(body "$r")
if [ "$code" = "409" ]; then
    ok "start-recording on a private meeting returned 409"
else
    bad "start-recording returned $code — expected 409"
    printf '        %s\n' "$(printf '%s' "$msg" | head -c 300)"
fi

# The REASON matters, not only the number. A 409 that said "that meeting is
# over" would be the right status for the wrong reason, and would still be a
# passing test in a version of this file that only checked the code.
case "$msg" in
    *"cannot be recorded"*) ok "and said why: it is encrypted, so it cannot be recorded" ;;
    *) bad "the 409 did not explain the mode — a right status for the wrong reason?"
       printf '        %s\n' "$(printf '%s' "$msg" | head -c 300)" ;;
esac

# And nothing was created. A refusal that still wrote a row would be worse
# than no refusal, because the row would look like a recording that failed.
n=$(q "SELECT count(*) FROM connect.recordings WHERE meeting_id='$PRIVATE'")
[ "${n:-0}" -eq 0 ] && ok "no recording row was written" \
                    || bad "${n} recording row(s) exist for a meeting that cannot be recorded"

# ---------------------------------------------------------------------------
echo
echo "== the control: a RECORDED meeting fails differently, or not at all =="
r=$(call POST "$API/connect/meetings" '{"title":"Mode check (recorded)","waitingRoom":"off"}')
RECORDED=$(body "$r" | jstr id)
[ "$(status "$r")" = "201" ] && [ -n "$RECORDED" ] || { bad "could not create the control meeting"; exit 1; }
got=$(q "SELECT mode FROM connect.meetings WHERE id='$RECORDED'")
[ "$got" = "recorded" ] && ok "defaults to recorded when no mode is sent" \
                        || bad "default mode is '$got', expected recorded"

r=$(call POST "$API/connect/meetings/$RECORDED/recordings" '{"mode":"audio"}')
code=$(status "$r"); msg=$(body "$r")
# It will almost certainly NOT succeed — nobody has joined, and the org flag
# may be off — and that is fine. What must be true is that it did not fail
# for the MODE reason, which is what proves the private refusal was specific
# rather than a blanket "no".
case "$msg" in
    *"cannot be recorded"*)
        bad "the recorded meeting got the PRIVATE refusal — the check is not mode-specific" ;;
    *)
        ok "reached a later gate ($code), not the mode gate — the refusal is specific" ;;
esac

# ---------------------------------------------------------------------------
echo
echo "== the mode cannot be changed, from either direction =="
# Through the API: the update DTO carries no mode field, so this is ignored
# rather than refused. Asserting the ROW is what matters — a 200 here means
# nothing on its own.
call PATCH "$API/connect/meetings/$PRIVATE" '{"mode":"recorded","title":"Mode check (private)"}' >/dev/null
got=$(q "SELECT mode FROM connect.meetings WHERE id='$PRIVATE'")
[ "$got" = "private" ] && ok "PATCH cannot move it: still private" \
                       || bad "the API changed the mode to '$got'"

# Through SQL, which is the case the trigger exists for: somebody at a psql
# prompt with every good intention.
err=$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail \
        -c "UPDATE connect.meetings SET mode='recorded' WHERE id='$PRIVATE';" 2>&1)
case "$err" in
    *"is immutable"*) ok "a direct UPDATE is refused by the trigger, with the reason" ;;
    *) bad "a direct UPDATE was NOT refused as expected"
       printf '        %s\n' "$(printf '%s' "$err" | head -c 300)" ;;
esac
got=$(q "SELECT mode FROM connect.meetings WHERE id='$PRIVATE'")
[ "$got" = "private" ] && ok "and the row is unchanged" || bad "the row is now '$got'"

# ---------------------------------------------------------------------------
echo
echo "== a private meeting cannot ask to auto-record =="
r=$(call POST "$API/connect/meetings" '{"title":"Mode check (bad combo)","mode":"private","autoRecord":true}')
code=$(status "$r")
[ "$code" = "400" ] && ok "creating private + auto-record is refused in words ($code)" \
                    || { bad "expected 400, got $code"
                         extra=$(body "$r" | jstr id); [ -n "$extra" ] && call DELETE "$API/connect/meetings/$extra" >/dev/null 2>&1; }

r=$(call PATCH "$API/connect/meetings/$PRIVATE" '{"autoRecord":true}')
code=$(status "$r")
[ "$code" = "400" ] && ok "and turning it on afterwards is refused too ($code)" \
                    || bad "PATCH autoRecord on a private meeting returned $code"

# ---------------------------------------------------------------------------
echo
echo "== the key is not somewhere it should never be =="
# Not proof of absence — a log line could appear later, or elsewhere. It is a
# cheap check of the places it would most likely leak, stated as what it is.
key=$(q "SELECT count(*) FROM connect.meetings WHERE id='$PRIVATE'")
if "${COMPOSE[@]}" logs --since 5m api 2>&1 | grep -qiE 'roomkey|room_key'; then
    bad "the API log mentions a room key — check ConnectRoomKey's callers"
else
    ok "the API log does not mention a room key (last 5 minutes)"
fi
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE table_schema='connect' AND column_name ILIKE '%room_key%'")
[ "${n:-0}" -eq 0 ] && ok "no column anywhere stores a room key" \
                    || bad "${n} column(s) look like they store a room key — it is meant to be derived"

echo
echo "  $PASSED ok, $FAILED failed, $WARNED warned"
[ "$FAILED" -eq 0 ] || exit 1
