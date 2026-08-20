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

step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s[ ok ]%s %s\n' "$G" "$X" "$1"; }
bad()  { printf '   %s[FAIL]%s %s\n' "$R" "$X" "$1"; }
note() { printf '   %s%s%s\n' "$D" "$1" "$X"; }

case "$ENV" in
    production) ;;
    testing)
        printf '\nThe testing environment was removed — its overlay no longer exists.\n'
        printf 'Use the local stack in local/ to rehearse, or build a new overlay.\n\n'
        exit 1 ;;
    *) printf '\nUsage: ./deploy.sh production\n\n'; exit 1 ;;
esac

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
if ! build_out=$($COMPOSE build 2>&1); then
    bad "build failed"
    printf '%s\n' "$build_out" | tail -30 | sed 's/^/      /'
    exit 1
fi
printf '%s\n' "$build_out" | tail -5 | sed 's/^/   /'
ok "images ready"

# ---------------------------------------------------------------------------
step "Backing up the database"
if docker ps --format '{{.Names}}' | grep -q postgres; then
    mkdir -p backups
    STAMP=$(date +%Y%m%d-%H%M%S)
    if $COMPOSE exec -T postgres pg_dumpall -U postgres > "backups/pre-deploy-${STAMP}.sql" 2>/dev/null; then
        SIZE=$(du -h "backups/pre-deploy-${STAMP}.sql" | cut -f1)
        ok "backups/pre-deploy-${STAMP}.sql (${SIZE})"
    else
        bad "backup failed — stopping rather than deploying over unbacked data"
        exit 1
    fi
else
    note "no running database yet — first deploy"
fi

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
$COMPOSE up -d --remove-orphans 2>&1 | tail -12 | sed 's/^/   /'

# ---------------------------------------------------------------------------
step "Reloading the reverse proxy"

# `docker compose up -d` only RECREATES a container when its definition changes
# — image, env, ports, the mount SET. Editing the CONTENTS of a bind-mounted
# file changes none of those, so Caddy keeps serving whatever config it loaded
# at boot. Every Caddyfile edit before this line silently did nothing until the
# container happened to restart for another reason — which is how mail.
# tatvaos.com kept serving the admin console after the redirect was "deployed".
# `caddy reload` re-reads the mounted Caddyfile in place, no downtime.
if $COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/   /'; then
    ok "caddy reloaded from the mounted Caddyfile"
else
    # Non-fatal: a reload failure usually means a config typo, and the OLD
    # config is still serving. Say so loudly rather than failing the deploy and
    # leaving the operator unsure whether the site is down.
    bad "caddy reload failed — the previous config is still live; check the Caddyfile"
fi

# ---------------------------------------------------------------------------
step "Health"
settled=0
for i in $(seq 1 30); do
    up=$($COMPOSE ps --services --filter status=running 2>/dev/null | wc -l)
    total=$($COMPOSE ps --services 2>/dev/null | wc -l)
    if [ "$up" -eq "$total" ] && [ "$total" -gt 0 ]; then
        settled=$((settled + 1)); [ "$settled" -ge 3 ] && break
    else settled=0; fi
    sleep 2
done

if [ "$settled" -ge 3 ]; then
    ok "all ${total} services running"
else
    bad "services did not stabilise"
    $COMPOSE ps | sed 's/^/   /'
    note "logs:  $COMPOSE logs --tail 50"
    exit 1
fi

# ---------------------------------------------------------------------------
step "Verdict"
DOMAIN=$(grep '^SITE_DOMAIN=' infra/docker/.env | cut -d= -f2)
printf '\n   %s%s deployed.%s\n\n' "$G" "$ENV" "$X"
printf '   App        https://%s\n' "$DOMAIN"
printf '   API        https://%s/api\n' "$DOMAIN"
printf '   Health     https://%s/health\n' "$DOMAIN"
printf '\n   %sOutbound mail reaches the real internet.%s\n' "$Y" "$X"
printf '\n'
