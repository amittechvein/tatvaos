#!/usr/bin/env bash
#
# TatvaOS Mail — deploy to a cloud environment
#
#   ./deploy.sh testing
#   ./deploy.sh production
#
# Run ON the target server, from the repo checkout.

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
    testing|production) ;;
    *) printf '\nUsage: ./deploy.sh testing|production\n\n'; exit 1 ;;
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
#  The guard that matters.
#
#  Deploying the testing overlay to production would silently disable outbound
#  containment; deploying production config to the test box would let test mail
#  reach real people. Both are one typo away, so the server states which it is.
# ---------------------------------------------------------------------------
# Per-checkout marker, not per-host: with testing and production on the SAME
# VPS, a host-level file cannot tell them apart. Falls back to the host file
# for a dedicated server.
MARKER=""
[ -f .environment ] && MARKER=.environment
[ -z "$MARKER" ] && [ -f /etc/tatvaos-environment ] && MARKER=/etc/tatvaos-environment

if [ -n "$MARKER" ]; then
    DECLARED=$(tr -d '[:space:]' < "$MARKER")
    if [ "$DECLARED" != "$ENV" ]; then
        bad "This checkout is marked '${DECLARED}' but you asked to deploy '${ENV}'."
        note "Deploying testing config to production silently disables outbound"
        note "containment; the reverse lets test mail reach real people."
        note "If genuinely intended, update ${MARKER} first."
        exit 1
    fi
    ok "checkout is marked ${DECLARED} (${MARKER})"
else
    printf '   %s[warn]%s No environment marker found.\n' "$Y" "$X"
    note "Set it once so a wrong-environment deploy is caught:"
    note "  echo ${ENV} > .environment"
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
step "Starting services"
$COMPOSE up -d --remove-orphans 2>&1 | tail -12 | sed 's/^/   /'

# ---------------------------------------------------------------------------
step "Applying schema"

# Wait for Postgres to accept connections rather than sleeping and hoping.
# A fixed sleep is either too short on a cold first deploy or wasted on every
# one after.
for i in $(seq 1 30); do
    $COMPOSE exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 2
done

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
    exit 1
}

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
if [ "$ENV" = "testing" ]; then
    printf '   Webmail    https://webmail.%s\n' "$DOMAIN"
    printf '   Caught     https://mail-catcher.%s\n' "$DOMAIN"
    printf '\n   %sOutbound mail is contained — nothing reaches real inboxes.%s\n' "$D" "$X"
else
    printf '\n   %sOutbound mail reaches the real internet.%s\n' "$Y" "$X"
fi
printf '\n'
