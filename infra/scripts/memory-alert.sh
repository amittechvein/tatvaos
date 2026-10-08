#!/usr/bin/env bash
# ============================================================================
#  memory-alert.sh — tell Amit when the production server runs short of memory
# ============================================================================
#
#  Decision 0014 (docs/decisions/0014-memory-alert.md), built 8 Oct 2026 after
#  it turned out the decision had merged on 3 Oct but nothing had been built:
#  production had NO memory alerting while the render container's 512 MB cap
#  was measured at 343-512 MB under PDF load (docs/DOCS_PDF_DESIGN.md §10).
#  "If 0014 was never built, we would find out about that from a customer"
#  (Mr. Singh, 8 Oct).
#
#  Read-only, like disk-alert.sh, and built the same way in every respect that
#  was reviewed there: mail through the box's own Postfix to an address OFF the
#  server; once per crossing plus a daily reminder, remembered in a state
#  file; FORCE and DRYRUN modes; it FAILS LOUDLY; one log line per run. It
#  never kills, restarts or frees anything: a smoke detector, not a sprinkler.
#
#  WHAT IT WATCHES, every 5 minutes (memory runs out in the length of a
#  recording; disk fills over days, which is why that one is every 30):
#   1. Memory pressure (PSI, /proc/pressure/memory), the direct symptom:
#        warn      "some" avg300 >= 10%   something waited on memory for 30 s
#                                        or more of the last five minutes
#        critical  "full" avg300 >=  5%   EVERYTHING stalled for 15 s or more
#   2. Memory available (MemAvailable), the approach before the stall:
#        warn under 15% of total (~1.2 GB), critical under 7% (~550 MB)
#   3. A container killed for memory or restarted: OOMKilled turning true, or
#      RestartCount going UP for the same container name, compared with the
#      last run. Mailed AT ONCE, naming it: the event, not a symptom. A count
#      that goes DOWN is a deploy recreating the container, and is not an alert.
#   4. Swap is SHOWN, not alerted on. It lags: pages swapped out weeks ago stay
#      counted. It says "it happened", not "it is happening".
#
#  THE THRESHOLDS ARE A FIRST GUESS (0014): there is no history to calibrate
#  against, so for the first two weeks the one-line log below records the PSI
#  averages and available memory on every run, and the thresholds are then set
#  from what it shows.
#
#  NOT WATCHED, AND WHY: a kill by the HOST's own OOM killer, outside every
#  container's cap. The deploy user cannot read the kernel log (0014, question
#  2: joining systemd-journal is a server-account change, Amit's go). Until
#  then such a kill is visible here only if it takes a container's main
#  process with it (a restart, item 3).
#
#  Test it on purpose:  MEMORY_ALERT_FORCE=1 ./memory-alert.sh
#  sends a "[TEST]" message with today's real figures and does not touch the
#  state file, so a rehearsal never masks a real crossing.
#  Read it without sending:  MEMORY_ALERT_DRYRUN=1 ./memory-alert.sh
#  prints the message it WOULD send; nothing is mailed, state untouched, and
#  no recipient is needed.
#
#  Cost: two small file reads and one docker inspect per run; docker stats only
#  when a message is being sent.
# ============================================================================
set -u

TO="${MEMORY_ALERT_TO:-${DISK_ALERT_TO:-}}"
DRYRUN="${MEMORY_ALERT_DRYRUN:-0}"
if [ "$DRYRUN" != "1" ] && [ -z "$TO" ]; then
    echo "MEMORY_ALERT_TO (or DISK_ALERT_TO) must be set, to an address that is NOT on this server" >&2; exit 2
fi
FROM="${MEMORY_ALERT_FROM:-alerts@tatvaos.com}"
STATE="${MEMORY_ALERT_STATE:-/srv/tatvaos-production/.memory-alert-state}"
PSI="${MEMORY_ALERT_PSI:-/proc/pressure/memory}"
MEMINFO="${MEMORY_ALERT_MEMINFO:-/proc/meminfo}"
POSTFIX="${MEMORY_ALERT_POSTFIX:-tatvaos-postfix-1}"
SOME_WARN=10; FULL_CRIT=5; AVAIL_WARN=15; AVAIL_CRIT=7
HOST=$(hostname)
NOW() { date -u +%FT%TZ; }

send() {  # $1 subject, $2 body — non-zero if Postfix did not take it
    if [ "$DRYRUN" = "1" ]; then
        printf 'DRY RUN — nothing sent, state file untouched\nSubject: %s\n\n%s\n' "$1" "$2"
        return 0
    fi
    printf 'From: TatvaOS server <%s>\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
        "$FROM" "$TO" "$1" "$2" \
        | docker exec -i "$POSTFIX" sendmail -t -f "$FROM"
}

# ── Fail loudly. Any error from here on becomes a message, not silence. ──────
fail_loudly() {
    local line=$1 cmd=$2
    send "TatvaOS memory alert is BROKEN on ${HOST} — it cannot check memory" \
"memory-alert.sh failed at line ${line} while running:
    ${cmd}

That means memory is NOT being watched until this is fixed. Check that
${PSI} and ${MEMINFO} are readable and that Docker is answering.

— memory-alert.sh on ${HOST}, $(NOW)" \
    || { echo "memory-alert.sh: FAILED at line ${line} (${cmd}) AND could not send the failure mail" >&2; exit 2; }
    echo "memory-alert.sh: failed at line ${line}; failure mail sent to ${TO}" >&2
    exit 1
}
trap 'fail_loudly "$LINENO" "$BASH_COMMAND"' ERR
set -E

# ── The readings. Refuse to reason about a number that does not look like one.
num() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; }
psi_avg300() { awk -v k="$1" '$1==k { for (i = 2; i <= NF; i++) if ($i ~ /^avg300=/) { sub(/^avg300=/, "", $i); print $i } }' "$PSI"; }
SOME=$(psi_avg300 some); FULL=$(psi_avg300 full)
num "$SOME" && num "$FULL" || { false; }                            # trips the ERR trap
mem_kb() { awk -v k="$1:" '$1==k { print $2 }' "$MEMINFO"; }
TOTAL=$(mem_kb MemTotal); AVAIL=$(mem_kb MemAvailable); SWAPT=$(mem_kb SwapTotal); SWAPF=$(mem_kb SwapFree)
num "$TOTAL" && num "$AVAIL" && num "$SWAPT" && num "$SWAPF" && [ "$TOTAL" -gt 0 ] || { false; }
AVAIL_PCT=$(( AVAIL * 100 / TOTAL ))
mb() { echo $(( $1 / 1024 )); }
ge() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }

# Containers: name, OOMKilled, RestartCount. A Docker that does not answer is a
# broken monitor, so its failure trips the ERR trap rather than reading as "none".
IDS=$(docker ps -aq)
CONTAINERS=""
[ -n "$IDS" ] && CONTAINERS=$(docker inspect -f '{{.Name}} {{.State.OOMKilled}} {{.RestartCount}}' $IDS | sed 's|^/||')

# ── The level, and why ──────────────────────────────────────────────────────
LEVEL=quiet; WHY=()
if ge "$FULL" "$FULL_CRIT"; then LEVEL=crit; WHY+=("everything was stalled waiting for memory ${FULL}% of the last five minutes (critical at ${FULL_CRIT}%)"); fi
if [ "$AVAIL_PCT" -lt "$AVAIL_CRIT" ]; then LEVEL=crit; WHY+=("only ${AVAIL_PCT}% of memory is available (critical under ${AVAIL_CRIT}%)"); fi
if [ "$LEVEL" != crit ]; then
    if ge "$SOME" "$SOME_WARN"; then LEVEL=warn; WHY+=("something was waiting on memory ${SOME}% of the last five minutes (warning at ${SOME_WARN}%)"); fi
    if [ "$AVAIL_PCT" -lt "$AVAIL_WARN" ]; then LEVEL=warn; WHY+=("only ${AVAIL_PCT}% of memory is available (warning under ${AVAIL_WARN}%)"); fi
fi

figures() {
    cat <<EOF
  memory pressure, last 5 min   some ${SOME}%   full ${FULL}%
  memory available              $(mb "$AVAIL") MB of $(mb "$TOTAL") MB (${AVAIL_PCT}%)
  swap in use                   $(mb $(( SWAPT - SWAPF ))) MB of $(mb "$SWAPT") MB
                                (lags: pages swapped out long ago stay counted — "it happened", not "it is happening")
EOF
}

# Built ONLY when a message is being sent.
breakdown() {
    echo "Each container's memory against its cap:"
    docker stats --no-stream --format '  {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\tcpu {{.CPUPerc}}' 2>/dev/null | sort || echo "  (docker stats did not answer)"
    if pgrep -x buildkitd >/dev/null 2>&1 || pgrep -f '^docker (buildx )?build' >/dev/null 2>&1; then
        echo "A Docker BUILD is running now (a deploy builds images on this same box)."
    else
        echo "No Docker build is running."
    fi
    echo "A recording shows as tatvaos-egress-1 busy above (its CPU and memory rise while it records)."
}

advice() {
    cat <<'EOF'
What to do, cheapest first:
  1. If a recording is on and a deploy is building, that is the known collision.
     The deploy hold is the rule for it: don't deploy during a recording.
  2. If one container sits at its cap, that container's cap or its workload is
     the question, not the server.
  3. Only if it keeps happening with nothing unusual running: a bigger Linode
     plan (price from Linode at the time). That is Amit's decision.
EOF
}

body() {  # $1 the situation sentence
    cat <<EOF
$1

$(figures)

$(breakdown)

$(advice)

Sent once per crossing, with one reminder a day while it stays above.
— memory-alert.sh on ${HOST}, $(NOW)
EOF
}

reasons() { local r; for r in "${WHY[@]}"; do printf '  - %s\n' "$r"; done; }

if [ "$DRYRUN" = "1" ]; then
    send "(would send if a line were crossed) TatvaOS memory: ${LEVEL}" \
         "$(body "DRY RUN: the message this alert would send today, with today's figures. Level now: ${LEVEL}.
$( [ ${#WHY[@]} -gt 0 ] && reasons )")"
    exit 0
fi

if [ "${MEMORY_ALERT_FORCE:-0}" = "1" ]; then
    send "[TEST] TatvaOS memory alert — a rehearsal, not a crossing" \
         "$(body "This is a deliberate test of the alert path. The real lines are PSI some ${SOME_WARN}% / full ${FULL_CRIT}% and available ${AVAIL_WARN}% / ${AVAIL_CRIT}%; nothing has crossed because of this message, and the state file was not touched.")"
    echo "test alert sent to ${TO} (memory actually: some ${SOME}%, full ${FULL}%, available ${AVAIL_PCT}%)"; exit 0
fi

touch "$STATE"
today=$(date -u +%F)
# state file: warn=<date> crit=<date> reminded=<date> c_<container>=<oomkilled>/<restarts>
get()  { sed -n "s/^$1=//p" "$STATE" | tail -1; }
set_() { { grep -v "^$1=" "$STATE" || true; echo "$1=$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }

# ── Containers: the event itself, mailed at once ─────────────────────────────
EVENTS=()
while read -r name oom rc; do
    [ -n "${name:-}" ] || continue
    prev=$(get "c_${name}")
    if [ -n "$prev" ]; then
        poom=${prev%/*}; prc=${prev#*/}
        [ "$oom" = true ] && [ "$poom" != true ] && EVENTS+=("${name} was KILLED FOR MEMORY (Docker's OOMKilled is now true)")
        num "$rc" && num "$prc" && [ "$rc" -gt "$prc" ] && EVENTS+=("${name} restarted $(( rc - prc )) time(s) since the last check (restart count ${prc} -> ${rc})")
    fi
    set_ "c_${name}" "${oom}/${rc}"
done <<< "$CONTAINERS"
if [ ${#EVENTS[@]} -gt 0 ]; then
    send "TatvaOS: a container was killed or restarted — ${EVENTS[0]%% *}" \
         "$(body "$(printf '%s\n' "${EVENTS[@]}")

A restart of the render container takes every Docs save in flight with it.")"
fi

# ── Pressure and availability: once per crossing, plus a daily reminder ─────
if [ "$LEVEL" = crit ]; then
    if [ -z "$(get crit)" ]; then
        send "TatvaOS memory CRITICAL on ${HOST} — act now" "$(body "CRITICAL:
$(reasons)")"
        set_ crit "$today"; set_ warn "$today"; set_ reminded "$today"
    elif [ "$(get reminded)" != "$today" ]; then
        send "TatvaOS memory still critical — daily reminder" "$(body "Still critical:
$(reasons)")"; set_ reminded "$today"
    fi
elif [ "$LEVEL" = warn ]; then
    set_ crit ""
    if [ -z "$(get warn)" ]; then
        send "TatvaOS memory under pressure on ${HOST} — look today" "$(body "WARNING:
$(reasons)")"
        set_ warn "$today"; set_ reminded "$today"
    elif [ "$(get reminded)" != "$today" ]; then
        send "TatvaOS memory still under pressure — daily reminder" "$(body "Still above the warning line:
$(reasons)")"; set_ reminded "$today"
    fi
else
    set_ warn ""; set_ crit ""
fi

# One line per run, whatever happened: the proof it ran, and for the first two
# weeks the calibration record the thresholds will be set from (0014).
echo "$(NOW) memory some300=${SOME}% full300=${FULL}% avail=$(mb "$AVAIL")MB(${AVAIL_PCT}%) swap=$(mb $(( SWAPT - SWAPF )))MB — ${LEVEL}$( [ ${#EVENTS[@]} -gt 0 ] && echo "; ${#EVENTS[@]} container event(s)" )"
