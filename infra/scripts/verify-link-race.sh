#!/usr/bin/env bash
# =============================================================================
#  verify-link-race.sh — race the public link, because nobody ever has
# =============================================================================
#
#  WHAT THIS PROVES
#
#  space.consume_public_link is an atomic UPDATE ... RETURNING rather than a
#  SELECT-then-UPDATE, deliberately, so that two people opening the same link
#  at the same moment cannot both get the last permitted download.
#
#  Space's fault matrix, entry #4, on that design:
#
#      "Unknown: nothing — and that is the point. The single most-defended
#       property of the public-link design has NEVER BEEN RACED. It is
#       believed correct by construction and by review, which is precisely
#       the state everything else on this list was in."
#
#  This races it. If the property holds, a link with one download remaining
#  hit by two simultaneous requests yields exactly one file and exactly one
#  refusal, and the count lands on its cap rather than past it.
#
#  If it does NOT hold, a customer who set "3 downloads" gave away 4, silently,
#  and the only evidence is a count that looks normal afterwards.
#
#  ─────────────────────────────────────────────────────────────────────────
#  IT DESTROYS NOTHING, WHICH IS WHY IT CAN RUN IN PRODUCTION
#
#  No blob is deleted, no row is removed, no service is killed. It resets a
#  test link's own counters between rounds and downloads a small file. That
#  is the whole footprint — which is what makes this one of the three faults
#  on Space's list that never needed a staging box.
#
#  The guard is the FILE NAME. The link must point at a file called
#  delete-me-test-*, so this script structurally cannot be aimed at a
#  customer's link, however it is invoked. Ten rounds is not many; a race that
#  only shows up one time in fifty is still a race, and a clean run here is
#  evidence rather than proof. Said plainly because the whole point of this
#  file is not to overclaim.
#
#  USAGE — on the server, from the repo root:
#
#      1. In Space, upload a small throwaway file named
#         delete-me-test-YYYYMMDD.txt
#      2. Create a public link on it and COPY THE LINK URL.
#      3. bash infra/scripts/verify-link-race.sh '<the url>' [rounds]
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '        · %s\n' "$1"; }
head2(){ printf '\n  %s\n  %s\n' "$1" "$(printf '%.0s─' $(seq 1 62))"; }

URL="${1:-}"
ROUNDS="${2:-10}"

if [[ -z "$URL" ]]; then
    echo "usage: $0 '<public link url>' [rounds]" >&2
    exit 2
fi
if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [[ "$ROUNDS" -lt 1 ]] || [[ "$ROUNDS" -gt 200 ]]; then
    echo "rounds must be a number between 1 and 200" >&2
    exit 2
fi

# ---- 0. The token, the hash, and THE URL THAT ACTUALLY CONSUMES -------------
# SpaceLinkEndpoints.HashToken: lowercase hex SHA-256 of the token. Computed
# here rather than asked for, so the operator pastes the thing they already
# have — a URL — instead of looking anything up.
TOKEN="${URL##*/}"
TOKEN="${TOKEN%%\?*}"
if [[ -z "$TOKEN" || "$TOKEN" == "$URL" && "$URL" != */* ]]; then
    bad "could not read a token from that URL"
    exit 2
fi
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)

# THE FIRST RUN OF THIS SCRIPT RACED THE WRONG DOOR, and reported 10/10
# failures against code that was working. The URL a person copies —
# space.tatvaos.com/l/{token} — is the LANDING PAGE, served by the web app:
# 200, some HTML, consumes nothing. The download that actually runs the
# atomic UPDATE is /api/space/l/{token}, behind an <a href> on that page.
#
# Both requests got 200 (the landing page is happy to render twice) and the
# count stayed 0, which read as "the cap is not being enforced" when the
# truth was "nothing was tested". The count staying ZERO was the tell — a
# genuine race failure leaves it at 1 or 2 — and the calibration round below
# now checks exactly that before any conclusion is allowed out of this file.
HOST_PART="${URL%%/l/*}"
RACE_URL="${HOST_PART}/api/space/l/${TOKEN}"

head2 "locating postgres"
PG=$(docker ps --format '{{.Names}}' | grep postgres | head -1)
[[ -n "$PG" ]] && ok "container: $PG" || { bad "no postgres container"; exit 1; }
PSQL=(docker exec -i "$PG" psql -U postgres -d tatvaos_mail -tAF'|')

# ---- 1. The guard: whose link is this? --------------------------------------
head2 "the link"
ROW=$("${PSQL[@]}" -c "
    select f.name, l.id, f.id
      from space.public_links l
      join space.files f on f.id = l.file_id
     where l.token_hash = '${HASH}';" 2>/dev/null)

if [[ -z "$ROW" ]]; then
    bad "no link matches that URL"
    info "check the URL, and that the link has not been deleted"
    exit 1
fi

IFS='|' read -r NAME LINK_ID FILE_ID <<< "$ROW"

if [[ "$NAME" != delete-me-test-* ]]; then
    bad "REFUSING: that link points at '$NAME'"
    info "this script resets a link's download counters. The delete-me-test-*"
    info "prefix is what makes it impossible to aim at a customer's link."
    exit 2
fi
ok "link on '$NAME' — a test file, safe to reset"
info "linkId  $LINK_ID"

# A revoked or expired link refuses before it ever reaches the atomic UPDATE,
# so every round would 'pass' by refusing both requests — the exact false-pass
# shape that nearly cost us the storage-loss result on 21 August.
USABLE=$("${PSQL[@]}" -c "
    select (revoked_at is null and expires_at > now())
      from space.public_links where id = '${LINK_ID}';")
if [[ "$USABLE" != "t" ]]; then
    bad "that link is revoked or expired"
    info "both requests would be refused for the wrong reason and this would"
    info "read as a pass while testing nothing. Refusing."
    exit 1
fi
ok "link is live — the race can actually be reached"

# ---- 2. CALIBRATION: does one request move the count by one? ----------------
#
# The guard this script was missing on its first outing. If a single plain
# request does not take the count from 0 to 1, then whatever URL is being hit
# does not consume — and every "result" after this point would be a statement
# about the wrong endpoint. Refusing here is the difference between a test
# and a rumour.
head2 "calibration — one request must consume exactly one download"

"${PSQL[@]}" -c "
    update space.public_links
       set download_count = 0, max_downloads = null
     where id = '${LINK_ID}';" >/dev/null

CAL_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$RACE_URL")
CAL_COUNT=$("${PSQL[@]}" -c "
    select download_count from space.public_links where id = '${LINK_ID}';")

if [[ "$CAL_CODE" != "200" || "$CAL_COUNT" != "1" ]]; then
    bad "calibration failed: HTTP $CAL_CODE, count went 0 -> $CAL_COUNT (expected 200 and 1)"
    info "the URL being raced does not consume a download, so racing it would"
    info "test nothing and report it confidently. Endpoint tried:"
    info "$RACE_URL"
    exit 1
fi
ok "one request, one download consumed — the endpoint under test is the real one"

# ---- 3. Race it -------------------------------------------------------------
head2 "racing $ROUNDS rounds, two simultaneous requests each"

WON=0; LOST=0; BROKEN=0

for ((i = 1; i <= ROUNDS; i++)); do
    # Exactly one download remaining, every round.
    "${PSQL[@]}" -c "
        update space.public_links
           set download_count = 0, max_downloads = 1
         where id = '${LINK_ID}';" >/dev/null

    # Launched as close together as bash allows. The serialisation point is
    # the UPDATE inside Postgres, so what matters is that both requests are
    # in flight before either commits.
    A=/tmp/race-a.$$; B=/tmp/race-b.$$
    curl -s -o /dev/null -w '%{http_code}' "$RACE_URL" > "$A" &
    PID_A=$!
    curl -s -o /dev/null -w '%{http_code}' "$RACE_URL" > "$B" &
    PID_B=$!
    wait $PID_A $PID_B

    CODE_A=$(cat "$A"); CODE_B=$(cat "$B"); rm -f "$A" "$B"

    COUNT=$("${PSQL[@]}" -c "
        select download_count from space.public_links where id = '${LINK_ID}';")

    SUCCESSES=0
    [[ "$CODE_A" == "200" ]] && SUCCESSES=$((SUCCESSES + 1))
    [[ "$CODE_B" == "200" ]] && SUCCESSES=$((SUCCESSES + 1))

    # BOTH conditions, and the count is the one that matters: a request can be
    # refused after the count was already taken, which would still be an
    # over-count and would still be a bug.
    if [[ "$SUCCESSES" -eq 1 && "$COUNT" -eq 1 ]]; then
        WON=$((WON + 1))
        printf '  \033[32mok\033[0m    round %-3s %s/%s, count %s\n' "$i" "$CODE_A" "$CODE_B" "$COUNT"
    else
        BROKEN=$((BROKEN + 1))
        printf '  \033[31mFAIL\033[0m  round %-3s %s/%s, count %s\n' "$i" "$CODE_A" "$CODE_B" "$COUNT"
        if [[ "$SUCCESSES" -gt 1 ]]; then
            info "BOTH requests got the file. The cap is not being enforced."
        elif [[ "$SUCCESSES" -eq 0 ]]; then
            info "NEITHER got the file — a person would have lost a download to nothing."
        fi
        [[ "$COUNT" -gt 1 ]] && info "count went past the cap: a customer's limit was exceeded."
    fi
    LOST=$((LOST + 0))
done

# Leave it usable rather than exhausted, so a re-run does not need a new link.
"${PSQL[@]}" -c "
    update space.public_links set download_count = 0 where id = '${LINK_ID}';" >/dev/null

# ---- 3. Verdict -------------------------------------------------------------
head2 "verdict"
if [[ "$BROKEN" -eq 0 ]]; then
    ok "$WON/$ROUNDS rounds: exactly one download, count stopped at the cap"
    info "the atomic UPDATE holds under concurrency — measured, not assumed"
    info "EVIDENCE, NOT PROOF: a race that appears once in fifty would survive"
    info "$ROUNDS rounds. Re-run with a higher count before relying on this."
    exit 0
fi

bad "$BROKEN/$ROUNDS rounds broke the cap"
info "a customer setting a download limit is not getting the limit they set"
exit 1
