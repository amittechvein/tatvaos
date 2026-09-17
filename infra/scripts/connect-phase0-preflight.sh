#!/usr/bin/env bash
# ============================================================================
#  Connect Phase 0 — preflight. Run on the production box, from the repo root:
#
#      bash infra/scripts/connect-phase0-preflight.sh
#
#  READ-ONLY: checks, changes nothing. Green means deploy.sh will not be
#  surprised by Connect's additions. Companion: connect-phase0-smoke.sh for
#  after the deploy, and docs/runbooks/connect-phase0-deploy.md when a check
#  here fails and the fix is not obvious.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")

pass=0; fail=0
ok()  { echo "  OK    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
note(){ echo "  NOTE  $1"; }

echo "== the five Connect variables in $ENV_FILE =="
if [ ! -f "$ENV_FILE" ]; then
    bad "$ENV_FILE does not exist — this is the production server's env file"
else
    for v in LIVEKIT_API_KEY LIVEKIT_API_SECRET TURN_USERNAME TURN_PASSWORD TURN_EXTERNAL_IP; do
        val=$(grep -E "^${v}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
        if [ -z "$val" ]; then
            bad "$v is missing — see the Connect block in infra/docker/.env.production.example"
        elif [ "${val#CHANGE_ME}" != "$val" ]; then
            bad "$v is still CHANGE_ME (deploy.sh would refuse anyway)"
        else
            ok "$v is set"
        fi
    done
    # TURN advertises this address in relay candidates; a wrong value fails at
    # call time with no error at start, which is why it is checked here.
    MYIP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
    EIP=$(grep -E "^TURN_EXTERNAL_IP=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
    if [ -n "$MYIP" ] && [ -n "$EIP" ]; then
        if [ "$MYIP" = "$EIP" ]; then ok "TURN_EXTERNAL_IP matches this box ($MYIP)"
        else bad "TURN_EXTERNAL_IP=$EIP but this box's address is $MYIP"; fi
    fi
fi

echo "== files the new services mount =="
for f in infra/docker/livekit.yaml infra/docker/caddy/conf.d/connect.caddy; do
    [ -f "$f" ] && ok "$f present" || bad "$f missing — is the checkout on the right commit?"
done

echo "== host port collisions =="
# grep -c, not grep -q: -q exits on the first match, which SIGPIPEs ss, and
# `set -o pipefail` then reports the whole pipeline as failed. That silently
# turned "port in use" into "port free" — a check that could never fire.
# -c reads to EOF, and `|| true` survives grep's exit 1 on no match.
for p in 3478 7881; do
    hits=$(ss -tuln 2>/dev/null | grep -cE "[:.]${p}[[:space:]]" || true)
    if [ "${hits:-0}" -gt 0 ]; then bad "port $p is already in use on the host"
    else ok "port $p free"; fi
done

echo "== compose accepts the merged config (interpolation included) =="
if "${COMPOSE[@]}" config >/dev/null 2>&1; then
    ok "docker compose config parses"
else
    bad "docker compose config failed — run: ${COMPOSE[*]} config"
fi

echo "== caddy validates the new conf.d (uses the RUNNING container's env) =="
if "${COMPOSE[@]}" ps caddy 2>/dev/null | grep -q running; then
    if "${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        ok "caddy validate passed against the mounted config"
    else
        bad "caddy validate FAILED — run it without the redirect to read why; do not deploy first"
    fi
else
    note "caddy is not running; skipping validate (deploy.sh's reload will report instead)"
fi

echo
echo "$pass ok, $fail failed"
echo "Firewall reminder (this script cannot see Linode Cloud Firewall):"
echo "  inbound UDP 3478, UDP 49160-49999, UDP 50000-50199, TCP 7881"
[ "$fail" -eq 0 ]
