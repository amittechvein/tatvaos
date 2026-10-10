#!/usr/bin/env bash
# ============================================================================
#  infra/scripts/migration-master-alert.sh, proven against a fake docker
# ============================================================================
#  The real script, run with a fake `docker` on PATH that answers the one
#  Dovecot reading from a file (off, or on since an epoch) and records every
#  mail it is asked to send; time is moved with MIGRATION_ALERT_NOW. Every
#  "mails" check has its "does NOT mail" twin: a script that mailed on every
#  run, or never, fails here. The password is never read: the fake records
#  what the script asks Dovecot for. No network, no Docker, no root.
#
#    bash tests/migration-master-alert/test.sh
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/infra/scripts/migration-master-alert.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1${2:+ — $2}"; }

# A fake docker: `docker exec <dovecot> sh -c '...'` answers from $T/dovecot
# (and records the command it was asked to run); `docker exec -i <postfix>
# sendmail` records the mail. Anything else is refused, and $T/docker-broken
# makes every call fail (the fail-loudly path).
mkdir -p "$T/bin"; cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
T="$FAKE_T"
[ -f "$T/docker-broken" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
if [ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = "$FAKE_POSTFIX" ]; then cat >> "$T/mail.log"; printf '\n--\n' >> "$T/mail.log"; exit 0; fi
if [ "$1" = exec ] && [ "$2" = "$FAKE_DOVECOT" ]; then printf '%s\n' "$*" >> "$T/asked.log"; cat "$T/dovecot"; exit 0; fi
echo "fake docker: unexpected: $*" >&2; exit 1
EOF
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" FAKE_T="$T" FAKE_DOVECOT=tv-dovecot-fake FAKE_POSTFIX=tv-postfix-fake
export MIGRATION_ALERT_TO=alerts-test@example.invalid MIGRATION_ALERT_STATE="$T/state"
export MIGRATION_ALERT_DOVECOT=tv-dovecot-fake MIGRATION_ALERT_POSTFIX=tv-postfix-fake MIGRATION_ALERT_HOST=testbox
NOW0=1800000000                               # a fixed "now"
export MIGRATION_ALERT_NOW=$NOW0
off() { echo off > "$T/dovecot"; }
on_since() { echo "on $1" > "$T/dovecot"; }   # $1 epoch
at() { export MIGRATION_ALERT_NOW=$1; }
run() { bash "$SCRIPT" > "$T/out" 2>&1; echo $? > "$T/rc"; }
mails() { grep -c '^Subject:' "$T/mail.log" 2>/dev/null || echo 0; }
last_subject() { grep '^Subject:' "$T/mail.log" | tail -1; }
reset() { rm -f "$T/state" "$T/mail.log" "$T/asked.log" "$T/docker-broken"; off; at $NOW0; }

echo "  migration-master-alert.sh against a fake docker"

echo "  >> off"
reset; run
[ "$(mails)" = 0 ] && [ "$(cat "$T/rc")" = 0 ] && ok "off: nothing mailed, exit 0" || bad "off" "mails=$(mails) rc=$(cat "$T/rc")"
grep -q 'master login: off' "$T/out" && ok "...and the log line says off" || bad "log line" "$(cat "$T/out")"
run; [ "$(mails)" = 0 ] && ok "off again: still nothing" || bad "off twice" "mails=$(mails)"

echo "  >> switched on just now"
on_since $((NOW0 - 600)); run
[ "$(mails)" = 1 ] && last_subject | grep -q 'is ON' && ok "first seen on: one mail, at once" || bad "switch-on notice" "mails=$(mails) $(last_subject)"
grep -q "on=$((NOW0 - 600))" "$T/state" && ok "...the state remembers since when" || bad "state" "$(cat "$T/state")"
run; [ "$(mails)" = 1 ] && ok "same run again: no second notice" || bad "repeat" "mails=$(mails)"
at $((NOW0 + 2*86400)); run; [ "$(mails)" = 1 ] && ok "on for 2 days (limit 3): no reminder yet" || bad "early reminder" "mails=$(mails)"

echo "  >> left on beyond the limit"
at $((NOW0 + 4*86400)); run
[ "$(mails)" = 2 ] && last_subject | grep -q 'STILL ON' && last_subject | grep -q '4 days' && ok "on for 4 days: a reminder, naming 4 days" || bad "reminder" "mails=$(mails) $(last_subject)"
run; [ "$(mails)" = 2 ] && ok "same day again: no second reminder" || bad "reminder repeat" "mails=$(mails)"
at $((NOW0 + 5*86400)); run; [ "$(mails)" = 3 ] && ok "next day: another reminder" || bad "daily" "mails=$(mails)"
at $((NOW0 + 5*86400 + 3600)); run; [ "$(mails)" = 3 ] && ok "...an hour later, same day: none" || bad "same-day twin" "mails=$(mails)"

echo "  >> off again, then on again"
off; at $((NOW0 + 6*86400)); run
[ "$(mails)" = 3 ] && ok "off: nothing mailed" || bad "off after on" "mails=$(mails)"
grep -q '^on=$' "$T/state" && ok "...the state is cleared" || bad "state clear" "$(cat "$T/state")"
on_since $((NOW0 + 7*86400)); at $((NOW0 + 7*86400 + 60)); run
[ "$(mails)" = 4 ] && last_subject | grep -q 'is ON' && ok "on again: a new switch-on notice (a new crossing)" || bad "new crossing" "mails=$(mails) $(last_subject)"

echo "  >> what it asks Dovecot for"
grep -q 'stat -c %Y' "$T/asked.log" && ! grep -qE 'cat |head |sed |awk ' "$T/asked.log" && ok "it asks only for size and mtime, never the content" || bad "asks" "$(tail -1 "$T/asked.log")"
! grep -qi 'password' "$T/mail.log" | grep -v 'master login' >/dev/null; grep -c 'migration-master.sh off' "$T/mail.log" | grep -q '^[1-9]' && ok "every mail says how to switch it off" || bad "advice"

echo "  >> dry run, force, broken"
reset; on_since $((NOW0 - 86400*9)); MIGRATION_ALERT_DRYRUN=1 MIGRATION_ALERT_TO= run
[ "$(mails)" = 0 ] && grep -q 'DRY RUN' "$T/out" && grep -q 'ON since' "$T/out" && ok "DRYRUN prints the would-be message, sends nothing, needs no recipient" || bad "dryrun" "mails=$(mails)"
[ ! -f "$T/state" ] && ok "...and leaves no state behind" || bad "dryrun state"
reset; MIGRATION_ALERT_FORCE=1 run
[ "$(mails)" = 1 ] && last_subject | grep -q '\[TEST\]' && ok "FORCE sends a [TEST] message" || bad "force" "mails=$(mails)"
reset; touch "$T/docker-broken"; run
# Docker down means the failure mail cannot go either: exit 2 and say so on
# stderr, where cron's own mail to the deploy user carries it (memory-alert's
# design). Loud, not silent - the one thing this path must never be.
[ "$(cat "$T/rc")" = 2 ] && grep -q 'could not send the failure mail' "$T/out" && [ "$(mails)" = 0 ] && ok "docker broken: exit 2, says it could not even send the failure mail" || bad "broken" "rc=$(cat "$T/rc") mails=$(mails) $(grep -i 'FAILED' "$T/out" | head -1)"
reset; echo "garbage" > "$T/dovecot"; run
[ "$(cat "$T/rc")" != 0 ] && [ "$(mails)" = 1 ] && last_subject | grep -q 'BROKEN' && ok "an unreadable answer: the failure mail, exit non-zero" || bad "garbage" "rc=$(cat "$T/rc") mails=$(mails)"
reset; MIGRATION_ALERT_TO= run; [ "$(cat "$T/rc")" = 2 ] && ok "no recipient: refuses to run (exit 2)" || bad "no TO" "rc=$(cat "$T/rc")"

echo
if [ "$fail" = 0 ]; then echo "  PASS  $pass checks"; exit 0; else echo "  FAIL  $fail of $((pass+fail)) checks"; exit 1; fi
