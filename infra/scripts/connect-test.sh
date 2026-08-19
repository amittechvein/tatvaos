#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  connect-test.sh — everything about Connect that can be proved without a
#  server, a database, a media server or a browser.
#
#      bash infra/scripts/connect-test.sh
#
#  Run it before every commit that touches apps/api/Modules/Connect,
#  apps/web/lib/pip.ts or infra/whisper. It takes seconds and needs nothing
#  running — the parts that need docker or a python package say so and are
#  reported as SKIPPED rather than passing quietly.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THESE FOUR, AND WHY NOT MORE.
#
#   Each one exists because something already went wrong, and each covers a
#   place where a mistake is INVISIBLE until it is expensive:
#
#     wire     — LiveKit's JSON. One line read an int64 with TryGetInt64;
#                protojson sends int64 as a string and TryGetInt64 THROWS.
#                Unhandled 500, LiveKit gave up after five retries, and
#                connect.meeting_events was empty from the day the module
#                shipped. No attendance, no started_at, no meeting ever
#                ending, notes for nobody. Twelve hours to find.
#
#     minutes  — the document that leaves the platform. One renderer feeds
#                the page, the download and the email, so a mistake in it is
#                a mistake in all three, in front of the customer.
#
#     pip      — the floating window builds DOM by hand, so it reconciles by
#                hand. Rebuilding restarts every video; dropping a tile
#                without detaching leaks a decoder. Neither is visible on a
#                fast machine.
#
#     whisper  — the transcription shim has to speak the exact contract the
#                API sends, and its compose service has to keep the
#                recordings volume READ ONLY. A transcription service that
#                can delete recordings is one that eventually will.
#
#   What this CANNOT tell you: that a recording records, that a webhook
#   arrives, that RLS holds. Those need the box — infra/scripts/
#   connect-recording-verify.sh and connect-phase1-verify.sh, after deploy.
#  ─────────────────────────────────────────────────────────────────────────
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2

declare -a names=()
declare -a codes=()

run() {
    local label="$1" script="$2"
    echo
    echo "─────────────────────────────────────────────────────────────────"
    echo "  $label"
    echo "─────────────────────────────────────────────────────────────────"
    bash "$root/infra/scripts/$script"
    local code=$?
    names+=("$label")
    codes+=("$code")
}

run "LiveKit wire format"   connect-wire-test.sh
run "Minutes of meeting"    connect-minutes-test.sh
run "Picture-in-Picture"    connect-pip-test.sh
run "Transcription"         connect-whisper-test.sh

echo
echo "═════════════════════════════════════════════════════════════════"
worst=0
for i in "${!names[@]}"; do
    case "${codes[$i]}" in
        0) printf '  passed   %s\n' "${names[$i]}" ;;
        # 2 is "this machine cannot run it" — no SDK, no node. That is not a
        # failing test and must not be reported as one, or it stops meaning
        # anything on the box.
        2) printf '  SKIPPED  %s (see the message above)\n' "${names[$i]}"
           [ "$worst" -lt 1 ] && worst=1 ;;
        *) printf '  FAILED   %s\n' "${names[$i]}"; worst=2 ;;
    esac
done
echo "═════════════════════════════════════════════════════════════════"
echo

# A skip exits 1, not 0: "it did not fail" and "it did not run" are different
# answers and a caller should be able to tell them apart.
case "$worst" in
    0) echo "  All Connect tests passed."; exit 0 ;;
    1) echo "  Some tests could not run on this machine. Nothing failed."; exit 1 ;;
    *) echo "  Something failed. Do not commit it."; exit 2 ;;
esac
