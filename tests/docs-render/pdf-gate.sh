#!/usr/bin/env bash
# ============================================================================
#  The PDF gate, run in the render container's own limits
# ============================================================================
#
#  Decision 0011 condition 2; docs/DOCS_PDF_DESIGN.md §5 and §8. Builds the
#  REAL render image (apps/render/Dockerfile: Typst and fonts from Alpine's
#  signed repository), puts the gate's test tools on top of it
#  (apps/render/Dockerfile.pdf-gate — never deployed), and runs
#  tests/docs-render/pdf-gate.mjs inside it with the production limits: no
#  network at all, read-only, a 16 MB /tmp, 512 MB, 1 CPU, 64 processes, no
#  capabilities, no privilege escalation, a non-root user.
#
#  On the laptop, the Docker ENGINE inside WSL only (never Docker Desktop —
#  refused below), as root:
#
#    wsl -u root -e bash tests/docs-render/pdf-gate.sh
#
#  Sample PDFs land in $PDF_GATE_OUT (default: .tmp/pdf-gate in the
#  checkout) for the people who check them.
# ============================================================================

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${PDF_GATE_OUT:-$ROOT/.tmp/pdf-gate}"
mkdir -p "$OUT" && chmod 777 "$OUT"

STARTED=0
if ! docker info >/dev/null 2>&1; then
  { systemctl start docker 2>/dev/null || service docker start; } >/dev/null 2>&1
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || { echo "the Docker engine did not start"; exit 2; }
  STARTED=1
fi
stop_engine() {
  if [ "$STARTED" = 1 ]; then
    { systemctl stop docker.service docker.socket 2>/dev/null || service docker stop; } >/dev/null 2>&1
    echo "  (the Docker engine was started for this run and is stopped again: $(pgrep -x dockerd >/dev/null && echo STILL RUNNING || echo stopped))"
  fi
}
trap stop_engine EXIT

# Not Docker Desktop (see container-test.sh, PR 369): with it running, its WSL
# socket answers here and the whole run would quietly happen on it.
DAEMON_OS="$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)"
case "$DAEMON_OS" in
  *"Docker Desktop"*) echo "REFUSED: the daemon answering is Docker Desktop, not the Docker engine in WSL."; exit 2 ;;
esac
echo "  (daemon: $DAEMON_OS)"

TAG=tatvaos-render:pdf-gate
echo "== build the render image (Typst and fonts from Alpine's repository)"
if ! docker build -q -f "$ROOT/apps/render/Dockerfile" -t "$TAG" "$ROOT" >/dev/null; then
  echo "  FAIL  the render image did not build"; exit 1
fi
echo "  render image: $(docker image inspect -f '{{.Size}}' "$TAG" | awk '{printf "%.0f MB", $1/1000000}')"
echo "== put the gate's tools on top of it (test only)"
docker build -q -f "$ROOT/apps/render/Dockerfile.pdf-gate" --build-arg RENDER_IMAGE="$TAG" -t "$TAG-tools" "$ROOT" >/dev/null \
  || { echo "  FAIL  the gate image did not build"; exit 1; }

echo "== the gate, inside the render container's limits"
docker run --rm \
  --network none --read-only --tmpfs /tmp:rw,size=16m,mode=1777 \
  --memory 512m --cpus 1 --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  -v "$ROOT/tests/docs-render:/gate:ro" -v "$OUT:/out" -e GATE_OUT=/out \
  -w /app/apps/render \
  "$TAG-tools" node --import ./src/register.mjs /gate/pdf-gate.mjs
RC=$?
echo "  (sample PDFs: $OUT)"
exit $RC
