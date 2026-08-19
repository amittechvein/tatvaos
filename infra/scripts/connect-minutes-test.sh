#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  connect-minutes-test.sh — the Minutes of Meeting document, tested.
#
#  ConnectMinutes is ONE renderer behind three surfaces: the page, the file
#  somebody downloads, and the email sent to attendees. One renderer was
#  deliberate — three would drift — and the price is that a mistake here is a
#  mistake in all three at once.
#
#  So this checks the things that actually matter about a record: that absent
#  facts produce no empty headings, that a mechanical digest never reads like
#  a written summary, that attendees with no email address are COUNTED rather
#  than quietly dropped, that every string from a person or a model is
#  HTML-encoded, that timestamps are in the organisation's clock, and that the
#  markup stays email-safe.
#
#      bash infra/scripts/connect-minutes-test.sh
#
#  DUMP=1 also writes the rendered document to a temp folder. Open it. The
#  assertions catch what somebody thought to assert; looking catches the rest.
#
#  Exit 0 = every assertion held.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

# Repo root, found from this script rather than from the caller's cwd — the
# same rule as the other scripts here, so it works from anywhere.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
project="$root/tests/connect-minutes"

if [[ ! -f "$project/connect-minutes.csproj" ]]; then
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

      dotnet run --project tests/connect-minutes

MSG
    exit 2
fi

# --nologo keeps the first-run banner out of the output; -v q keeps the build
# quiet so the only thing on screen is the assertions.
cd "$root" || exit 2
DUMP="${DUMP:-}" dotnet run --project "$project" --nologo -v q
status=$?

if [[ $status -ne 0 ]]; then
    cat >&2 <<'MSG'
  ──────────────────────────────────────────────────────────────────────────
  A minutes test failed.

  The fixtures in tests/connect-minutes/Fixtures.cs are real LiveKit payloads,
  not payloads written to make a test pass. If a fixture and the code
  disagree, the code is the thing that is wrong far more often than not —
  that is the entire history of this file.
  ──────────────────────────────────────────────────────────────────────────
MSG
fi

exit $status
