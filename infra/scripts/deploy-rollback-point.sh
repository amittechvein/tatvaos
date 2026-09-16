#!/usr/bin/env bash
# Sourced by infra/scripts/deploy.sh — not run on its own. Kept in its own
# file so infra/scripts/verify-rollback-point.sh can drive it without a
# production box.
#
# Expects from deploy.sh: ENV, COMPOSE, D, X, Y, note().
#
# ---------------------------------------------------------------------------
#  THE ROLLBACK POINT — what to return to if this deploy is wrong.
#
#  This is the line a person reads at the worst possible moment. It has to be
#  right when everything else is wrong. It has been wrong three ways:
#
#  1. FROM THE CHECKOUT. `git rev-parse HEAD` answers "what is this directory
#     sitting on", and by the time deploy.sh runs the checkout has already
#     been reset to the commit being deployed TO. Rolling back to it
#     redeploys the thing you are rolling back from. (HOUSE_RULES rule 11 said
#     exactly that until 9 Sept 2026.)
#
#  2. FROM THE CONTAINER. The fix for (1) read BUILD_SHA out of the running
#     web container. That is what is serving — but on 16 Sept one session
#     deployed 1842760 by hand and another deployed the same commit through
#     the workflow minutes later, and the second deploy's "rollback" named
#     1842760: the commit already live. It pointed at itself. The real
#     rollback target was 82b9c3b.
#
#  3. SHORT. Seven characters. The Deploy production workflow hands `ref` to
#     actions/checkout, which cannot resolve a short id, so following the line
#     verbatim failed on 15 Sept.
#
#  WHAT IT READS NOW: A RECORD OF SUCCESSFUL DEPLOYS. record_deploy, called by
#  deploy.sh only after its verdict passes, appends the full commit, the
#  environment and the time to a file inside this checkout's .git directory —
#  untouched by `git reset --hard` and `git clean`, never tracked, never
#  pushed. The rollback point is THE MOST RECENT RECORDED DEPLOY OF A
#  DIFFERENT COMMIT. That answers "what was live before this" whichever route
#  deployed it — the workflow and a hand deploy both run this script — and a
#  second deploy of the same commit cannot name itself.
#
#  A deploy that FAILS is not recorded, on purpose: the thing to return to is
#  the last one that passed, not the one that half-landed.
#
#  If the record is empty — the first deploy after this landed, or a rebuilt
#  box — it says so and points at the workflow's run history. It does NOT fall
#  back to the container or the checkout: both are (1) and (2) above, and a
#  confident wrong answer here is worse than an honest "look it up".
#
#  proven by infra/scripts/verify-rollback-point.sh.
# ---------------------------------------------------------------------------

# The record. Common git dir, absolute, so a worktree of the checkout and the
# checkout itself read the same file. Made absolute with cd/pwd rather than
# `rev-parse --path-format=absolute`, which needs git 2.31 — and nobody has
# confirmed the production box's version from here.
deploy_history_file() {
    local dir
    dir=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
    dir=$(cd "$dir" 2>/dev/null && pwd) || return 1
    printf '%s/tatvaos-deploy-history' "$dir"
}

# Called by deploy.sh after a PASSING verdict, and nowhere else.
record_deploy() {
    local file sha
    file=$(deploy_history_file) || return 1
    sha=$(git rev-parse HEAD 2>/dev/null) || return 1
    printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" "$ENV" >> "$file"
}

rollback_point() {
    local target file prev="" serving=""
    target=$(git rev-parse HEAD 2>/dev/null || true)
    file=$(deploy_history_file || true)

    # Most recent recorded deploy, in this environment, of a commit that is
    # not the one about to be deployed.
    if [ -n "$file" ] && [ -f "$file" ]; then
        prev=$(awk -v env="$ENV" -v t="$target" \
            '$3 == env && $2 != t && length($2) == 40 { p = $2 } END { print p }' "$file")
    fi

    # What the web container says it is serving. INFORMATION ONLY — see (2)
    # above for why this is never the rollback point. Deliberately does not
    # use the word the verify script looks for on this line.
    local _web_cid
    _web_cid=$($COMPOSE ps -q web 2>/dev/null | head -1)
    [ -n "$_web_cid" ] && serving=$(docker inspect \
        --format '{{range .Config.Env}}{{println .}}{{end}}' "$_web_cid" 2>/dev/null \
        | sed -n 's/^BUILD_SHA=//p' | head -1)
    if [ -n "$serving" ]; then
        printf '   %sserving%s  %s   <- the web container'"'"'s build stamp, for information\n' \
            "$D" "$X" "$serving"
    fi

    if [ -n "$prev" ]; then
        printf '   %srollback%s %s   <- the last successful %s deploy of a different commit\n' \
            "$D" "$X" "$prev" "$ENV"
        note "to return to it, from tatvaOS/ on the laptop, through the one route to production:"
        note "  gh workflow run deploy-production.yml -f confirm=production -f ref=$prev"
    else
        printf '   %s[warn]%s no earlier deploy of a different commit is recorded on this box.\n' "$Y" "$X"
        note "Take the return point from the workflow's history instead — the most"
        note "recent SUCCESSFUL run whose commit differs from this one, all 40 characters:"
        note "  gh run list --workflow deploy-production.yml --status success --json headSha,createdAt"
        note "Do NOT use the serving stamp above or 'git rev-parse HEAD': the first"
        note "can be this very commit, and the second always is."
    fi
}
