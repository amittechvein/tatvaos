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
#  Read it without sending:  DISK_ALERT_DRYRUN=1 ./disk-alert.sh
#  prints the message this run WOULD send, with today's real figures, to the
#  terminal. Nothing is mailed, the state file is untouched, and DISK_ALERT_TO
#  is not needed. For checking a change to the wording on the real box.
#
#  THE ADVICE, AND THE SETTING BESIDE EACH LINE (Mr. Singh, 26 Sept 2026).
#  The alert that fired at 70% on 25 Sept sent Amit towards buying a volume
#  before the cheapest step, when scheduled backups were 57 GB — half the
#  used disk — because four sets a day were kept for three days. So the
#  first step is now "keep fewer backups on this server" (the same sets are
#  kept off it), and each backup line shows the setting that decides its
#  size, read from the config file, so the reader can see WHY a line is big.
#  Two settings, not one, and the difference matters: with the tiered
#  schedule on, scheduled sets follow BACKUP_LOCAL_KEEP (a count) while the
#  pre-deploy copies still follow BACKUP_KEEP_DAYS (days) — lowering the
#  latter to shrink the former would shorten the wrong thing.
#
#  Cost: one df and one stat per run; an email a month when nothing is wrong.
# ============================================================================
set -u

TO="${DISK_ALERT_TO:-}"
DRYRUN="${DISK_ALERT_DRYRUN:-0}"
if [ "$DRYRUN" != "1" ] && [ -z "$TO" ]; then
    echo "DISK_ALERT_TO must be set, to an address that is NOT on this server" >&2; exit 2
fi
FROM="${DISK_ALERT_FROM:-alerts@tatvaos.com}"
WARN=70
CRIT=85
STATE="${DISK_ALERT_STATE:-/srv/tatvaos-production/.disk-alert-state}"
# backup.sh's and deploy.sh's shared settings. READ ONE KEY AT A TIME, never
# sourced: the same file holds the off-server encryption passphrase, and a
# script that sources it would have that secret in its environment.
BACKUP_CONF="${DISK_ALERT_BACKUP_CONF:-/srv/backups/tatvaos/.backup-env}"
POSTFIX="${DISK_ALERT_POSTFIX:-tatvaos-postfix-1}"
HOST=$(hostname)
NOW() { date -u +%FT%TZ; }

send() {  # $1 subject, $2 body — returns non-zero if Postfix did not take it
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

# One setting from the backup config, or empty. sed, not `source` — see
# BACKUP_CONF above. A missing file or key gives empty, and the callers fall
# back to the scripts' own defaults, so a wording problem can never trip the
# ERR trap and turn a disk alert into a "monitor broken" mail.
conf() {
    sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1=[\"']?([^\"'#[:space:]]*).*/\2/p" "$BACKUP_CONF" 2>/dev/null | tail -1
}

# The rules as the scripts will apply them, in words.
retention() {
    KEEP_DAYS=$(conf BACKUP_KEEP_DAYS)
    # Not set means the scripts' own default — said as a default, not as if
    # someone had chosen 14 (the dry run with no config file showed it that way).
    if [ -n "$KEEP_DAYS" ]; then KEEP_SRC="BACKUP_KEEP_DAYS=${KEEP_DAYS}"
    else KEEP_DAYS=14; KEEP_SRC="BACKUP_KEEP_DAYS not set, default 14"; fi
    TIERED=$(conf BACKUP_S3_TIERED)
    LOCAL_KEEP=$(conf BACKUP_LOCAL_KEEP)
    if [ "$TIERED" = "1" ] && [ -n "$LOCAL_KEEP" ]; then
        SCHED_RULE="newest ${LOCAL_KEEP} kept (BACKUP_LOCAL_KEEP=${LOCAL_KEEP}, tiered)"
        SCHED_KNOB="BACKUP_LOCAL_KEEP"
    else
        SCHED_RULE="${KEEP_DAYS} days kept (${KEEP_SRC})"
        SCHED_KNOB="BACKUP_KEEP_DAYS"
    fi
    PRE_RULE="${KEEP_DAYS} days kept (${KEEP_SRC})"
}

# ── The breakdown, built ONLY when a message is being sent. ──────────────────
breakdown() {
    retention
    printf '  scheduled backups (backup.sh)  %6.1f GB  %s sets  — %s\n' \
        "$(du -sb /srv/backups/tatvaos 2>/dev/null | awk '{print $1/1e9}')" \
        "$(ls -1d /srv/backups/tatvaos/*/ 2>/dev/null | wc -l)" "$SCHED_RULE"
    printf '  pre-deploy copies (deploy.sh)  %6.1f GB  %s files — %s\n' \
        "$(du -sb /srv/tatvaos-production/backups 2>/dev/null | awk '{print $1/1e9}')" \
        "$(ls -1 /srv/tatvaos-production/backups 2>/dev/null | wc -l)" "$PRE_RULE"
    docker system df --format '{{.Type}}\t{{.Size}}' 2>/dev/null \
        | awk -F'\t' '$1=="Build Cache"||$1=="Images"||$1=="Local Volumes"{printf "  docker %-24s %s\n", tolower($1), $2}'
}

body() {  # $1 the situation sentence
    # Here, not only inside breakdown(): $(breakdown) runs in a SUBSHELL, so the
    # rules it works out never reach this heredoc. Found by the dry run on the
    # real box, 26 Sept 2026 — "SCHED_RULE: unbound variable".
    retention
    cat <<EOF
Production disk is at ${pct}% — $(gb "$used") GB used of $(gb "$total") GB, $(gb "$avail") GB free.

$1

What is using it right now:
$(breakdown)
  (customer data — mail, files, recordings, database — is inside "local volumes")

What to do, cheapest first:
  1. Keep fewer scheduled backups ON THIS SERVER — ${SCHED_RULE}.
     The same sets are kept off the server too (encrypted, object storage), so
     the copies here are only for a fast restore. Lower ${SCHED_KNOB} in
     ${BACKUP_CONF} and let backup.sh remove the rest on its next run.
     Never delete sets by hand.
  2. Pre-deploy copies — ${PRE_RULE}. $( [ "$SCHED_KNOB" = "BACKUP_KEEP_DAYS" ] \
       && echo "The SAME setting as step 1: lowering it shortens both." \
       || echo "A DIFFERENT setting from step 1: lowering this shortens only these." )
     A copy older than the window means deploy.sh's pruning is not running.
  3. Still above the line: add a Linode volume (about \$0.10 per GB a month) for recordings and backups.
  4. Only if CPU or RAM are also short — they were not when this alert was written — a bigger server.

Sent once per crossing, with one reminder a day while it stays above.
— disk-alert.sh on ${HOST}, $(NOW)
EOF
}

if [ "$DRYRUN" = "1" ]; then
    send "(would send if a line were crossed) TatvaOS disk at ${pct}%" \
         "$(body "DRY RUN: the message this alert would send today, with today's figures.")"
    exit 0
fi

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
