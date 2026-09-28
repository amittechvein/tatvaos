#!/usr/bin/env bash
#
# TatvaOS Mail — deploy to a cloud environment
#
#   ./deploy.sh production
#
# Run ON the target server, from the repo checkout.
#
# There was a second environment ("testing") with outbound mail contained to
# Mailpit. It was removed once 172.105.57.198 was promoted to production and
# nothing was left running it. If a real staging box ever exists again, it
# needs its own overlay — do NOT deploy the production overlay to it, because
# production sets RELAY_TO_MAILPIT=false and test mail would reach real people.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

ENV="${1:-}"
c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); B=$(c $'\033[1m'); X=$(c $'\033[0m')

# ---------------------------------------------------------------------------
#  bad() COUNTS. It used to only print.
#
#  On 27 August this script printed [FAIL] lines for the certificate sync and
#  the mail-edge restart, then finished with "all 10 services running" and a
#  green "production deployed." over a mail server refusing every login.
#  Nothing was wrong with the checks — they fired correctly. The verdict simply
#  did not read them.
#
#  A red line that never reaches the exit status is a comment. Every bad() now
#  increments FAILURES, and the verdict at the bottom refuses to declare
#  success while FAILURES is non-zero.
#
#  Deliberately NOT `set -e`: several steps below fail on purpose and are
#  handled (the caddy reload, the certificate sync). The counter is how a
#  HANDLED failure still reaches the verdict instead of being swallowed by the
#  handling.
# ---------------------------------------------------------------------------
FAILURES=0

step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; FAILURES=$((FAILURES + 1)); }
note() { printf '   %s%s%s\n' "$D" "$1" "$X"; }

case "$ENV" in
    production) ;;
    testing)
        printf '\nThe testing environment was removed — its overlay no longer exists.\n'
        printf 'Use the local stack in local/ to rehearse, or build a new overlay.\n\n'
        exit 1 ;;
    *) printf '\nUsage: ./deploy.sh production\n\n'; exit 1 ;;
esac

# ---------------------------------------------------------------------------
#  RUN DETACHED, OR DO NOT RUN — HOUSE_RULES rule 11b (Mr. Singh, 27 Sept 2026).
#
#  On 26 September a hand deploy died at 13:58Z when the SSH session reset
#  during the pre-deploy backup. It had not reached the schema step, so
#  production was untouched — by luck: one step later and the box would have
#  been half-updated with nobody watching. It then sat unnoticed for three
#  hours, because the tool call driving it had timed out into the background.
#
#  A deploy attached to a terminal dies with that terminal. So this script
#  refuses to start when its output is a terminal, and prints the one command
#  that runs it correctly. The GitHub workflow and a detached run both write
#  to a file, so neither trips this. DEPLOY_ATTACHED=1 overrides it for a
#  local rehearsal, and is not for the production box.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ "${DEPLOY_ATTACHED:-}" != "1" ]; then
    printf '\n   [FAIL] deploy.sh is attached to a terminal. Run it detached, so a dropped\n'
    printf '          SSH session cannot kill it halfway (HOUSE_RULES rule 11b):\n\n'
    printf '     LOG=~/deploy-%s-$(date -u +%%Y%%m%%dT%%H%%M%%SZ).log\n' "$ENV"
    printf '     CI=1 setsid nohup ./infra/scripts/deploy.sh %s > "$LOG" 2>&1 < /dev/null &\n' "$ENV"
    printf '     tail -f "$LOG"        # Ctrl-C stops the tail only, never the deploy\n\n'
    printf '   The log ends in a DEPLOY VERDICT line. No verdict line = the deploy did not\n'
    printf '   finish: check the server before doing anything else.\n\n'
    exit 1
fi

# Every exit prints a verdict. A log with no "DEPLOY VERDICT" line was cut
# off — killed, or the box died — and rule 11b says that is a failure, not a
# maybe. The PASS line is printed by the success path at the bottom.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then printf "\n   DEPLOY VERDICT: FAIL (exit %s) at %s\n\n" "$rc" "$(date -u +%FT%TZ)"; fi' EXIT

# ---------------------------------------------------------------------------
#  ONE DEPLOYER AT A TIME — the lock rule 11 promised.
#
#  Since 29 August every lane deploys its own work, so two people reaching
#  this script in the same minute stopped being hypothetical. Two concurrent
#  deploys interleave `reset --hard`, container recreation and migrations on
#  one box — each half-succeeds and the box ends in a state neither asked
#  for. The thread announcement is etiquette; this is the mechanism.
#
#  flock on a file descriptor, not a touch-file: the kernel releases the
#  lock the instant this process exits, HOWEVER it exits — crash, Ctrl-C,
#  dropped SSH session. There is no stale-lock file to clean up, because
#  the lock is not the file, it is the process holding it. The file only
#  carries WHO, so the second deployer's refusal can name them.
# ---------------------------------------------------------------------------
LOCKFILE="/tmp/tatvaos-deploy-${ENV}.lock"
exec 9>>"$LOCKFILE"
if ! flock -n 9; then
    bad "Another deploy is already running on this box."
    note "Held by: $(cat "$LOCKFILE" 2>/dev/null || echo 'unknown — but the lock is real')"
    note "If that deploy is truly finished, its process is gone and this"
    note "lock is already free — re-run. If this message repeats, someone"
    note "is mid-deploy: find them in the thread before doing anything."
    exit 1
fi
printf '%s pid=%s user=%s (%s)\n' \
    "$(date -u +%FT%TZ)" "$$" "$(id -un)" "${SSH_CONNECTION:-local}" > "$LOCKFILE"

COMPOSE="docker compose \
    -f infra/docker/docker-compose.base.yml \
    -f infra/docker/docker-compose.${ENV}.yml \
    --env-file infra/docker/.env"

# ---------------------------------------------------------------------------
step "Preflight — ${ENV}"

[ -f infra/docker/.env ] || {
    bad "infra/docker/.env is missing"
    note "cp infra/docker/.env.${ENV}.example infra/docker/.env"
    note "then fill in every CHANGE_ME"
    exit 1
}

if grep -q 'CHANGE_ME' infra/docker/.env; then
    bad ".env still contains CHANGE_ME placeholders"
    note "Generate secrets with:  openssl rand -base64 32"
    exit 1
fi
ok "secrets present"

# ---------------------------------------------------------------------------
step "Settings files are private"
# ── .env AND EVERY COPY OF IT: READABLE BY THIS ACCOUNT ONLY, OR NO DEPLOY. ──
#  infra/docker/.env holds every production secret, and a copy of it is the
#  same secret in a second place. On 28 Sept 2026 .env was found at mode 664
#  — readable by every account on the server — with three copies beside it
#  the same way, one 52 days old. Nobody chose that: this account's umask is
#  002, so every file it creates is born world-readable unless the command
#  says otherwise. A runbook rule was written that day. A rule is a sentence.
#
#  Mr. Singh, 1 Oct 2026: the deploy REFUSES — it does not warn — because
#  the deploy is the one moment somebody is watching.
#
#  WHAT COUNTS: every file named .env* in the settings directory that is NOT
#  tracked by git. The tracked ones are the published examples
#  (.env.production.example): they are in the repository, git writes them
#  664, and a secret in one of them is a different mistake. Deciding by git
#  and not by the name "*.example" matters: a copy somebody called
#  .env.example.bak is a copy of the secrets, and is refused.
#
#  WHAT FAILS: any group or other permission bit at all (so 640 fails, not
#  only 644), or an owner that is not the account running the deploy.
#
#  OLD COPIES are named, not refused: removing a file is a person's decision
#  (docs/DEPLOY_RUNBOOK.md). The age comes from the UTC stamp in the NAME
#  when there is one — `cp -p` carries the original's date onto the copy, so
#  the file's own date says when .env was last edited, not when it was copied.
# ─────────────────────────────────────────────────────────────────────────
ENV_DIR=infra/docker
ME=$(id -un)
env_checked=0; env_bad=(); env_old=()
while IFS= read -r f; do
    [ -n "$f" ] || continue
    git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue
    env_checked=$((env_checked + 1))
    if [ -n "$(find "$f" -maxdepth 0 \( -perm /077 -o ! -user "$ME" \) 2>/dev/null)" ]; then
        env_bad+=("$f")
    fi
    [ "$f" = "$ENV_DIR/.env" ] && continue
    stamp=$(printf '%s' "$f" | grep -oE '20[0-9]{6}T?[0-9]{0,6}Z?$' | cut -c1-8 || true)
    if [ -n "$stamp" ] && born=$(date -u -d "$stamp" +%s 2>/dev/null); then :
    else born=$(stat -c %Y "$f"); fi
    [ $(( ( $(date -u +%s) - born ) / 86400 )) -gt 7 ] && env_old+=("$f")
done < <(find "$ENV_DIR" -maxdepth 1 -type f -name '.env*' 2>/dev/null | sort)

if [ "$env_checked" -eq 0 ]; then
    bad "found no settings file to check in $ENV_DIR — the check itself is broken; stopping"
    exit 1
fi
if [ "${#env_bad[@]}" -gt 0 ]; then
    bad "${#env_bad[@]} settings file(s) can be read by someone other than $ME — refusing to deploy"
    for f in "${env_bad[@]}"; do note "  $(stat -c 'mode %a, owner %U' "$f")  $f"; done
    note "Each holds production secrets. Fix, then deploy again:"
    note "  chmod 600 ${env_bad[*]}"
    note "and make copies with:  ( umask 077; cp .env .env.before-<reason>-\$(date -u +%Y%m%dT%H%M%SZ) )"
    exit 1
fi
ok "$env_checked settings file(s), each readable by $ME only"
if [ "${#env_old[@]}" -gt 0 ]; then
    note "${#env_old[@]} copy(ies) of .env older than seven days — remove by hand (docs/DEPLOY_RUNBOOK.md):"
    for f in "${env_old[@]}"; do note "  $f"; done
fi

# ---------------------------------------------------------------------------
#  Docker must exist AND be usable by this user.
#
#  Checked here because without it every later step fails individually while
#  the script carries on and prints "[ ok ] images ready" — a green line under
#  a command that never ran. A missing prerequisite should stop the deploy at
#  the top with one clear message, not produce fifty lines of noise ending in
#  "services did not stabilise".
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    bad "docker is not installed on this server"
    note "As root:  curl -fsSL https://get.docker.com | sh"
    note "          usermod -aG docker $(id -un)"
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    bad "docker is installed but this user cannot talk to the daemon"
    note "As root:  usermod -aG docker $(id -un)"
    note "Group membership applies to NEW sessions — reconnect afterwards."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    bad "the docker compose plugin is missing"
    note "As root:  apt-get install -y docker-compose-plugin"
    exit 1
fi
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present)"

# 1 GB runs Postfix and little else. The full stack on a Nanode will be
# OOM-killed partway through the build, which surfaces as a container that
# vanishes rather than as an obvious memory error.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 3500 ]; then
    printf '   %s[warn]%s %s MB RAM. The full stack wants 4 GB.\n' "$Y" "$X" "$MEM_MB"
    note "Resize the Linode, or expect the build to be OOM-killed."
fi

# ---------------------------------------------------------------------------
#  Environment marker.
#
#  Only production exists today, so this no longer guards against deploying the
#  wrong overlay — it guards against deploying to the wrong CHECKOUT. It stays
#  because the day a second environment appears is exactly the day someone
#  deploys production config to it, and outbound containment is the difference
#  between test mail and mail to real people.
# ---------------------------------------------------------------------------
# Per-checkout marker, not per-host: two environments could share one VPS, and
# a host-level file cannot tell them apart. Falls back to the host file for a
# dedicated server.
MARKER=""
[ -f .environment ] && MARKER=.environment
[ -z "$MARKER" ] && [ -f /etc/tatvaos-environment ] && MARKER=/etc/tatvaos-environment

if [ -n "$MARKER" ]; then
    DECLARED=$(tr -d '[:space:]' < "$MARKER")
    if [ "$DECLARED" != "$ENV" ]; then
        bad "This checkout is marked '${DECLARED}' but you asked to deploy '${ENV}'."
        note "Deploying the wrong environment's config can disable outbound"
        note "containment, which lets test mail reach real people."
        note "If genuinely intended, update ${MARKER} first."
        exit 1
    fi
    ok "checkout is marked ${DECLARED} (${MARKER})"
else
    printf '   %s[warn]%s No environment marker found.\n' "$Y" "$X"
    note "Set it once so a wrong-environment deploy is caught:"
    note "  echo ${ENV} > .environment"
fi

# ---------------------------------------------------------------------------
#  Branch guard.
#
#  This script deploys whatever the checkout happens to be sitting on, and used
#  to say nothing about what that was. A server left on a feature branch
#  therefore kept deploying successfully — green output, healthy containers —
#  while shipping none of the work that had been merged to main. A week of
#  deploys became no-ops and nothing anywhere reported a problem.
#
#  It failed the other way too: a branch that legitimately carried a whole
#  product was reset to main by someone assuming main was what was running, and
#  a live subdomain went dark because main did not contain it.
#
#  Both directions have the same root cause — the branch was invisible. So it is
#  printed on every run, and a production deploy from anything other than main
#  stops here.
# ---------------------------------------------------------------------------
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
printf '   %sbranch%s %s\n' "$D" "$X" "$BRANCH"

if [ "$ENV" = "production" ] && [ "$BRANCH" != "main" ]; then
    bad "Production deploys run from 'main'; this checkout is on '${BRANCH}'."
    note "Deploying a feature branch ships work nobody has reviewed, and"
    note "silently omits everything merged to main since it was cut."
    note "  git fetch origin && git checkout -B main origin/main"
    note "If this is genuinely intended, re-run with DEPLOY_ALLOW_BRANCH=1."
    [ "${DEPLOY_ALLOW_BRANCH:-}" = "1" ] || exit 1
    note "DEPLOY_ALLOW_BRANCH=1 — proceeding from ${BRANCH} anyway"
fi

# Detached HEAD deploys nothing anyone can name afterwards. Worth a warning
# even when the commit is correct, because "which commit is live" becomes
# unanswerable the moment the checkout moves on.
if [ "$BRANCH" = "HEAD" ]; then
    printf '   %s[warn]%s detached HEAD — no branch to attribute this deploy to.\n' "$Y" "$X"
fi

# The rollback point: what to return to if this deploy is wrong. See
# infra/scripts/deploy-rollback-point.sh.
# shellcheck source=infra/scripts/deploy-rollback-point.sh
. infra/scripts/deploy-rollback-point.sh
rollback_point

# ---------------------------------------------------------------------------
#  Dirty-checkout guard.
#
#  A modified file here means production is running something that exists on
#  no branch and in no commit — nobody can reproduce it, review it, or roll
#  back to it, and `git pull` will refuse the next time somebody tries.
#
#  On 19 August this happened twice in one day with the same single line. It
#  was hand-patched onto the box to bring the API back, was not in git, and
#  the next pull could not land. Discarding it to make the pull work took the
#  whole API down for an hour because the committed replacement had not been
#  pushed yet.
#
#  So: named, not silent. The escape hatch exists because the SECOND of those
#  hand-edits was the correct call — during an outage, service first. What is
#  not acceptable is not knowing.
# ---------------------------------------------------------------------------
# TRACKED files only. Untracked files cannot put unreproducible code into the
# containers - the images are built from what git tracks - and the box
# legitimately accumulates local artifacts: .environment (the checkout marker
# this script itself requires), backups/, .env backups, and the occasional
# junk file from a badly pasted command. Day one of this guard, it flagged
# all four alongside the one real drift and buried the signal.
DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null)
if [ -n "$DIRTY" ]; then
    bad "This checkout has uncommitted changes."
    printf '%s\n' "$DIRTY" | sed 's/^/      /'
    note "Production would run code that is in no commit and on no branch."
    note "Recover it, or discard it, before deploying:"
    note "  git diff                      # see what it is"
    note "  git stash                     # keep it, out of the way"
    note "  git checkout -- <path>        # discard it"
    note "If this is a deliberate emergency patch, re-run with DEPLOY_ALLOW_DIRTY=1"
    note "and open a commit for it the same day."
    [ "${DEPLOY_ALLOW_DIRTY:-}" = "1" ] || exit 1
    note "DEPLOY_ALLOW_DIRTY=1 — proceeding with a modified checkout"
fi

if [ "$ENV" = "production" ]; then
    printf '\n   %sProduction deploy. Outbound mail WILL reach real inboxes.%s\n' "$Y" "$X"
    if [ "${CI:-}" = "1" ]; then
        # GitHub Actions already required a typed confirmation and an
        # environment approval. A read here would hang the job forever.
        note "CI=1 — confirmation was handled by the workflow"
    else
        printf '   Type %sproduction%s to continue: ' "$B" "$X"
        read -r confirm
        [ "$confirm" = "production" ] || { note "aborted"; exit 1; }
    fi
fi

# ---------------------------------------------------------------------------
step "Pulling and building"
$COMPOSE pull 2>&1 | grep -Ei 'error|warn' | sed 's/^/   /' || true

# The exit status of the build, not of `tail`. Piping to tail made the
# pipeline always succeed, so "images ready" printed whatever happened.
# The web image stamps every page with the commit it was built from. .git is
# not in the build context (root .dockerignore), so hand the SHA to the build;
# without this the badge reads "unknown" and a deploy that silently did not
# land looks identical to one that did.
export BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if ! build_out=$($COMPOSE build 2>&1); then
    bad "build failed"
    printf '%s\n' "$build_out" | tail -30 | sed 's/^/      /'
    exit 1
fi
printf '%s\n' "$build_out" | tail -5 | sed 's/^/   /'
ok "images ready"

# ---------------------------------------------------------------------------
step "Backing up the database"
# ── COMPRESSED, CHECKED WHOLE, ENCRYPTED, LOCKED DOWN, KEPT BY DAYS. ──────
#  Until 24 September 2026 this wrote an UNCOMPRESSED dump before every
#  deploy and never deleted one. On 25 Sept the server held 323 of them,
#  31 GB back to 4 Aug, unencrypted and readable by every account on the
#  machine — a full copy of everything every customer believes was deleted.
#  Mr. Singh's ruling, 25 Sept 2026 (PR 254), and each rule's failure:
#
#   1. gzip AS IT IS WRITTEN, then encrypt, in one pipe. pipefail (top of
#      this file) makes a failed pg_dumpall fail the pipeline, so a dead
#      dump cannot hide behind a successful gzip or openssl.
#
#   2. ENCRYPTED AT REST with the SAME scheme and passphrase as backup.sh's
#      off-box copies (AES-256-CBC, PBKDF2, 200,000 iterations;
#      BACKUP_ENC_PASSPHRASE from backup.sh's config file, which Amit also
#      holds on paper). One scheme, one key to keep. On production a missing
#      passphrase STOPS the deploy: an unencrypted copy is exactly what this
#      replaces, so it is not an acceptable fallback.
#
#   3. LOCKED DOWN FROM BIRTH: umask 077, the directory 700, each file 600.
#      Not fixed afterwards — created that way (the 323 old copies were
#      chmod-ed by hand on 25 Sept, Amit's go).
#
#   4. CHECKED WHOLE, not just present: decrypted and gunzipped in a pipe and
#      checked for pg_dumpall's "database cluster dump complete" marker. A
#      wrong passphrase, a damaged archive or a dump cut off halfway all fail
#      here — before anything is deleted and before the deploy continues.
#
#   5. KEPT BY DAYS, NOT BY COUNT. A count makes the period depend on how
#      often we deploy, which no privacy notice can state. The window is
#      backup.sh's own BACKUP_KEEP_DAYS (same config file, same default 14),
#      so pre-deploy copies and the regular local backups are ONE number.
#      Pruning runs only after this deploy's copy passed rule 4, and removes
#      only ENCRYPTED pre-deploy copies (*.sql.gz.enc) older than the window.
#
#   6. THE OLD PLAIN COPIES ARE NOT TOUCHED HERE. Mr. Singh: they are deleted
#      only after a restore has been proven, by a person, in one explicit
#      logged action — never as a side effect of a deploy. This step counts
#      them and says so every time until they are gone.
#
#  Restore one:
#    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENC_PASSPHRASE \
#        -in backups/pre-deploy-<stamp>.sql.gz.enc | gunzip | psql -U postgres
# ─────────────────────────────────────────────────────────────────────────
BACKUP_CONF="${BACKUP_DIR:-/srv/backups/tatvaos}/.backup-env"
# Only the two values this step needs, read in a subshell: sourcing the
# whole file here would put the object-storage credentials into every
# process deploy.sh starts.
conf_value() {
    [ -r "$BACKUP_CONF" ] || return 0
    ( set -a; . "$BACKUP_CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" )
}
PREDEPLOY_KEEP_DAYS="${PREDEPLOY_KEEP_DAYS:-$(conf_value BACKUP_KEEP_DAYS)}"
PREDEPLOY_KEEP_DAYS="${PREDEPLOY_KEEP_DAYS:-14}"
PREDEPLOY_PASS="${PREDEPLOY_PASS:-$(conf_value BACKUP_ENC_PASSPHRASE)}"
if ! [[ "$PREDEPLOY_KEEP_DAYS" =~ ^[0-9]+$ ]] || [ "$PREDEPLOY_KEEP_DAYS" -lt 1 ]; then
    bad "BACKUP_KEEP_DAYS is '$PREDEPLOY_KEEP_DAYS' — not a whole number of days; stopping"
    exit 1
fi
if docker ps --format '{{.Names}}' | grep -q postgres; then
    ( umask 077; mkdir -p backups )
    chmod 700 backups
    STAMP=$(date +%Y%m%d-%H%M%S)
    if [ -z "$PREDEPLOY_PASS" ]; then
        if [ "$ENV" = "production" ]; then
            bad "no BACKUP_ENC_PASSPHRASE in $BACKUP_CONF — will not write an unencrypted copy of production; stopping"
            exit 1
        fi
        note "no encryption passphrase ($ENV) — this non-production copy is compressed but NOT encrypted"
    fi
    if [ -n "$PREDEPLOY_PASS" ]; then
        DUMP="backups/pre-deploy-${STAMP}.sql.gz.enc"
        export PREDEPLOY_PASS
        if ! ( umask 077; $COMPOSE exec -T postgres pg_dumpall -U postgres 2>/dev/null \
                 | gzip -6 \
                 | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:PREDEPLOY_PASS > "$DUMP" ); then
            bad "backup failed — stopping rather than deploying over unbacked data"
            rm -f -- "$DUMP"; exit 1
        fi
        read_back() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:PREDEPLOY_PASS -in "$DUMP" 2>/dev/null; }
    else
        DUMP="backups/pre-deploy-${STAMP}.sql.gz"
        if ! ( umask 077; $COMPOSE exec -T postgres pg_dumpall -U postgres 2>/dev/null | gzip -6 > "$DUMP" ); then
            bad "backup failed — stopping rather than deploying over unbacked data"
            rm -f -- "$DUMP"; exit 1
        fi
        read_back() { cat -- "$DUMP"; }
    fi
    chmod 600 -- "$DUMP"
    if ! read_back | gzip -t 2>/dev/null; then
        bad "backup does not decrypt to a valid gzip ($DUMP) — stopping"
        exit 1
    fi
    # Captured, then matched in bash — NOT `| grep -q`. Under pipefail a
    # grep -q that exits on its first match can SIGPIPE the stage before it
    # and fail the pipeline on a GOOD dump: the false red PR 227 removed
    # from verify-live.sh. tail reads to EOF, so nothing here exits early.
    dump_end=$(read_back | gzip -dc 2>/dev/null | tail -c 400)
    if [[ "$dump_end" != *"database cluster dump complete"* ]]; then
        bad "backup is TRUNCATED — no end-of-dump marker in $DUMP — stopping"
        exit 1
    fi
    ok "$DUMP ($(du -h "$DUMP" | cut -f1), whole, $( [ -n "$PREDEPLOY_PASS" ] && echo encrypted || echo NOT encrypted ), mode $(stat -c %a "$DUMP"))"

    # Encrypted pre-deploy copies older than the window go. -- guards
    # against a name starting with '-'. Plain .sql / .sql.gz are NOT matched
    # (rule 6).
    mapfile -t old < <(find backups -maxdepth 1 -type f -name 'pre-deploy-*.sql.gz.enc' \
                            -mtime "+$PREDEPLOY_KEEP_DAYS" 2>/dev/null | sort)
    if [ "${#old[@]}" -gt 0 ]; then
        rm -f -- "${old[@]}"
        ok "removed ${#old[@]} encrypted pre-deploy copy(ies) older than $PREDEPLOY_KEEP_DAYS days"
    fi
    kept=$(find backups -maxdepth 1 -type f -name 'pre-deploy-*.sql.gz.enc' | wc -l)
    ok "$kept encrypted pre-deploy copy(ies) kept; window $PREDEPLOY_KEEP_DAYS days (BACKUP_KEEP_DAYS)"
    legacy=$(find backups -maxdepth 1 -type f \( -name 'pre-deploy-*.sql' -o -name 'pre-deploy-*.sql.gz' \) | wc -l)
    if [ "$legacy" -gt 0 ]; then
        note "$legacy OLD UNENCRYPTED pre-deploy copies still here — left for the explicit, logged deletion after a restore is proven (Mr. Singh, 25 Sept). Not deleted by deploys."
    fi
else
    note "no running database yet — first deploy"
fi
# The passphrase was exported only for openssl above. Nothing started from
# here on (builds, compose up, verify-live) has any business holding it.
unset PREDEPLOY_PASS

# ---------------------------------------------------------------------------
# SCHEMA BEFORE SERVICES — the order is the point.
#
# This used to start everything and then apply schema, which gave every
# deploy carrying an additive column a window where the NEW api was serving
# requests against the OLD database: SELECTs naming a column that does not
# exist yet, 500s until psql caught up. Additive migrations are written to be
# safe in the other direction — old code ignores a new column — so the safe
# order is database first, app second. (Credit: the Mail dev, who noticed
# every one of his columns rode that window.)
# ---------------------------------------------------------------------------
step "Starting the database"
$COMPOSE up -d postgres 2>&1 | tail -3 | sed 's/^/   /'

# Wait for Postgres to accept connections rather than sleeping and hoping.
# A fixed sleep is either too short on a cold first deploy or wasted on every
# one after.
for i in $(seq 1 30); do
    $COMPOSE exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 2
done

# ---------------------------------------------------------------------------
step "Applying schema"

schema_failed=0
for f in local/postgres/init/*.sql; do
    # Demo seed data stays local. It exists so the dev stack and CI have two
    # tenants to prove isolation against — on a cloud environment it becomes
    # fictional customers in the real database, with SHA512-CRYPT dev
    # passwords, that the console then shows to whoever signs in.
    #
    # The seeds are idempotency-guarded, so without this skip they would also
    # quietly re-create themselves on every deploy after being cleaned out.
    case "$(basename "$f")" in
        *seed*) note "skipping $(basename "$f") (demo data - local and CI only)"; continue ;;
    esac
    # Output is NOT swallowed. Hiding psql's stderr behind /dev/null turns a
    # one-line "relation does not exist" into a silent FAIL that takes an hour
    # to track down — which is exactly what the Postfix entrypoint did to us.
    if out=$($COMPOSE exec -T postgres psql -U postgres -d tatvaos_mail \
             -v ON_ERROR_STOP=1 < "$f" 2>&1); then
        ok "$(basename "$f")"
    else
        bad "$(basename "$f")"
        printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
        schema_failed=1
    fi
done

# A half-applied schema is worse than a failed deploy: the containers come up,
# the health check may even pass, and the breakage surfaces later as missing
# columns under load.
[ "$schema_failed" -eq 0 ] || {
    bad "schema did not apply cleanly — stopping"
    # The app containers were NOT recreated: the old images keep serving the
    # old (still-valid) schema, which is the least-broken place to stop.
    exit 1
}

# ---------------------------------------------------------------------------
# THE GATE: prove the NEW api starts before retiring the OLD one.
#
# Until 20 August 2026 this script swapped the containers and THEN checked
# health. That ordering turned a two-character config mistake — a "//" key in
# Logging:LogLevel, valid JSON that LoggerFactory cannot parse — into a
# platform-wide outage: the old, working API was already gone by the time
# anything asked whether the new one could start. The health check did its
# job perfectly and reported a fire it had helped light.
#
# So: run the new image FIRST, as a throwaway container on the real network
# against the real database, and require /health to answer. Only then is the
# running API allowed to be replaced. If the probe fails, the deploy stops
# and the old containers keep serving — a refused deploy instead of an
# outage, which is the entire difference between this morning and a log line.
#
# Mechanics, because each choice is load-bearing:
#   · `compose run` (not `up`)  — real env, real network, and NO ports
#     published, so it cannot collide with the API that is still serving.
#   · `--no-deps`               — postgres is already up (schema just
#     applied); nothing else is a startup dependency (checked: depends_on
#     lists postgres alone, and Program.cs never touches redis).
#   · bash + /dev/tcp           — the aspnet runtime image ships neither
#     curl nor wget (the compose file documents this); it does ship bash,
#     and bash can speak enough HTTP to read one status line.
#   · 60 seconds                — cold start against a cold connection pool
#     is seconds; a minute means it is not coming up.
# ---------------------------------------------------------------------------
step "Proving the new API starts (before touching the running one)"

PROBE="tatvaos-api-probe"
docker rm -f "$PROBE" >/dev/null 2>&1 || true   # debris from an aborted run

if ! $COMPOSE run -d --no-deps --name "$PROBE" api >/dev/null 2>&1; then
    bad "could not start the probe container at all"
    note "the running API has NOT been touched"
    exit 1
fi

probe_ok=0
for i in $(seq 1 30); do
    # Container died = startup crash. Say so with its own last words.
    if [ "$(docker inspect -f '{{.State.Running}}' "$PROBE" 2>/dev/null)" != "true" ]; then
        bad "the NEW api crashed on startup — this deploy would have been an outage"
        docker logs "$PROBE" 2>&1 | tail -15 | sed 's/^/      /'
        break
    fi
    status=$(docker exec "$PROBE" bash -c         'exec 3<>/dev/tcp/localhost/8080 &&
         printf "GET /health HTTP/1.0\r\n\r\n" >&3 &&
         head -1 <&3' 2>/dev/null | tr -d '\r')
    case "$status" in
        *" 200 "*|*" 200") probe_ok=1; break ;;
    esac
    sleep 2
done

docker rm -f "$PROBE" >/dev/null 2>&1 || true

if [ "$probe_ok" -eq 1 ]; then
    ok "the new API starts and /health answers 200 — safe to swap"
else
    bad "the new API never answered /health — REFUSING to replace the one that works"
    note "the old containers are untouched and still serving"
    note "debug with:  $COMPOSE run --rm --no-deps api"
    exit 1
fi

# ---------------------------------------------------------------------------
step "Starting services"
# The WHOLE output, not its last dozen lines. Compose prints one line per state
# change per service - Recreate, Recreated, Starting, Started, or Running for
# a container it left alone - and those lines are the record of whether the
# containers were replaced. A `tail -12` here hid exactly them on 12 Sept 2026,
# and "were the containers recreated?" had to be answered from docker inspect
# the next day instead of from this log.
$COMPOSE up -d --remove-orphans 2>&1 | sed 's/^/   /'

# ---------------------------------------------------------------------------
step "Reloading the reverse proxy"

# `docker compose up -d` only RECREATES a container when its definition changes
# — image, env, ports, the mount SET. Editing the CONTENTS of a bind-mounted
# file changes none of those, so Caddy keeps serving whatever config it loaded
# at boot. Every Caddyfile edit before this line silently did nothing until the
# container happened to restart for another reason — which is how mail.
# tatvaos.com kept serving the admin console after the redirect was "deployed".
# `caddy reload` re-reads the mounted Caddyfile in place, no downtime.
#
# AND THEN THE RELOAD ITSELF DID NOTHING — 17 Sept 2026. The Caddyfile was
# mounted as a single file, which is a mount of one inode. The `git reset
# --hard` above replaces files, so the file on disk had a new inode and the
# container still held the old one. `caddy reload` re-read the OLD content,
# Caddy logged `"msg":"config is unchanged"` — the exact answer, produced by
# the right component at the right moment — and this step printed
# "[ok] caddy reloaded from the mounted Caddyfile" on top of it. The new
# /.well-known/ route was not there and discovery answered the web app's 404
# until the container was recreated by hand. The stale copy in the container
# was byte-for-byte the PRE-deploy file, which bounds the damage to that one
# deploy: had earlier edits been lost too, the copy would have been older
# than the pre-deploy file, not equal to it.
#
# The mount is now the directory (docker-compose.base.yml), which removes the
# cause. This step keeps three things regardless, because a security
# directive tightened in the Caddyfile and silently not applied would look
# exactly like a success (CTO, 17 Sept 2026):
#   1. Caddy's own log lines from the reload are printed, not swallowed —
#      "config is unchanged" is the answer, not noise;
#   2. the post-condition: the RUNNING config, read from Caddy's admin
#      endpoint, must equal the on-disk Caddyfile adapted in a fresh
#      container that mounts the current files. Not the file inside the
#      container — a config that was read and not applied would pass that;
#   3. when they differ, the container is recreated and the comparison runs
#      again, and only a second match prints [ok].
# House rule 12: an [ok] here is printed only after something was checked.
reload_started=$(date -u +%Y-%m-%dT%H:%M:%S)
$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/   /'
reload_rc=${PIPESTATUS[0]}
# What Caddy itself said about the reload — its log, not the CLI's exit code.
$COMPOSE logs --no-log-prefix --since "$reload_started" caddy 2>/dev/null \
    | grep -iE '"msg":"[^"]*(config|reload|adapt|error)[^"]*"' -o | sed 's/^"msg":/   caddy said: /'
if [ "$reload_rc" -ne 0 ]; then
    # A reload failure usually means a config typo, and the OLD config is still
    # serving. Say so loudly; the post-condition below then says which config
    # is live.
    bad "caddy reload failed (exit $reload_rc) — the previous config is still live; check the Caddyfile"
fi

CADDY_ADAPT="$COMPOSE run --rm --no-deps -T caddy caddy adapt --config /etc/caddy/Caddyfile"
# 127.0.0.1, not localhost: inside the alpine image busybox wget resolves
# localhost to ::1 first and Caddy's admin endpoint listens on 127.0.0.1 only,
# so "localhost" is a connection refused — found by the red-first run of this
# step on a scratch container, 17 Sept 2026.
CADDY_RUNNING="$COMPOSE exec -T caddy wget -qO- http://127.0.0.1:2019/config/"
if verdict=$(infra/scripts/caddy-config-matches.sh "$CADDY_ADAPT" "$CADDY_RUNNING"); then
    note "$verdict"
    ok "caddy is serving the Caddyfile on disk — running config equals the adapted file"
else
    printf '%s\n' "$verdict" | sed 's/^/   /'
    note "recreating caddy so it reads the files on disk (a few seconds of refused connections)"
    $COMPOSE up -d --force-recreate --no-deps caddy 2>&1 | sed 's/^/   /'
    sleep 4
    if verdict=$(infra/scripts/caddy-config-matches.sh "$CADDY_ADAPT" "$CADDY_RUNNING"); then
        note "$verdict"
        ok "caddy recreated — running config now equals the adapted file on disk"
    else
        printf '%s\n' "$verdict" | sed 's/^/   /'
        bad "caddy is NOT serving the on-disk Caddyfile even after a recreate — check the Caddyfile and $COMPOSE logs caddy"
    fi
fi

# ---------------------------------------------------------------------------
step "Syncing the mail-edge TLS certificate from Caddy"
#
#  Caddy earns and renews the mail.tatvaos.com certificate for the webmail
#  door. The mail edge (Postfix submission :587, Dovecot IMAPS :993) reuses
#  it via the mailcerts volume rather than running a second ACME client into
#  the same rate limits. Copied on every deploy; deploys are far more
#  frequent than 60-day renewals.
#
#  ON FAILURE THE MAIL-EDGE RESTART BELOW IS SKIPPED, deliberately: both
#  entrypoints FAIL-CLOSED without a certificate (that is the fix for the
#  cleartext-IMAP hole), so restarting them certless would take mail DOWN.
#  The running processes keep serving on their current config instead, and
#  the operator gets a red line to act on.
CERT_OK=0
if docker run --rm -v tatvaos_caddydata:/src:ro -v tatvaos_mailcerts:/dst alpine sh -c '
        set -e
        d=$(ls -d /src/caddy/certificates/*/mail.* 2>/dev/null | head -1)
        [ -n "$d" ] || { echo "no mail.* certificate directory under caddydata"; exit 1; }
        cp "$d"/*.crt /dst/fullchain.pem
        cp "$d"/*.key /dst/privkey.pem
        chmod 600 /dst/privkey.pem /dst/fullchain.pem
        echo "synced from $d"
    ' 2>&1 | sed 's/^/   /'; then
    ok "certificate in the mailcerts volume"
    CERT_OK=1
else
    bad "certificate sync FAILED — mail-edge restart will be SKIPPED"
    note "the running postfix/dovecot keep serving; fix the sync and redeploy"
fi

# ---------------------------------------------------------------------------
step "Restarting postfix (its config renders at container start)"

# The Caddy paragraph above, but for mail — and it cost more before anyone
# closed it. Postfix's main.cf is RENDERED BY THE ENTRYPOINT from a mounted
# template when the container STARTS. `up -d` does not recreate a container
# whose definition is unchanged, and editing a mounted file changes no
# definition — so a config change in git reaches the running Postfix only
# when the container happens to restart for some other reason.
#
# Three incidents before this line existed: the outbound-TLS fix sat correct
# in git for FOUR DAYS while real mail went out unencrypted; then on 24 August
# the message-size fix was "deployed" twice — once by git pull, once by this
# very script — and postconf read the old value both times.
#
# A restart costs a few seconds of deferral. SMTP is store-and-forward;
# sending servers retry. Unconditional, because "only when postfix files
# changed" is a condition somebody has to maintain, and the failure mode of
# getting it wrong is silent — which is the exact shape being fixed.
if [ "${CERT_OK:-0}" != "1" ]; then
    bad "SKIPPED: no certificate synced, and the mail edge fails closed without one"
elif $COMPOSE restart postfix dovecot 2>&1 | sed 's/^/   /'; then
    ok "postfix and dovecot restarted — configs re-rendered, certificate live"
    note "verify: docker exec tatvaos-postfix-1 postconf -h submission_tls_security_level"
else
    bad "mail-edge restart failed — the running config may be STALE; restart by hand"
fi

# ---------------------------------------------------------------------------
step "Health"
# ---------------------------------------------------------------------------
#  THE DENOMINATOR COMES FROM THE COMPOSE FILES, NOT FROM WHAT IS RUNNING.
#
#  This loop used to compare `ps --services --filter status=running` against
#  `ps --services`. Both sides counted the same live state, so a service that
#  never created a container at all disappeared from the numerator AND the
#  denominator together — and 10 of 10 reported green on an 11-service stack.
#  The one that was missing was the one nobody was told about.
#
#  `config --services` is the DECLARATION. It cannot shrink because something
#  broke, which is the only property that makes it a valid denominator.
# ---------------------------------------------------------------------------
EXPECTED=$($COMPOSE config --services 2>/dev/null | wc -l)
if [ "$EXPECTED" -eq 0 ]; then
    bad "could not read the service list from the compose files"
    note "check:  $COMPOSE config --services"
    exit 1
fi
note "${EXPECTED} services declared in the compose files"

settled=0
for i in $(seq 1 30); do
    up=$($COMPOSE ps --services --filter status=running 2>/dev/null | wc -l)
    if [ "$up" -eq "$EXPECTED" ]; then
        settled=$((settled + 1)); [ "$settled" -ge 3 ] && break
    else settled=0; fi
    sleep 2
done

if [ "$settled" -ge 3 ]; then
    ok "all ${EXPECTED} services running"
else
    up=$($COMPOSE ps --services --filter status=running 2>/dev/null | wc -l)
    bad "${up} of ${EXPECTED} services running — the stack is INCOMPLETE"
    $COMPOSE ps | sed 's/^/   /'
    note "declared but not running:"
    comm -23 <($COMPOSE config --services 2>/dev/null | sort) \
             <($COMPOSE ps --services --filter status=running 2>/dev/null | sort) \
        | sed 's/^/      /'
    note "logs:  $COMPOSE logs --tail 50"
    exit 1
fi

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
step "Pruning the build cache"
#
#  The cache once grew to 48 GB and took the disk to 85% — the disk Mail
#  writes to — and was cleaned by hand with a note saying deploy.sh should do
#  it. This is that note, honoured.
#
#  IT DID NOT WORK, AND IT SAID IT DID. Until 23 Sept 2026 this step ran
#  `docker builder prune -f --keep-storage=8GB` and then printed "cache
#  bounded at 8 GB" unconditionally. Measured on production that day: the
#  cache held 51.89 GB and the disk was at 90%, four days after a hand clean.
#  Two faults, both silent:
#
#    1. --keep-storage is DEPRECATED on Docker 29 (the server runs 29.7.1).
#       It warns and remaps to --reserved-space, and still exits 0.
#    2. Without -a, prune only removes UNUSED records. Docker called 6.18 GB
#       "reclaimable" out of 51.89 GB; `-af` then freed 48.83 GB. So the old
#       line could not have bounded anything, whatever flag it used.
#
#  And the `ok` line printed a number nobody had measured. So this version
#  MEASURES the cache, prunes only when it is over the bound, and prints what
#  it actually freed. Numbers come from docker, never from the wish.
#
#  BUILD CACHE ONLY. Never `docker system prune`, never --volumes: the
#  volumes on that box are Postgres, the maildirs and Caddy's certificates
#  (18 Sept 2026 note). image prune -f removes dangling images only.
CACHE_MAX_GB=${CACHE_MAX_GB:-20}
MIN_FREE_GB=${MIN_FREE_GB:-25}

# Sizes come from docker's own summary, converted to whole GB. Parsed as TEXT
# on purpose: the JSON form reports sizes as strings too, and `buildx du` is
# empty on this daemon. Field 2 is the total, field 3 what docker considers
# RECLAIMABLE ("Build Cache|51.89GB|6.184GB").
#
# The difference matters and cost a rehearsal to learn: a cache can be large
# and ENTIRELY IN USE by the current images. On 23 Sept, after a hand clean,
# 3.1 GB remained with 0B reclaimable, and `prune -af` correctly freed
# nothing. A first version of this step called that a failure — a red line on
# a healthy deploy, which is the false alarm PR 227 was about.
cache_field() {
    docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null | awk -F'|' -v f="$1" '
        $1 == "Build Cache" {
            v = $f; sub(/ .*$/, "", v)            # "6.184GB (29%)" -> "6.184GB"
            unit = v; sub(/^[0-9.]+/, "", unit); sub(/[A-Za-z]+$/, "", v)
            if (unit ~ /^TB/) v *= 1024; else if (unit ~ /^MB/) v /= 1024
            else if (unit ~ /^kB|^KB/) v /= 1048576; else if (unit ~ /^B/) v = 0
            printf "%.1f", v; found = 1
        }
        END { if (!found) print "-1" }'
}
free_gb() { df -BG --output=avail / | awk 'NR==2 {gsub("G", ""); print $1 + 0}'; }
over() { awk -v a="$1" -v b="$2" 'BEGIN{print (a > b) ? 1 : 0}'; }

before_cache=$(cache_field 2); reclaimable=$(cache_field 3); before_free=$(free_gb)

if [ "$(over "$before_cache" "$CACHE_MAX_GB")" = "1" ] || [ "${before_free:-999}" -lt "$MIN_FREE_GB" ]; then
    if [ "$(over "$reclaimable" 1)" = "0" ]; then
        # Large but all of it in use. Nothing to do, and nothing wrong.
        ok "build cache ${before_cache} GB but only ${reclaimable} GB reclaimable — all in use, nothing pruned; ${before_free} GB free on /"
    else
        note "build cache ${before_cache} GB (${reclaimable} GB reclaimable), ${before_free} GB free — pruning"
        docker builder prune -af 2>&1 | tail -1 | sed 's/^/   /'
        docker image prune -f  2>&1 | tail -1 | sed 's/^/   /'
        after_cache=$(cache_field 2); after_free=$(free_gb)
        # CHECKED, not asserted. The line this replaces printed "cache bounded
        # at 8 GB" every deploy while the cache grew to 51.89 GB.
        if [ "$(over "$before_cache" "$after_cache")" = "1" ] || [ "${after_free:-0}" -gt "${before_free:-0}" ]; then
            ok "build cache ${before_cache} -> ${after_cache} GB; free on / ${before_free} -> ${after_free} GB"
        else
            bad "prune had ${reclaimable} GB to reclaim and freed nothing: cache still ${after_cache} GB, ${after_free} GB free. Clean by hand."
        fi
    fi
else
    ok "build cache ${before_cache} GB (bound ${CACHE_MAX_GB} GB), ${before_free} GB free on / — nothing to prune"
fi

# A full disk fails the NEXT deploy, not this one. Said as a warning, never a
# failure: this deploy's services are already up, and a red line here would be
# the same false alarm that made someone roll back a working deploy.
if [ "$(free_gb)" -lt 15 ]; then
    note "WARNING: under 15 GB free on /. The NEXT deploy may fail. Clear build cache"
    note "         (docker builder prune -af) — never volumes: they hold Postgres,"
    note "         the maildirs and Caddy's certificates."
fi

# ---------------------------------------------------------------------------
step "Verifying what is actually live"
#
#  verify-live.sh is the ONE definition of "up" — this call, the deploy
#  workflow's SSH step, and a worried operator at 2am all run the same
#  script. It checks what the steps above cannot: that the mail edge
#  ANSWERS (IMAP greeting, certificate, SMTP banners) and that the queue is
#  MOVING. On 27 August every HTTP gate returned 200 while mail queued
#  behind a dead Dovecot; these are the checks that would have said so.
#
#  Its failures land in OUR counter: it exits non-zero on any failed check,
#  and bad() feeds the verdict below.
# ---------------------------------------------------------------------------
if bash infra/scripts/verify-live.sh; then
    ok "live verification passed"
else
    bad "verify-live.sh reports the deployed stack is not fully serving — its [FAIL] lines are above"
fi

# ---------------------------------------------------------------------------
step "Confirming the running build"
# ---------------------------------------------------------------------------
#  A green verdict has meant "every step succeeded". That is not the same as
#  "the containers are running the new code". `up -d` without --force-recreate
#  leaves containers in place when they were created by a different
#  invocation: every step passes and the box keeps serving the previous build.
#  We have shipped that exact non-event.
#
#  So the deploy asks the running system whether it landed, and a disagreement
#  is a FAILURE rather than a note — rule 6, a check with a failure mode.
# ---------------------------------------------------------------------------
_web_after=$($COMPOSE ps -q web 2>/dev/null | head -1)
LIVE_SHA=""
[ -n "$_web_after" ] && LIVE_SHA=$(docker inspect \
    --format '{{range .Config.Env}}{{println .}}{{end}}' "$_web_after" 2>/dev/null \
    | sed -n 's/^BUILD_SHA=//p' | head -1)

if [ -z "$LIVE_SHA" ]; then
    bad "the build stamp could not be read from the running web container — this deploy cannot be proven to have landed"
    note "This does NOT mean the containers were not replaced. It means the"
    note "running container's environment has no BUILD_SHA to compare - which"
    note "is what an image built before the stamp reached the runtime stage of"
    note "apps/web/Dockerfile looks like. On 12 Sept 2026 this branch fired on"
    note "the check's first ever run, over a deploy that HAD landed, and the"
    note "wording led straight to the wrong conclusion. Before concluding"
    note "anything, look at when the containers were created:"
    note "  docker ps --format 'table {{.Names}}\t{{.CreatedAt}}\t{{.Status}}'"
    note "and at the stamp inlined in the served page:"
    note "  curl -s https://<site>/ | grep -o 'x-build[^>]*'"
elif [ "$LIVE_SHA" != "$BUILD_SHA" ]; then
    bad "the running web container is NOT the build this deploy just made"
    note "built:   $(printf '%s' "$BUILD_SHA" | cut -c1-7)"
    note "running: $(printf '%s' "$LIVE_SHA"  | cut -c1-7)"
    note "The containers were not replaced. Recreate them explicitly:"
    note "  docker compose ... up -d --force-recreate api web"
else
    ok "running build matches what was just built ($(printf '%s' "$LIVE_SHA" | cut -c1-7))"
fi

# ---------------------------------------------------------------------------
step "Verdict"
# ---------------------------------------------------------------------------
#  THE VERDICT READS THE COUNTER. Nothing below this block runs if anything
#  above printed [FAIL].
#
#  Every step above that fails-but-continues does so for a good reason — the
#  old config keeps serving, the running mail edge keeps serving. "Continue
#  anyway" was always the right call for the STEP. It was never the right call
#  for the SUMMARY, and for weeks the summary was the only part anyone read.
#
#  Non-zero exit, so CI and any wrapper see it too.
# ---------------------------------------------------------------------------
if [ "$FAILURES" -gt 0 ]; then
    printf '\n   %s%sNOT deployed cleanly — %d step(s) failed.%s\n\n' \
        "$B" "$R" "$FAILURES" "$X"
    note "Scroll up: every [FAIL] line above is one of them."
    note "Some steps continue after failing on purpose (the old config keeps"
    note "serving). That makes them survivable, not successful."
    printf '\n'
    exit 1
fi

# Record this deploy — here, after the verdict, and nowhere earlier. The next
# deploy's rollback point is read from this record; a deploy that failed above
# exited before reaching it, so it can never become somebody's return point.
# See infra/scripts/deploy-rollback-point.sh.
if record_deploy; then
    printf '   %srecorded%s %s as the %s return point for the next deploy\n' \
        "$D" "$X" "$BUILD_SHA" "$ENV"
else
    printf '   %s[warn]%s could not record this deploy — the next deploy will ask for\n' "$Y" "$X"
    note "its rollback point from the workflow history instead of naming one."
fi

DOMAIN=$(grep '^SITE_DOMAIN=' infra/docker/.env | cut -d= -f2)
printf '\n   %s%s deployed.%s\n' "$G" "$ENV" "$X"
printf '   DEPLOY VERDICT: PASS %s at %s\n\n' "$BUILD_SHA" "$(date -u +%FT%TZ)"
printf '   App        https://%s\n' "$DOMAIN"
printf '   API        https://%s/api\n' "$DOMAIN"
printf '   Health     https://%s/health\n' "$DOMAIN"
printf '\n   %sOutbound mail reaches the real internet.%s\n' "$Y" "$X"

# ---------------------------------------------------------------------------
#  Leave the checkout on main.
#
#  The branch guard refuses a production deploy from a feature branch. That
#  stops the bad deploy without removing the reason somebody was on a branch
#  in this directory — for a long time it was the only clone on the box.
#  ~/tatvaos-scratch now exists for that work (HOUSE_RULES rule 11), and
#  this returns the deploy directory to a known state at the one moment it is
#  provably safe to: everything above passed.
# ---------------------------------------------------------------------------
if [ "$BRANCH" != "main" ]; then
    if git checkout main >/dev/null 2>&1; then
        printf '   %scheckout%s returned to main (was %s)\n' "$D" "$X" "$BRANCH"
    else
        printf '   %s[warn]%s could not return the checkout to main — still on %s\n' \
            "$Y" "$X" "$BRANCH"
    fi
fi
printf '\n'
