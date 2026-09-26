#!/usr/bin/env bash
#
# TatvaOS — remove the mail files of DELETED personal accounts, through the
# mail server's own tool (Mr. Singh on PR 319, 26 Sept 2026).
#
#   ./infra/scripts/maildir-removals.sh             one pass (what cron runs)
#   ./infra/scripts/maildir-removals.sh --dry-run   say what it would do, change nothing
#   ./infra/scripts/maildir-removals.sh --install   install (or update) the cron entry
#
# ─────────────────────────────────────────────────────────────────────────────
#  WHY THIS EXISTS
#
#  The mail importer files maildir files into whichever mailbox has that
#  ADDRESS. A deleted personal account's address is held (core.address_holds)
#  and must not be given to anyone new while its old files are on disk, or
#  the new person receives the old person's mail. The API cannot delete those
#  files: it mounts the maildir READ-ONLY, on purpose — an API bug able to
#  delete a mailbox on disk would have too much reach. Dovecot is the maildir's
#  one writer, so Dovecot's tool deletes.
#
#  THE QUEUE is core.personal_purge_leftovers rows of kind 'maildir', written by
#  the API's purge. This script takes them in order and, for EACH address:
#
#    1. checks, in the database, that it is safe to touch:
#         - the address has the strict shape of one (no path characters)
#         - NO mailbox row has that address any more   (never a live mailbox)
#         - it is HELD in core.address_holds            (only what a purge queued)
#         - its domain belongs to the personal house    (never an organisation)
#       Any check failing: the row is left, and the reason logged. Never guessed.
#    2. runs, INSIDE the running Dovecot container, as vmail, for that one user:
#         doveadm expunge -u <address> mailbox '*' all
#       Dovecot's static userdb derives the home from the address, so the lookup
#       works after the account's rows are gone. The command is given the
#       address and nothing else.
#    3. counts the message files still under that address's maildir
#       (cur/, new/, tmp/). Zero → deletes the leftover row, which is what
#       lets the address's hold end on its date. Not zero → leaves the row,
#       logs the count; the next pass tries again.
#
#  No network use of its own: it talks to two local containers through the
#  Docker CLI on this host. It needs no secret — psql runs as postgres inside
#  the Postgres container, as backup.sh does.
#
#  ONE ADDRESS, NEVER EVERYONE (Mr. Singh, 26 Sept 2026). doveadm's
#  all-users flag, or its user flag followed by an empty value, reaches every
#  mailbox on the server, and an empty variable is the classic way that
#  happens. So: the address travels as its OWN argument in an array — never
#  through a shell string; an empty or whitespace address is refused before
#  anything runs, in the loop AND again inside run_expunge; the all-users flag
#  appears nowhere in this file (the test greps for it); --dry-run prints the
#  exact command it would run.
#
#  TESTED LOCALLY with the database and the two commands overridden (MR_PSQL,
#  MR_EXPUNGE, MR_COUNT — tests/personal-maildir-removal). doveadm itself has
#  NOT been run by this script yet: that is the first thing to do on the
#  server, with --dry-run, then on one throwaway address. See the PR.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/../.."

LOG="${MR_LOG:-$HOME/tatvaos-maildir-removals.log}"
BATCH="${MR_BATCH:-20}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [ "${1:-}" = "--install" ]; then
    # Every 15 minutes: an address is held for 90 days anyway; this only has
    # to be done well before then. Replaces an existing entry, never stacks.
    LINE="*/15 * * * * cd $(pwd) && ./infra/scripts/maildir-removals.sh >> ${LOG} 2>&1"
    old=$(crontab -l 2>/dev/null | grep -F 'infra/scripts/maildir-removals.sh')
    if [ "$old" = "$LINE" ]; then say "cron entry already installed"
    else
        (crontab -l 2>/dev/null | grep -vF 'infra/scripts/maildir-removals.sh'; echo "$LINE") | crontab -
        say "installed: every 15 minutes, logging to ${LOG}"
    fi
    crontab -l | grep -F 'maildir-removals.sh' | sed 's/^/   /'
    exit 0
fi

# ---- The containers, and the three things this script does ------------------
#  Each is overridable for the local test (no Docker on the laptop).
PG=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 postgres || true)
DOVECOT="${MR_DOVECOT:-$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 dovecot || true)}"
DB="${MR_DB:-tatvaos_mail}"

sql() { # one statement, values passed as psql variables, never pasted in
    if [ -n "${MR_PSQL:-}" ]; then $MR_PSQL "$@"
    else docker exec -i "$PG" psql -U postgres -d "$DB" -Atq -v ON_ERROR_STOP=1 "$@"; fi
}

# Is this exactly one plain address? Empty, whitespace anywhere, or anything a
# path or an option could be made of: no.
one_address() {
    local a="${1-}"
    [ -n "$a" ] || return 1
    case "$a" in *[[:space:]]*|-*|*..*|*/*) return 1 ;; esac
    printf '%s' "$a" | grep -Eq -- '^[a-z][a-z0-9.-]{2,62}[a-z0-9]@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
}

# The one doveadm command, as an array: the address is one argument, whatever
# it contains. Printed by --dry-run exactly as it would run.
expunge_cmd() { EXPUNGE=(docker exec -u vmail "$DOVECOT" doveadm expunge -u "$1" mailbox '*' all); }
run_expunge() {
    # The last guard, where it matters: nothing reaches doveadm but one address.
    if ! one_address "${1-}"; then say "REFUSED at doveadm: [${1-}] is not one address"; return 99; fi
    if [ -n "${MR_EXPUNGE:-}" ]; then $MR_EXPUNGE "$1"; return; fi
    expunge_cmd "$1"; "${EXPUNGE[@]}"
}

# Message files left under the address's maildir. No shell string: two plain
# docker exec calls with the path as one argument. "Cannot tell" (Docker
# failed) prints "?", which is never "0" — so the address stays held.
count_files() {
    if [ -n "${MR_COUNT:-}" ]; then $MR_COUNT "$1"; return; fi
    local d="/var/mail/vhosts/${1#*@}/${1%@*}" rc out
    docker exec -u vmail "$DOVECOT" test -d "$d"; rc=$?
    if [ $rc -eq 1 ]; then echo 0; return; fi        # no maildir at all
    if [ $rc -ne 0 ]; then echo "?"; return; fi       # docker itself failed
    out=$(docker exec -u vmail "$DOVECOT" find "$d" -type f \( -path '*/cur/*' -o -path '*/new/*' -o -path '*/tmp/*' \)) \
        || { echo "?"; return; }
    [ -z "$out" ] && echo 0 || printf '%s\n' "$out" | wc -l
}

if [ -z "${MR_PSQL:-}" ] && { [ -z "$PG" ] || [ -z "$DOVECOT" ]; }; then
    say "REFUSED: need both containers running (postgres=[$PG] dovecot=[$DOVECOT])"; exit 1
fi

# ---- The queue ---------------------------------------------------------------
#  id|ref, so an EMPTY ref is still a line of its own (and is refused below)
#  rather than looking like an empty queue.
mapfile -t QUEUE < <(sql -v n="$BATCH" <<'SQL' | tr -d '\r'
SELECT id || '|' || ref FROM core.personal_purge_leftovers WHERE kind = 'maildir' ORDER BY id LIMIT :n;
SQL
)
[ "${#QUEUE[@]}" -eq 0 ] && { say "nothing queued"; exit 0; }
say "${#QUEUE[@]} address(es) queued$([ $DRY = 1 ] && echo ' (dry run)')"

done_n=0; left_n=0; refused_n=0
for row in "${QUEUE[@]}"; do
    id="${row%%|*}"; addr="${row#*|}"            # nothing stripped: a space is refused, not tidied

    # 1a. Exactly one plain address, before anything else runs.
    if ! one_address "$addr"; then
        say "REFUSED [$addr] (row $id): not one plain address (empty, whitespace, or not an address)"
        refused_n=$((refused_n+1)); continue
    fi

    # 1b-d. Safe to touch? One query, the address as a variable.
    why=$(sql -v a="$addr" <<'SQL'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM mail.mailboxes WHERE address = :'a')        THEN 'a mailbox with this address EXISTS'
  WHEN NOT EXISTS (SELECT 1 FROM core.address_holds WHERE address = :'a') THEN 'not held by a purge'
  WHEN NOT EXISTS (SELECT 1 FROM core.domains d JOIN core.tenants t ON t.id = d.tenant_id
                    WHERE t.kind = 'personal_house'
                      AND lower(d.fqdn::text) = lower(split_part(:'a', '@', 2)))
                                                                         THEN 'not on the personal house''s domain'
  ELSE 'ok' END;
SQL
)
    why=$(printf '%s' "$why" | tr -d '\r')
    if [ "$why" != "ok" ]; then say "REFUSED [$addr]: $why"; refused_n=$((refused_n+1)); continue; fi

    if [ $DRY = 1 ]; then
        expunge_cmd "$addr"
        say "would run: $(printf '%q ' "${EXPUNGE[@]}")($(count_files "$addr") message file(s) now)"
        continue
    fi

    # 2. The mail server removes the messages, for this one user.
    out=$(run_expunge "$addr" 2>&1); rc=$?
    [ $rc -ne 0 ] && say "doveadm for [$addr] exited $rc: $(printf '%s' "$out" | head -c 300)"

    # 3. Seen gone → the row goes, and with it the hold's last reason.
    n=$(count_files "$addr" | tr -d '\r[:space:]')
    if [ "$n" = "0" ]; then
        sql -v i="$id" <<'SQL' >/dev/null
DELETE FROM core.personal_purge_leftovers WHERE kind = 'maildir' AND id = :i;
SQL
        say "done [$addr]: no message files remain; its hold now ends on its date"
        done_n=$((done_n+1))
    else
        sql -v i="$id" -v e="${n:-?} message file(s) remain after doveadm" <<'SQL' >/dev/null
UPDATE core.personal_purge_leftovers SET attempts = attempts + 1, last_error = :'e' WHERE kind = 'maildir' AND id = :i;
SQL
        say "NOT DONE [$addr]: ${n:-?} message file(s) remain; the address stays held"
        left_n=$((left_n+1))
    fi
done
say "pass finished: done=$done_n not_done=$left_n refused=$refused_n"
