#!/usr/bin/env bash
# ============================================================================
#  infra/scripts/memory-alert.sh, proven against fake readings (decision 0014)
# ============================================================================
#  The real script, run against a fake /proc/pressure/memory, a fake
#  /proc/meminfo and a fake `docker` on PATH that records every mail it is
#  asked to send. Each threshold and each event is driven across its line and
#  back, and every "mails" check has its "does NOT mail" twin beside it, so a
#  script that mailed on every run, or never, fails here. No network, no
#  Docker, no root: runs anywhere bash does.
#
#    bash tests/memory-alert/test.sh
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/infra/scripts/memory-alert.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1${2:+ — $2}"; }

mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
# A fake docker: containers from $FAKE/containers ("name oomkilled restarts"),
# mail appended to $FAKE/mail.log, and broken on demand.
case "$1" in
  ps)      [ -e "$FAKE/docker-broken" ] && exit 1; awk '{print $1}' "$FAKE/containers" ;;
  inspect) shift 2; for id in "$@"; do awk -v n="$id" '$1==n {print "/"$1" "$2" "$3}' "$FAKE/containers"; done ;;
  exec)    cat >> "$FAKE/mail.log"; printf '\n=====\n' >> "$FAKE/mail.log" ;;
  stats)   printf '  tatvaos-render-1\t300MiB / 512MiB\t58.6%%\tcpu 1.2%%\n' ;;
  *)       exit 0 ;;
esac
EOF
chmod +x "$T/bin/docker"
export FAKE="$T" PATH="$T/bin:$PATH"
export MEMORY_ALERT_TO=alerts-test@example.invalid MEMORY_ALERT_STATE="$T/state"
export MEMORY_ALERT_PSI="$T/psi" MEMORY_ALERT_MEMINFO="$T/meminfo"

psi() { printf 'some avg10=0.00 avg60=0.00 avg300=%s total=1\nfull avg10=0.00 avg60=0.00 avg300=%s total=1\n' "$1" "$2" > "$T/psi"; }
mem() { # total MB, available MB
  printf 'MemTotal:       %d kB\nMemFree:        1 kB\nMemAvailable:   %d kB\nSwapTotal:      2603008 kB\nSwapFree:       1645568 kB\n' \
    $(( $1 * 1024 )) $(( $2 * 1024 )) > "$T/meminfo"; }
boxes() { printf '%s\n' "$@" > "$T/containers"; }
mails() { grep -c '^Subject:' "$T/mail.log" 2>/dev/null || echo 0; }
run()   { bash "$SCRIPT" > "$T/out" 2>&1; echo $? > "$T/rc"; }
last_subject() { grep '^Subject:' "$T/mail.log" | tail -1; }

reset() { rm -f "$T/state" "$T/mail.log" "$T/docker-broken"; psi 0.00 0.00; mem 7941 5956
          boxes "tatvaos-render-1 false 0" "tatvaos-api-1 false 0"; }

echo "== quiet"
reset; run
[ "$(mails)" = 0 ] && ok "a quiet box sends nothing" || bad "a quiet box sent mail" "$(last_subject)"
grep -qE 'memory some300=0.00% full300=0.00% avail=5956MB\(75%\) swap=935MB — quiet' "$T/out" \
  && ok "…and logs one line with the readings (the calibration record)" || bad "log line" "$(cat "$T/out")"

echo "== warning by pressure: once per crossing"
reset; run; psi 12.50 0.00; run
[ "$(mails)" = 1 ] && grep -q 'under pressure' "$T/mail.log" && ok "PSI some 12.5% (>= 10) sends one warning" || bad "warning" "mails=$(mails)"
run; [ "$(mails)" = 1 ] && ok "…and the next run, still above, sends nothing more" || bad "repeated warning" "mails=$(mails)"
psi 9.99 0.00; run; [ "$(mails)" = 1 ] && ok "9.99% (just under) sends nothing" || bad "fired under the line"

echo "== critical by availability, reset, and crossing again"
reset; run; mem 7941 500; run
[ "$(mails)" = 1 ] && grep -q 'CRITICAL' "$T/mail.log" && ok "500 MB available (6% < 7) sends a critical" || bad "critical" "mails=$(mails)"
mem 7941 5956; run; [ "$(mails)" = 1 ] && ok "back to 75% sends nothing (no 'all clear' noise)" || bad "mailed on recovery"
mem 7941 500; run; [ "$(mails)" = 2 ] && ok "crossing again after recovery sends again" || bad "re-crossing" "mails=$(mails)"

echo "== critical by full stall"
reset; run; psi 0.00 5.00; run
[ "$(mails)" = 1 ] && grep -q 'everything was stalled' "$T/mail.log" && ok "PSI full 5% sends a critical, saying why" || bad "full stall" "mails=$(mails)"

echo "== daily reminder"
reset; run; psi 12.00 0.00; run
sed -i 's/^reminded=.*/reminded=2000-01-01/' "$T/state"; run
[ "$(mails)" = 2 ] && last_subject | grep -q 'daily reminder' && ok "still above the next day: one reminder" || bad "reminder" "mails=$(mails)"
run; [ "$(mails)" = 2 ] && ok "…and only one that day" || bad "reminder repeated"

echo "== a container killed for memory, or restarted: at once, naming it"
reset; run
[ "$(mails)" = 0 ] && ok "the first run records containers without alerting (a baseline, not an event)" || bad "baseline mailed"
boxes "tatvaos-render-1 true 0" "tatvaos-api-1 false 0"; run
[ "$(mails)" = 1 ] && grep -q 'tatvaos-render-1 was KILLED FOR MEMORY' "$T/mail.log" && ok "OOMKilled turning true mails at once, naming the container" || bad "oom event" "mails=$(mails)"
run; [ "$(mails)" = 1 ] && ok "…once, not every run while it stays true" || bad "oom repeated"
boxes "tatvaos-render-1 true 0" "tatvaos-api-1 false 2"; run
[ "$(mails)" = 2 ] && grep -q 'tatvaos-api-1 restarted 2 time(s)' "$T/mail.log" && ok "a restart count going up mails, with the count" || bad "restart event" "mails=$(mails)"
boxes "tatvaos-render-1 false 0" "tatvaos-api-1 false 0"; run
[ "$(mails)" = 2 ] && ok "counts going DOWN (a deploy recreating containers) are not an alert" || bad "deploy mailed"

echo "== it fails loudly"
reset; rm -f "$T/psi"; run
[ "$(cat "$T/rc")" = 1 ] && grep -q 'memory alert is BROKEN' "$T/mail.log" && ok "an unreadable PSI file sends 'BROKEN' and exits 1" || bad "broken psi" "rc=$(cat "$T/rc") mails=$(mails)"
reset; echo 'some avg300=lots' > "$T/psi"; run
grep -q 'memory alert is BROKEN' "$T/mail.log" && ok "a reading that isn't a number is refused, loudly" || bad "garbage psi"
reset; touch "$T/docker-broken"; run
grep -q 'memory alert is BROKEN' "$T/mail.log" && ok "Docker not answering is a broken monitor, not 'no containers'" || bad "docker broken"

echo "== the host label"
reset; run; psi 12.00 0.00; MEMORY_ALERT_HOST="TatvaOS production (Mumbai)" bash "$SCRIPT" > "$T/out" 2>&1
grep -q 'memory-alert.sh on TatvaOS production (Mumbai)' "$T/mail.log" && last_subject | grep -q 'on TatvaOS production (Mumbai)' \
  && ok "MEMORY_ALERT_HOST names the box in the subject and the signature (its hostname is 'localhost')" || bad "host label" "$(last_subject)"

echo "== rehearsal and dry run"
reset; run; cp "$T/state" "$T/state.before"
MEMORY_ALERT_FORCE=1 bash "$SCRIPT" > "$T/out" 2>&1
[ "$(mails)" = 1 ] && last_subject | grep -q '\[TEST\]' && ok "FORCE sends a [TEST] message" || bad "force" "mails=$(mails)"
cmp -s "$T/state" "$T/state.before" && ok "…and leaves the state file untouched" || bad "force touched state"
psi 50.00 20.00; MEMORY_ALERT_DRYRUN=1 MEMORY_ALERT_TO= bash "$SCRIPT" > "$T/out" 2>&1
[ "$(mails)" = 1 ] && grep -q 'DRY RUN' "$T/out" && grep -q 'crit' "$T/out" && ok "DRYRUN prints the would-be message, sends nothing, needs no recipient" || bad "dryrun" "mails=$(mails)"
MEMORY_ALERT_TO= DISK_ALERT_TO= bash "$SCRIPT" > "$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && ok "no recipient at all: refuses to run (exit 2) rather than alert nobody" || bad "no recipient" "rc=$rc"

echo
echo "  passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]
