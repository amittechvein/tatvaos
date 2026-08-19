#!/usr/bin/env bash
#
# ═══════════════════════════════════════════════════════════════════════════
#  connect-whisper-test.sh — self-hosted transcription, checked two ways.
#
#      bash infra/scripts/connect-whisper-test.sh
#
#  1. THE CONTRACT. infra/whisper/app.py has to speak exactly the request
#     ConnectTranscriber sends and exactly the response it reads. Getting
#     that slightly wrong produces a transcript with no timeline — notes that
#     look fine and cannot tell a two-minute answer from a passing remark.
#     The test builds the multipart form field for field from the C# side.
#     faster-whisper itself is faked: the thing under test is the contract,
#     and a real model would make this a test of whether a download worked.
#
#  2. THE RENDER. What runs is not the file on disk — two overlays are
#     merged, ${VAR} is interpolated, and short volume syntax becomes long.
#     One of those places is where the recordings volume loses its :ro and a
#     transcription service quietly gains the ability to delete recordings.
#     So the rendered config is asserted, not the source.
#
#  Needs python3 and fastapi for (1); docker and pyyaml for (2). Either can
#  be missing — the script says which it skipped rather than passing quietly.
#
#  EXIT CODES MATCH THE OTHER connect-*-test.sh SCRIPTS, and they have to:
#  connect-test.sh reads 2 as "this machine cannot run it" and anything else
#  non-zero as a failure. This script had them the other way round for about
#  ten minutes, which would have reported a missing fastapi as a failing test
#  on the box and a real failure as a skip.
#
#      0 = everything that could run, passed
#      1 = something FAILED
#      2 = nothing failed, but something could not run here
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2

[[ -f "$root/infra/whisper/app.py" ]] || {
    echo "  infra/whisper/app.py is missing — unpack it first." >&2; exit 2; }

# TWO FLAGS, NOT ONE COUNTER.
#
# A single "worst" variable ranked 0 < 1 < 2 hid a real failure: part one
# failing set it to 1, part two skipping then raised it to 2, and 2 means
# "could not run". The failure disappeared into a skip. Skipping and failing
# are not points on one scale — they are two different facts and a run can
# have both.
failed=0
skipped=0

# ── 1. the contract ────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────────────────────────"
echo "  The /v1/audio/transcriptions contract"
echo "─────────────────────────────────────────────────────────────────"

if ! command -v python3 >/dev/null 2>&1; then
    echo "  SKIPPED: no python3 on this machine."
    skipped=1
elif ! python3 -c "import fastapi, multipart" >/dev/null 2>&1; then
    cat <<'MSG'
  SKIPPED: fastapi is not installed here.

      pip install fastapi 'uvicorn[standard]' python-multipart httpx

  Nothing needs to be running — the test drives the app in-process.
MSG
    skipped=1
else
    python3 "$root/tests/connect-whisper/test.py" || failed=1
fi

# ── 2. the render ──────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────────────────────────"
echo "  What compose actually renders"
echo "─────────────────────────────────────────────────────────────────"

env_file="$root/infra/docker/.env"
if ! command -v docker >/dev/null 2>&1; then
    echo "  SKIPPED: no docker on this machine — run this part on the box."
    skipped=1
elif [[ ! -f "$env_file" ]]; then
    echo "  SKIPPED: infra/docker/.env not found — run this part on the box."
    skipped=1
else
    # --profile whisper, because without it the service is correctly absent
    # and this would report a missing service as a failure.
    rendered="$(docker compose \
        -f "$root/infra/docker/docker-compose.base.yml" \
        -f "$root/infra/docker/docker-compose.production.yml" \
        --env-file "$env_file" --profile whisper config 2>/dev/null)"
    if [[ -z "$rendered" ]]; then
        echo "  FAILED: compose could not render the config. Run the same command by hand to see why." >&2
        failed=1
    else
        printf '%s' "$rendered" | python3 "$root/tests/connect-whisper/compose_check.py" || failed=1
    fi
fi

echo
# A FAILURE OUTRANKS A SKIP. If half of this could not run and the other half
# found something wrong, the answer is "something is wrong" — the skip is a
# footnote, not the headline.
if [[ $failed -ne 0 ]]; then
    echo "  Something failed. Do not commit it."
    [[ $skipped -ne 0 ]] && echo "  (and some checks could not run here either)"
    exit 1
fi
if [[ $skipped -ne 0 ]]; then
    echo "  Some checks could not run here. Nothing failed."
    exit 2
fi
echo "  Transcription checks passed."
exit 0
