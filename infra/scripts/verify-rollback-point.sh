#!/usr/bin/env bash
# ============================================================================
#  Prove the rollback line deploy.sh prints names the right commit, in full.
#
#      bash infra/scripts/verify-rollback-point.sh
#
#  Exit 0 = right on every deploy. Exit 1 = wrong. Exit 2 = could not run.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY, 17 SEPTEMBER 2026 (CTO ruling after the 16th).
#
#   The rollback line is what a person reads at the worst moment, and it was
#   wrong in two independent ways:
#
#   1. SHORT. It printed seven characters. The Deploy production workflow
#      hands `ref` to actions/checkout, which cannot resolve a short id, so
#      following the line verbatim failed (15 Sept).
#
#   2. FROM THE CONTAINER. It read BUILD_SHA from the live web container. On
#      16 Sept one session deployed 1842760 by hand and another deployed the
#      same commit through the workflow minutes later; the second deploy's
#      "rollback" named 1842760 — the commit already live. It pointed at
#      itself. The real rollback target was 82b9c3b.
#
#   So this drives infra/scripts/deploy-rollback-point.sh — the file deploy.sh
#   sources — through a scratch git repository deployed FOUR times, the third
#   being the same commit again by a second route:
#
#        deploy C1  (first ever)   ->  must not claim a rollback point
#        deploy C2                 ->  rollback C1
#        deploy C2 again           ->  rollback C1, NOT C2        (16 Sept)
#        deploy C3                 ->  rollback C2
#
#   and on every line: all forty characters.
#
#   NO PRODUCTION BOX. `docker` and `$COMPOSE` are shell functions here that
#   answer the two questions the file asks — "which container is web" and
#   "what is its environment" — from what the harness last "deployed". Each
#   deploy also records itself through record_deploy when the sourced file
#   defines one, exactly as deploy.sh does after its verdict passes.
# ============================================================================

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-rollback-point.sh"
[ -f "$LIB" ] || { echo "cannot find $LIB — cannot run."; exit 2; }
command -v git >/dev/null 2>&1 || { echo "git is not on PATH — cannot run."; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REPO="$WORK/repo"

git init -q "$REPO"
cd "$REPO" || exit 2
git config user.email harness@tatvaos.local
git config user.name "rollback harness"
for n in 1 2 3; do
  echo "$n" > f && git add f && git commit -q -m "C$n"
done
C1=$(git rev-parse HEAD~2); C2=$(git rev-parse HEAD~1); C3=$(git rev-parse HEAD)

# What the web container is running, as far as `docker inspect` can tell.
RUNNING=""

# The two commands the rollback file reaches for, answered from the harness.
fake_compose() { [ "${1:-}" = "ps" ] && [ -n "$RUNNING" ] && echo "web-container-id"; }
docker() {
  if [ "${1:-}" = "inspect" ] && [ -n "$RUNNING" ]; then
    printf 'PATH=/usr/bin\nBUILD_SHA=%s\n' "$RUNNING"
  fi
}
COMPOSE=fake_compose
D=""; X=""; Y=""; G=""; R=""; B=""; C=""
note() { printf '   %s\n' "$1"; }
ok()   { printf '   [ ok ] %s\n' "$1"; }
bad()  { printf '   [FAIL] %s\n' "$1"; }
ENV=production

# shellcheck source=infra/scripts/deploy-rollback-point.sh
. "$LIB"

PASS=0; FAIL=0
yes_() { printf '  [PASS] %s\n' "$1"; PASS=$((PASS + 1)); }
no_()  { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); }
name() { case "$1" in "$C1") echo C1 ;; "$C2") echo C2 ;; "$C3") echo C3 ;; "") echo "(none)" ;; *) echo "$1" ;; esac; }

# One deploy: reset the checkout to the target (as the workflow does), print
# the rollback point (as deploy.sh does), bring the "containers" up on the
# target, record it (as deploy.sh does after a passing verdict).
deploy() {
  local target="$1"
  git -C "$REPO" reset -q --hard "$target"
  OUT=$(cd "$REPO" && rollback_point 2>&1)
  RUNNING="$target"
  if declare -F record_deploy >/dev/null; then (cd "$REPO" && record_deploy >/dev/null 2>&1); fi
  # The id on the rollback line, whatever its length.
  ROLLBACK_ID=$(printf '%s\n' "$OUT" | grep -i 'rollback' | grep -oE '\b[0-9a-f]{7,40}\b' | head -1)
}

check() {  # check <label> <expected-full-sha-or-empty>
  local label="$1" want="$2"
  echo
  echo "== $label"
  printf '%s\n' "$OUT" | sed 's/^/     | /'
  if [ -z "$want" ]; then
    [ -z "$ROLLBACK_ID" ] && yes_ "no rollback point is claimed — nothing earlier was deployed" \
                          || no_ "a rollback point was claimed ($(name "$ROLLBACK_ID")) with no earlier deploy"
    return
  fi
  [ "${#ROLLBACK_ID}" = 40 ] && yes_ "the rollback id is the full 40 characters" \
                             || no_ "the rollback id is ${#ROLLBACK_ID} characters ('$ROLLBACK_ID') — actions/checkout cannot resolve that"
  local full=""
  [ -n "$ROLLBACK_ID" ] && full=$(git -C "$REPO" rev-parse --verify --quiet "$ROLLBACK_ID^{commit}" 2>/dev/null)
  [ "$full" = "$want" ] && yes_ "it names $(name "$want")" \
                        || no_ "it names $(name "$full"), want $(name "$want")"
}

deploy "$C1"; check "deploy C1 — the first ever" ""
deploy "$C2"; check "deploy C2" "$C1"
deploy "$C2"; check "deploy C2 AGAIN, by a second route (16 Sept)" "$C1"
deploy "$C3"; check "deploy C3" "$C2"

echo
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ]
