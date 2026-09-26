#!/usr/bin/env bash
# ============================================================================
#  disk-alert.sh — tell Amit when the production disk passes 70% and 85%
# ============================================================================
#
#  Read-only. Every 30 minutes it reads ONE number — df on / — and compares it
#  with two thresholds. Nothing else runs unless a threshold is crossed; only
#  then does it build the breakdown (du on two folders, docker system df) for
#  the email. It never deletes, prunes or restarts anything: a smoke detector,
#  not a sprinkler.
#
#  WHERE THE MAIL GOES. To an address OFF this server (Mr. Singh, 24 Sept): an
#  alert about this box delivered to a mailbox on this box sits here when the
#  box is in trouble. It is SENT through the box's own Postfix, which is fine
#  at 70% and 85% because there is still room to send.
#
#  WHY TWO THRESHOLDS AND A STATE FILE. Disk use crosses a line once and then
#  sits above it; an alert that fires every run is ignored by the third
#  morning. Each threshold sends ONCE on the way up, remembered in a state
#  file, and resets when use drops back below. A daily reminder keeps an
#  ignored crossing from being forgotten.
#
#  WHY 70 AND 85. At 70% the answer is still cheap and there is a month of
#  runway at recent growth. At 85% a pre-deploy dump (≈1 GB) plus a Docker
#  build (up to 8 GB of cache) can no longer be assumed to fit: deploys start
#  failing, which is what happened on 18 September at 98%.
#
#  IT FAILS LOUDLY (house rule 12: a check with no failure mode is not a
#  check). If df's output is not what this script expects, or Docker is not
#  answering, or the script dies for any reason, it sends a message saying
#  exactly that. A monitor that goes quiet is the one failure mode a monitor
#  must not have. If even the sending fails, the exit code is non-zero and
#  cron's own mail to the deploy user carries the error.
#
#  Test it on purpose:  DISK_ALERT_FORCE=1 ./disk-alert.sh
#  sends the 70% message with "[TEST]" in the subject regardless of the real
#  number and does not touch the state file, so a rehearsal never masks a
#  real crossing later.
#
#  Cost: one df and one stat per run; an email a month when nothing is wrong.
# ============================================================================
set -u

TO="${DISK_ALERT_TO:?DISK_ALERT_TO must be set, to an address that is NOT on this server}"
FROM="${DISK_ALERT_FROM:-alerts@tatvaos.com}"
WARN=70
CRIT=85
STATE="${DISK_ALERT_STATE:-/srv/tatvaos-production/.disk-alert-state}"
POSTFIX="${DISK_ALERT_POSTFIX:-tatvaos-postfix-1}"
HOST=$(hostname)
NOW() { date -u +%FT%TZ; }

send() {  # $1 subject, $2 body — returns non-zero if Postfix did not take it
    printf 'From: TatvaOS server <%s>\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
        "$FROM" "$TO" "$1" "$2" \
        | docker exec -i "$POSTFIX" sendmail -t -f "$FROM"
}

# ── Fail loudly. Any error from here on becomes a message, not silence. ──────
fail_loudly() {
    local line=$1 cmd=$2
    send "TatvaOS disk alert is BROKEN on ${HOST} — it cannot check the disk" \
"disk-alert.sh failed at line ${line} while running:
    ${cmd}

That means the disk is NOT being watched until this is fixed. The last known
figure, if any, is in ${STATE}. Check that Docker is running and that df on /
still prints size, used, avail and percent.

— disk-alert.sh on ${HOST}, $(NOW)" \
    || { echo "disk-alert.sh: FAILED at line ${line} (${cmd}) AND could not send the failure mail" >&2; exit 2; }
    echo "disk-alert.sh: failed at line ${line}; failure mail sent to ${TO}" >&2
    exit 1
}
trap 'fail_loudly "$LINENO" "$BASH_COMMAND"' ERR
set -E

# ── The one number. Refuse to reason about a number that does not look like one.
read -r total used avail pct < <(df -B1 --output=size,used,avail,pcent / | tail -1 | tr -d '%')
[[ "$pct" =~ ^[0-9]+$ ]] && [[ "$total" =~ ^[0-9]+$ ]] || { false; }   # trips the ERR trap
gb() { awk -v b="$1" 'BEGIN{printf "%.1f", b/1e9}'; }

# ── The breakdown, built ONLY when a message is being sent. ──────────────────
breakdown() {
    printf '  pre-deploy dumps (deploy.sh)   %6.1f GB  %s files\n' \
        "$(du -sb /srv/tatvaos-production/backups 2>/dev/null | awk '{print $1/1e9}')" \
        "$(ls -1 /srv/tatvaos-production/backups 2>/dev/null | wc -l)"
    printf '  scheduled backups (backup.sh)  %6.1f GB\n' \
        "$(du -sb /srv/backups/tatvaos 2>/dev/null | awk '{print $1/1e9}')"
    docker system df --format '{{.Type}}\t{{.Size}}' 2>/dev/null \
        | awk -F'\t' '$1=="Build Cache"||$1=="Images"||$1=="Local Volumes"{printf "  docker %-24s %s\n", tolower($1), $2}'
}

body() {  # $1 the situation sentence
    cat <<EOF
Production disk is at ${pct}% — $(gb "$used") GB used of $(gb "$total") GB, $(gb "$avail") GB free.

$1

What is using it right now:
$(breakdown)
  (customer data — mail, files, recordings, database — is inside "local volumes")

What to do, cheapest first:
  1. Pre-deploy dumps: deploy.sh keeps the last 10; if there are more, the retention rule is not running.
  2. Still above the line: add a Linode volume (about \$0.10 per GB a month) for recordings and backups.
  3. Only if CPU or RAM are also short — they were not when this alert was written — a bigger server.

Sent once per crossing, with one reminder a day while it stays above.
— disk-alert.sh on ${HOST}, $(NOW)
EOF
}

if [ "${DISK_ALERT_FORCE:-0}" = "1" ]; then
    send "[TEST] TatvaOS disk alert — a rehearsal, not a crossing" \
         "$(body "This is a deliberate test of the alert path. The real thresholds are ${WARN}% and ${CRIT}%; nothing has crossed because of this message, and the state file was not touched.")"
    echo "test alert sent to ${TO} (disk actually at ${pct}%)"; exit 0
fi

touch "$STATE"
today=$(date -u +%F)
# state file: warn=<date sent> crit=<date sent> reminded=<date>
get()  { sed -n "s/^$1=//p" "$STATE" | tail -1; }
set_() { { grep -v "^$1=" "$STATE" || true; echo "$1=$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }

if [ "$pct" -ge "$CRIT" ]; then
    if [ -z "$(get crit)" ]; then
        send "TatvaOS disk at ${pct}% — ACT TODAY, deploys will start failing" \
             "$(body "CRITICAL: above ${CRIT}%. A pre-deploy dump (~1 GB) plus a Docker build may no longer fit. Do step 1 today.")"
        set_ crit "$today"; set_ reminded "$today"
    elif [ "$(get reminded)" != "$today" ]; then
        send "TatvaOS disk still at ${pct}% — daily reminder" "$(body "Still above ${CRIT}%.")"; set_ reminded "$today"
    fi
elif [ "$pct" -ge "$WARN" ]; then
    set_ crit ""
    if [ -z "$(get warn)" ]; then
        send "TatvaOS disk at ${pct}% — time to plan, not to panic" \
             "$(body "WARNING: above ${WARN}%. Roughly a month of runway at recent growth. Decide on step 1 or 2 this week.")"
        set_ warn "$today"; set_ reminded "$today"
    elif [ "$(get reminded)" != "$today" ]; then
        send "TatvaOS disk still at ${pct}% — daily reminder" "$(body "Still above ${WARN}%.")"; set_ reminded "$today"
    fi
else
    set_ warn ""; set_ crit ""
fi
# One line per run, whatever happened, so the log proves the check ran and
# what it read. Silence is not a record (house rule 12).
echo "$(date -u +%FT%TZ) disk ${pct}% used, $(gb "$avail") GB free — $( [ "$pct" -ge "$WARN" ] && echo above ${WARN} || echo quiet )"
