#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  connect-wire-test.sh — run the LiveKit wire-format tests.
#
#  WHAT THIS GUARDS
#
#  ConnectWebhookEndpoints read LiveKit's `createdAt` with TryGetInt64.
#  protojson sends int64 as a JSON *string* and TryGetInt64 THROWS on a
#  string — it does not return false. The handler 500'd, LiveKit retried five
#  times and discarded the event, and connect.meeting_events was empty from
#  the day the module shipped: no attendance, no started_at, no meeting ever
#  reaching 'ended', and a notes worker reading a table that could not have a
#  row in it. Twelve hours to find. One line to fix.
#
#  tests/connect-wire feeds the REAL ConnectWire.cs real LiveKit payloads and
#  finds that class of bug in under a second. Run it before every commit that
#  touches anything under Modules/Connect.
#
#  WHERE IT RUNS
#
#  Anywhere the .NET SDK is — your build machine, CI, a laptop. It needs no
#  network, no database, no LiveKit and no containers, because nothing in
#  ConnectWire talks to anything. On Windows just run the dotnet line at the
#  bottom of this comment; you do not need bash for it:
#
#      dotnet run --project tests/connect-wire
#
#  Exit 0 = every assertion held. Exit 1 = read the FAIL lines.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

# Repo root, found from this script rather than from the caller's cwd — the
# same rule as the other scripts here, so it works from anywhere.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project="$root/tests/connect-wire"

if [[ ! -f "$project/connect-wire.csproj" ]]; then
    echo "  the test project is not at $project" >&2
    echo "  this script must live at infra/scripts/ inside the repo" >&2
    exit 2
fi

if ! command -v dotnet >/dev/null 2>&1; then
    cat >&2 <<'MSG'

  The .NET SDK is not on this machine.

  These tests compile ConnectWire.cs and run it, so they need the SDK — not
  the runtime. That is deliberate: the whole point is to test the file you
  are about to commit, not the one already in an image.

  Run them on your build machine instead:

      dotnet run --project tests/connect-wire

MSG
    exit 2
fi

# --nologo keeps the first-run banner out of the output; -v q keeps the build
# quiet so the only thing on screen is the assertions.
cd "$root" || exit 2
dotnet run --project "$project" --nologo -v q
status=$?

if [[ $status -ne 0 ]]; then
    cat >&2 <<'MSG'
  ──────────────────────────────────────────────────────────────────────────
  A wire test failed. Before changing the test, check the fixture.

  The fixtures in tests/connect-wire/Fixtures.cs are real LiveKit payloads,
  not payloads written to make a test pass. If a fixture and the code
  disagree, the code is the thing that is wrong far more often than not —
  that is the entire history of this file.
  ──────────────────────────────────────────────────────────────────────────
MSG
fi

exit $status
