#!/usr/bin/env bash
#
# TatvaOS Mail - bring up the local stack and verify it, in one command.
#
#   wsl -d Ubuntu bash ./scripts/up.sh
#
# Builds, waits for health, runs both test suites, and prints one verdict.
# Runs diagnose.sh automatically if anything is wrong, so you never have to
# work out which script to reach for next.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

c() { [ -t 1 ] && printf '%s' "$1" || true; }
G=$(c $'\033[32m'); R=$(c $'\033[31m'); Y=$(c $'\033[33m')
C=$(c $'\033[36m'); D=$(c $'\033[90m'); B=$(c $'\033[1m'); X=$(c $'\033[0m')

step() { printf '\n%s%s>> %s%s\n' "$B" "$C" "$1" "$X"; }
ok()   { printf '   %s%s%s\n' "$G" "$1" "$X"; }
bad()  { printf '   %s%s%s\n' "$R" "$1" "$X"; }
dim()  { printf '   %s%s%s\n' "$D" "$1" "$X"; }

command -v docker >/dev/null 2>&1 || {
    bad "docker not found inside WSL"
    dim "Docker Desktop > Settings > Resources > WSL Integration > enable Ubuntu"
    exit 1
}
docker info >/dev/null 2>&1 || {
    bad "Docker daemon not responding - start Docker Desktop and wait for the whale to settle"
    exit 1
}

# ---------------------------------------------------------------------------
step "1/5  Building and starting containers"
if docker compose up -d --build 2>&1 | grep -Ei 'error|failed' | head -5; then :; fi
docker compose up -d --build >/dev/null 2>&1
ok "compose up complete"

# ---------------------------------------------------------------------------
step "2/5  Waiting for services to settle"
# Containers can report 'running' a moment before they are actually usable,
# and a crash-looping container flickers through 'running' too. Require the
# state to hold steady rather than trusting a single sample.
settled=0
for i in $(seq 1 30); do
    pg=$(docker inspect -f '{{.State.Health.Status}}' tv-postgres 2>/dev/null || echo none)
    pf=$(docker inspect -f '{{.State.Status}}'        tv-postfix  2>/dev/null || echo none)
    dc=$(docker inspect -f '{{.State.Status}}'        tv-dovecot  2>/dev/null || echo none)

    if [ "$pg" = healthy ] && [ "$pf" = running ] && [ "$dc" = running ]; then
        settled=$((settled + 1))
        [ "$settled" -ge 3 ] && break
    else
        settled=0
    fi
    sleep 2
done

if [ "$settled" -ge 3 ]; then
    ok "postgres healthy, postfix and dovecot stable"
else
    bad "services did not stabilise (postgres=$pg postfix=$pf dovecot=$dc)"
    dim "running diagnostics..."
    bash ./scripts/diagnose.sh
    exit 1
fi

# ---------------------------------------------------------------------------
step "3/5  Mail flow"
bash ./scripts/test-mail.sh
mail_rc=$?

# ---------------------------------------------------------------------------
step "4/5  Tenant isolation"
bash ./scripts/test-isolation.sh
iso_rc=$?

# ---------------------------------------------------------------------------
step "5/5  Verdict"
printf '\n%s%s%s\n' "$C" "======================================================" "$X"

if [ "$mail_rc" -eq 0 ] && [ "$iso_rc" -eq 0 ]; then
    printf '  %s%sLocal stack is fully working.%s\n\n' "$B" "$G" "$X"
    dim "Mailpit  http://localhost:8025"
    dim "IMAP     localhost:1143  amit@techvein.local / devpass123  (no encryption)"
    dim "SMTP     localhost:5870"
    dim "Postgres localhost:5432  tatvaos_app / dev_app_pw"
    printf '\n'
    dim "Sprint 0.3 complete. Sprint 0.2 (cold-IP delivery to Gmail)"
    dim "cannot be done locally - it needs a real VM with a real IP."
    printf '\n'
    exit 0
fi

[ "$mail_rc" -ne 0 ] && bad "mail flow FAILED"
[ "$iso_rc"  -ne 0 ] && bad "tenant isolation FAILED - stop and fix before writing more code"
printf '\n'
dim "running diagnostics..."
bash ./scripts/diagnose.sh
dim "See docs/runbooks/01-mail-edge-config-errors.md"
printf '\n'
exit 1
