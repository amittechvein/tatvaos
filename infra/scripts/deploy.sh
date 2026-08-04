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
$COMPOSE build 2>&1 | tail -5 | sed 's/^/   /'
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
sleep 6
for f in local/postgres/init/*.sql; do
    $COMPOSE exec -T postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 < "$f" >/dev/null 2>&1 \
        && ok "$(basename "$f")" || bad "$(basename "$f")"
done

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
