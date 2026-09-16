#!/usr/bin/env bash
# Sourced by infra/scripts/deploy.sh — not run on its own. Moved out of
# deploy.sh unchanged so that infra/scripts/verify-rollback-point.sh can
# drive it without a production box.
#
# Expects from deploy.sh: COMPOSE, D, X, Y, note().

rollback_point() {
# ---------------------------------------------------------------------------
#  WHAT IS RUNNING NOW — the rollback point.
#
#  THE CHECKOUT AND THE RUNNING SYSTEM ARE DIFFERENT THINGS, and every question
#  of the form "which version is this?" has to name which one it is asking
#  about. Getting that wrong has cost three separate incidents: the x-build
#  regression, a written rollback instruction that read the wrong source, and
#  two wrong-branch deploys.
#
#  `git rev-parse HEAD` answers "what is this directory sitting on". That is
#  NOT the running commit:
#
#    - By the time this script runs, the operator has already done
#      `git reset --hard origin/main` — this script never fetches or resets.
#      So git holds the commit we are deploying TO. Recorded as a rollback
#      point that is worse than useless: rolling back to it redeploys the
#      thing you are rolling back from. HOUSE_RULES rule 11 said exactly that
#      until 9 Sept 2026.
#
#    - The two drift on their own. A deploy that fails after the reset leaves
#      the checkout ahead of the containers, silently, and git goes on
#      answering confidently.
#
#  apps/web/Dockerfile bakes BUILD_SHA into the image, so the RUNNING CONTAINER
#  carries the commit it was actually built from. That is the only source that
#  survives someone debugging in this directory.
# ---------------------------------------------------------------------------
_web_cid=$($COMPOSE ps -q web 2>/dev/null | head -1)
RUNNING_SHA=""
[ -n "$_web_cid" ] && RUNNING_SHA=$(docker inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' "$_web_cid" 2>/dev/null \
    | sed -n 's/^BUILD_SHA=//p' | head -1)

if [ -n "$RUNNING_SHA" ]; then
    printf '   %srunning%s  %s   <- the commit SERVING TRAFFIC right now\n' \
        "$D" "$X" "$(printf '%s' "$RUNNING_SHA" | cut -c1-7)"
    printf '   %srollback%s git reset --hard %s   # then re-run this script\n' \
        "$D" "$X" "$(printf '%s' "$RUNNING_SHA" | cut -c1-7)"
else
    printf '   %s[warn]%s no BUILD_SHA on the running web container.\n' "$Y" "$X"
    note "No rollback point can be printed. Either nothing is running yet (a"
    note "first deploy — fine), or the running image predates the build stamp."
    note "Do NOT substitute 'git rev-parse HEAD': it answers a different"
    note "question and will hand you the commit you are about to deploy."
fi

}
