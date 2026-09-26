#!/usr/bin/env bash
# Stands in for the two Docker calls infra/scripts/maildir-removals.sh makes,
# on a local maildir tree ($TATVAOS_VMAIL, laid out like /var/mail/vhosts).
#
#   fake-doveadm.sh expunge <address>   what `doveadm expunge -u <address> mailbox '*' all` does
#   fake-doveadm.sh count   <address>   the script's own file count, unchanged
#
# MR_FAKE_STUCK=1 makes expunge do nothing and succeed — the failure the
# script exists to catch: a tool that says it worked while files remain.
set -uo pipefail
VMAIL="${TATVAOS_VMAIL:-.tmp/vmail}"
local_part="${2%@*}"; domain="${2#*@}"; d="$VMAIL/$domain/$local_part"
case "$1" in
    expunge)
        [ "${MR_FAKE_STUCK:-0}" = "1" ] && exit 0
        [ -d "$d" ] && find "$d" -type f \( -path '*/cur/*' -o -path '*/new/*' -o -path '*/tmp/*' \) -delete
        exit 0 ;;
    count)
        [ -d "$d" ] || { echo 0; exit 0; }
        find "$d" -type f \( -path '*/cur/*' -o -path '*/new/*' -o -path '*/tmp/*' \) | wc -l ;;
esac
