#!/usr/bin/env bash
# ============================================================================
#  migration-master-alert.sh — tell Amit while the Google migration's master
#  login is ON, and keep telling him once it has been on too long
# ============================================================================
#
#  Decision 0019 §2 (Mr. Singh, 10 Oct 2026): the master login is a credential
#  that can open ANY mailbox on this server. It is switched on for the days a
#  migration runs and switched off afterwards by a person remembering to.
#  Somebody will forget, and "a guarantee that lives in a person's memory is
#  not a guarantee". So the system notices:
#
#    1. The API logs CRITICAL at every start while the file is non-empty
#       (MasterMailboxLogin.ReportAtStartup).
#    2. THIS, from cron: reads ONE fact from the Dovecot container — whether
#       /etc/dovecot/migration/master.passwd is non-empty and, if so, when it
#       was written (its mtime; migration-master.sh writes it on "on").
#       - the moment it is first seen ON: one mail, naming since when
#       - on for more than MIGRATION_ALERT_DAYS days (default 3): a daily
#         reminder until it is off
#       - off: nothing mailed; the state is cleared so the next "on" is a new
#         crossing
#       Same shape as memory-alert.sh: state file, FORCE and DRYRUN, FAILS
#       LOUDLY (a check that cannot run mails that it cannot run), one log
#       line per run. Mail goes through the box's own Postfix to an address
#       OFF the server. The password is never read, never printed: only the
#       file's size and time.
#
#  Install (writes the cron line; replaces an existing one, never stacks):
#      MIGRATION_ALERT_TO=<address> ./infra/scripts/migration-master-alert.sh --install
#  Test it on purpose:      MIGRATION_ALERT_FORCE=1 ./migration-master-alert.sh
#  Read it without sending: MIGRATION_ALERT_DRYRUN=1 ./migration-master-alert.sh
#
#  Proven by tests/migration-master-alert/test.sh against a fake docker.
# ============================================================================
set -u

TO="${MIGRATION_ALERT_TO:-${DISK_ALERT_TO:-}}"
DRYRUN="${MIGRATION_ALERT_DRYRUN:-0}"
if [ "${1:-}" = "--install" ]; then
    [ -n "$TO" ] || { echo "MIGRATION_ALERT_TO must be set, to an address that is NOT on this server" >&2; exit 2; }
    LINE="0 * * * * cd $(pwd) && MIGRATION_ALERT_TO=${TO} MIGRATION_ALERT_HOST=${MIGRATION_ALERT_HOST:-$(hostname)} ./infra/scripts/migration-master-alert.sh >> \$HOME/migration-master-alert.log 2>&1"
    (crontab -l 2>/dev/null | grep -vF 'infra/scripts/migration-master-alert.sh'; echo "$LINE") | crontab -
    echo "installed: every hour; $(crontab -l | grep -c 'migration-master-alert.sh') cron line(s)"
    exit 0
fi
if [ "$DRYRUN" != "1" ] && [ -z "$TO" ]; then
    echo "MIGRATION_ALERT_TO (or DISK_ALERT_TO) must be set, to an address that is NOT on this server" >&2; exit 2
fi
FROM="${MIGRATION_ALERT_FROM:-alerts@tatvaos.com}"
STATE="${MIGRATION_ALERT_STATE:-/srv/tatvaos-production/.migration-master-alert-state}"
DOVECOT="${MIGRATION_ALERT_DOVECOT:-tatvaos-dovecot-1}"
POSTFIX="${MIGRATION_ALERT_POSTFIX:-tatvaos-postfix-1}"
DAYS="${MIGRATION_ALERT_DAYS:-3}"
HOST="${MIGRATION_ALERT_HOST:-$(hostname)}"
NOW() { date -u +%FT%TZ; }
EPOCH="${MIGRATION_ALERT_NOW:-$(date -u +%s)}"   # overridable so the test can move time

send() {  # $1 subject, $2 body — non-zero if Postfix did not take it
    if [ "$DRYRUN" = "1" ]; then
        printf 'DRY RUN — nothing sent, state file untouched\nSubject: %s\n\n%s\n' "$1" "$2"
        return 0
    fi
    printf 'From: TatvaOS server <%s>\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=utf-8\n\n%s\n' \
        "$FROM" "$TO" "$1" "$2" \
        | docker exec -i "$POSTFIX" sendmail -t -f "$FROM"
}

# ── Fail loudly. A check that cannot run must say so, not fall silent. ──────
fail_loudly() {
    local line=$1 cmd=$2
    send "TatvaOS migration-login alert is BROKEN on ${HOST} — it cannot check the master login" \
"migration-master-alert.sh failed at line ${line} while running:
    ${cmd}

That means nobody is watching whether the migration master login was left
on. Check that Docker is answering and that ${DOVECOT} is running.

— migration-master-alert.sh on ${HOST}, $(NOW)" \
    || { echo "migration-master-alert.sh: FAILED at line ${line} (${cmd}) AND could not send the failure mail" >&2; exit 2; }
    echo "migration-master-alert.sh: failed at line ${line}; failure mail sent to ${TO}" >&2
    exit 1
}
trap 'fail_loudly "$LINENO" "$BASH_COMMAND"' ERR
set -E

# ── The one fact: on (since when) or off. Size and mtime only; never the content.
READING=$(docker exec "$DOVECOT" sh -c 'f=/etc/dovecot/migration/master.passwd; if [ -s "$f" ]; then echo "on $(stat -c %Y "$f")"; else echo off; fi' | tr -d '\r')
case "$READING" in
    off) ON=0; SINCE="";;
    on\ [0-9]*) ON=1; SINCE="${READING#on }";;
    *) false;;   # the trap turns this into the failure mail
esac
if [ "$ON" = 1 ]; then
    AGE_S=$(( EPOCH - SINCE )); [ "$AGE_S" -lt 0 ] && AGE_S=0
    AGE_D=$(( AGE_S / 86400 ))
    SINCE_T=$(date -u -d "@$SINCE" +%FT%TZ 2>/dev/null || date -u -r "$SINCE" +%FT%TZ)
fi

body() {  # $1 the situation
    printf '%s\n\nThe migration master login is a credential that can sign in to ANY mailbox on this server. It is meant to be on only for the days an organisation'"'"'s mail is being moved from Google, and off again as soon as that is done.\n\nSwitch it off (on the server, as deploy):\n    cd /srv/tatvaos-production && infra/scripts/migration-master.sh off\n\nCheck it:\n    infra/scripts/migration-master.sh status\n\n— migration-master-alert.sh on %s, %s\n' "$1" "$HOST" "$(NOW)"
}

if [ "$DRYRUN" = "1" ]; then
    if [ "$ON" = 1 ]; then s="ON since ${SINCE_T} (${AGE_D} day(s)); reminders start after ${DAYS} day(s)"; else s="off"; fi
    send "DRY RUN — TatvaOS migration master login: ${s}" "$(body "DRY RUN: the message this alert would send. The login is ${s}.")"
    exit 0
fi
if [ "${MIGRATION_ALERT_FORCE:-0}" = "1" ]; then
    send "[TEST] TatvaOS migration-login alert — a rehearsal, not a finding" \
         "$(body "This is a deliberate test of the alert path. The login is actually $( [ "$ON" = 1 ] && echo "ON since ${SINCE_T}" || echo off ); nothing was changed and the state file was not touched.")"
    echo "test alert sent to ${TO}"; exit 0
fi

touch "$STATE"
today=$(date -u -d "@$EPOCH" +%F 2>/dev/null || date -u -r "$EPOCH" +%F)
get()  { sed -n "s/^$1=//p" "$STATE" | tail -1; }
set_() { { grep -v "^$1=" "$STATE" || true; echo "$1=$2"; } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }

# state file: on=<since epoch> noticed=<date> reminded=<date>
SENT=""
if [ "$ON" = 1 ]; then
    if [ "$(get on)" != "$SINCE" ]; then
        # A new switch-on (or the first run while on): one mail, at once.
        send "TatvaOS migration master login is ON on ${HOST} — since ${SINCE_T}" \
             "$(body "The migration master login was switched ON at ${SINCE_T}. If a migration is running, that is expected. It must be switched off when the migration is done; this alert will remind you daily once it has been on for more than ${DAYS} days.")"
        set_ on "$SINCE"; set_ noticed "$today"; set_ reminded ""; SENT="switched-on notice"
    elif [ "$AGE_D" -gt "$DAYS" ] && [ "$(get reminded)" != "$today" ]; then
        send "TatvaOS migration master login STILL ON on ${HOST} — ${AGE_D} days, switch it off" \
             "$(body "The migration master login has been on since ${SINCE_T}: ${AGE_D} days. Migrations take days, not weeks. If the migration is finished, switch it off now. This reminder repeats daily while it stays on.")"
        set_ reminded "$today"; SENT="daily reminder (${AGE_D} d)"
    fi
else
    set_ on ""; set_ noticed ""; set_ reminded ""
fi

echo "$(NOW) migration master login: $( [ "$ON" = 1 ] && echo "ON since ${SINCE_T} (${AGE_D} d, reminders after ${DAYS} d)" || echo off )${SENT:+ — mailed: $SENT}"
