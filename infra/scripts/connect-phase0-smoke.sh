#!/usr/bin/env bash
# ============================================================================
#  Connect Phase 0 — post-deploy smoke test. Run on the box, from the repo
#  root, AFTER ./infra/scripts/deploy.sh production:
#
#      bash infra/scripts/connect-phase0-smoke.sh
#
#  READ-ONLY. Green here means the servers are up and routed; it does NOT
#  prove media flows across the internet — only the browser protocol in
#  docs/CONNECT_PHASE0.md does that, because the firewall is invisible from
#  inside the box.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")

pass=0; fail=0
ok()  { echo "  OK    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
note(){ echo "  NOTE  $1"; }

echo "== the two new services are running =="
for s in livekit coturn; do
    st=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$s" '$1==s{print $2}')
    if [ "$st" = "running" ]; then ok "$s running"
    else bad "$s state: ${st:-not created} — docker compose logs $s"; fi
done

echo "== livekit answers inside the compose network =="
body=$("${COMPOSE[@]}" exec -T caddy wget -q -O- http://livekit:7880/ 2>/dev/null || true)
if [ -n "$body" ]; then ok "livekit:7880 responds ('$body')"
else note "no body from livekit:7880 — not fatal by itself; check the public route below and 'docker compose logs livekit'"; fi

echo "== signalling route through Caddy, public TLS =="
DOM=$(grep -E '^CONNECT_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOM}/rtc/validate" || echo 000)
case "$code" in
    401|400) ok "https://${DOM}/rtc reaches LiveKit (HTTP $code without a token is correct)";;
    404)     bad "https://${DOM}/rtc/validate is 404 — the request is still landing on the web app, so Caddy is serving the OLD config. Run: ${COMPOSE[*]} exec -T caddy caddy reload --config /etc/caddy/Caddyfile";;
    000)     bad "could not reach https://${DOM} at all";;
    *)       bad "https://${DOM}/rtc/validate returned $code — read: docker compose logs caddy livekit";;
esac

echo "== coturn is bound on the host =="
if ss -ulnH 2>/dev/null | grep -qE '[:.]3478\b'; then ok "UDP 3478 bound"
else bad "nothing listening on UDP 3478 — docker compose logs coturn"; fi

echo "== recent error lines (context, not a verdict) =="
"${COMPOSE[@]}" logs --since 15m livekit 2>&1 | grep -iE 'error|fatal' | tail -5 || true
"${COMPOSE[@]}" logs --since 15m coturn 2>&1 | grep -iE 'error|fatal' | tail -5 || true

echo
echo "$pass ok, $fail failed"
echo "Next: bash infra/scripts/connect-dev-token.sh <name>  →  paste at https://${DOM}/connect/dev"
echo "Then the four-step protocol in docs/CONNECT_PHASE0.md (two networks, Force TURN, drop test)."
[ "$fail" -eq 0 ]
