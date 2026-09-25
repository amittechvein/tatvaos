#!/bin/bash
# ============================================================================
#  TatvaOS Bugs — deploy (server side). Mr. Singh, PR 301 condition 4.
#
#  This is a SECOND route by which code reaches the production server, so it
#  takes the SAME lock as infra/scripts/deploy.sh (/tmp/tatvaos-deploy-
#  production.lock, flock on fd 9) and holds it for the whole build and
#  restart. A product deploy started meanwhile refuses with "held by", and this
#  refuses while a product deploy runs. Two builds on this four-core box at once
#  is the overlap we keep being caught by.
#
#  Every run needs Amit's go, like any production change.
#
#  Route (from the laptop, folder tatvaos-bugs):
#    1. upload the new code to a STAGING folder (nothing live changes):
#         (cd apps/bugs && tar --exclude=.data -czf - .) | ssh deploy@<server> \
#           'rm -rf ~/tatvaos-bugs-incoming && mkdir ~/tatvaos-bugs-incoming && tar -xzf - -C ~/tatvaos-bugs-incoming'
#    2. run this script FROM the staging folder:
#         ssh deploy@<server> 'bash ~/tatvaos-bugs-incoming/deploy/deploy-bugs.sh < /dev/null'
#
#  It keeps deploy/.env (the server's own settings), keeps the data volume, tags
#  the running image as :previous first, and fails loudly if the row counts
#  change across the restart. Roll back:
#    docker tag tatvaos-bugs-bugs:previous tatvaos-bugs-bugs:latest
#    cd ~/tatvaos-bugs/deploy && docker compose up -d --no-build
# ============================================================================
set -uo pipefail

INCOMING="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="$HOME/tatvaos-bugs"
LOCKFILE="/tmp/tatvaos-deploy-production.lock"
IMAGE="tatvaos-bugs-bugs"
say() { echo "== $*"; }
die() { echo "[FAIL] $*"; exit 1; }

[ "$INCOMING" != "$LIVE" ] || die "run this from the staging folder (~/tatvaos-bugs-incoming), not the live one"
[ -f "$INCOMING/src/server.mjs" ] || die "no src/server.mjs in $INCOMING — upload step 1 first"

say "lock (shared with the product's deploy.sh)"
exec 9>>"$LOCKFILE"
if ! flock -n 9; then
  die "a deploy holds the lock — held by: $(cat "$LOCKFILE" 2>/dev/null || echo unknown). Nothing changed."
fi
printf 'tatvaos-bugs deploy %s pid %s user %s from %s\n' "$(date -u +%FT%TZ)" "$$" "$(id -un)" "${SSH_CONNECTION:-local}" > "$LOCKFILE"
if pgrep -f "infra/scripts/deploy.sh" >/dev/null; then die "a product deploy.sh is running (outside the lock?) — refusing"; fi
echo "held"

counts() { docker exec tatvaos-bugs node -e '
  const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync("/data/bugs.db", { readOnly: true });
  console.log(["users","issues","activity","attachments"].map(t => t + "=" + d.prepare("SELECT COUNT(*) n FROM " + t).get().n).join(" "));' 2>/dev/null; }

say "before"
BEFORE=$(counts) || die "the running tracker did not answer — not deploying over an unknown state"
echo "$BEFORE"
docker tag "$IMAGE:latest" "$IMAGE:previous" 2>/dev/null && echo "tagged running image as $IMAGE:previous (rollback)"

say "copy code into the live folder (deploy/.env kept)"
tar -C "$INCOMING" --exclude=deploy/.env --exclude=.data -cf - . | tar -C "$LIVE" -xf - || die "copy failed"
[ -f "$LIVE/deploy/.env" ] || die "deploy/.env is missing in $LIVE"

say "build and restart (tracker only)"
cd "$LIVE/deploy" || die "no $LIVE/deploy"
docker compose build 2>&1 | tail -2 || die "build failed — the old container is still running"
docker compose up -d 2>&1 | tail -1
s=unknown
for _ in $(seq 1 30); do s=$(docker inspect -f '{{.State.Health.Status}}' tatvaos-bugs 2>/dev/null); [ "$s" = healthy ] && break; sleep 2; done
[ "$s" = healthy ] || die "not healthy after restart ($s) — roll back with the two lines at the top of this script"

say "after"
AFTER=$(counts)
echo "$AFTER"
# People may file reports while it builds, so counts may GROW; history is
# append-only, so any count going DOWN means data was lost.
for kv in $BEFORE; do
  k=${kv%%=*}; b=${kv#*=}; a=$(printf '%s\n' $AFTER | grep "^$k=" | cut -d= -f2)
  [ -n "$a" ] && [ "$a" -ge "$b" ] || die "$k went from $b to ${a:-nothing} across the restart"
done
echo "[ ok ] deployed; no data lost; lock released on exit"
