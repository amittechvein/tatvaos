#!/usr/bin/env bash
# ============================================================================
#  Connect Phase 1 — post-deploy verification, PRODUCTION-SAFE.
#
#  Run on the box, from the repo root, AFTER ./infra/scripts/deploy.sh:
#
#      bash infra/scripts/connect-phase1-verify.sh
#
#  READ-ONLY against the database. It writes nothing, creates no fixtures and
#  deletes nothing, so it is safe on a box holding customer data.
#
#  ─────────────────────────────────────────────────────────────────────────
#   DO NOT RUN tests/isolation/test-isolation.sh ON PRODUCTION.
#
#   That suite INSERTS rows (its own fixtures, and a deliberate forged write),
#   and it asserts against the two demo tenants from *seed*.sql — which
#   deploy.sh skips on production precisely so demo data never reaches a real
#   database. On production it would both fail and litter.
#
#   This script proves the same properties a different way: by reading the
#   catalogue for the policies themselves, and by checking that the app role
#   sees nothing without a tenant. The insert-side proof stays in CI, where a
#   throwaway database is free.
#  ─────────────────────────────────────────────────────────────────────────
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")

PASSED=0; FAILED=0
ok()  { echo "  OK    $1"; PASSED=$((PASSED+1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED+1)); }

# tail -n1 is not cosmetic, and it is the reason this script reported a
# failure against a perfectly healthy database the first time it was written.
# psql prints a command tag for every non-SELECT statement even under -tA, so
# "SET app.tenant_id = ''; SELECT count(*)" comes back as two lines — SET,
# then the number — and squashing the whitespace yields "SET0", which equals
# nothing you would ever compare against. tests/isolation/test-isolation.sh
# carries the same guard and the same explanation.
q() {
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" \
        2>/dev/null | tail -n1 | tr -d '[:space:]'
}
# As the APP role, which is NOBYPASSRLS — the role the API actually uses.
# Asking postgres whether RLS works would answer about a role that ignores it.
qapp() {
    "${COMPOSE[@]}" exec -T postgres psql -U tatvaos_app -d tatvaos_mail -tAc "$1" \
        2>/dev/null | tail -n1 | tr -d '[:space:]'
}

echo "== the migration landed =="
n=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='connect'")
[ "${n:-0}" -eq 4 ] && ok "4 connect tables" || bad "expected 4 connect tables, found ${n:-0}"

n=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname='connect' AND p.prosecdef")
[ "${n:-0}" -eq 3 ] && ok "3 SECURITY DEFINER functions" || bad "expected 3 definer functions, found ${n:-0}"

# The two columns this migration adds to tables it does not own. If either is
# missing the deploy applied an older copy of the file.
n=$(q "SELECT count(*) FROM information_schema.columns
        WHERE (table_schema='core'    AND table_name='tenants'  AND column_name='allow_connect_guests')
           OR (table_schema='connect' AND table_name='meetings' AND column_name='calendar_event_id')")
[ "${n:-0}" -eq 2 ] && ok "allow_connect_guests + calendar_event_id present" \
                    || bad "expected both added columns, found ${n:-0} — an old migration ran"

echo "== RLS is enabled AND forced on every connect table =="
n=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname='connect' AND c.relrowsecurity AND c.relforcerowsecurity")
[ "${n:-0}" -eq 4 ] && ok "all 4 tables ENABLE + FORCE row level security" \
                    || bad "only ${n:-0} of 4 tables are forced — a table without FORCE is readable by its owner"

n=$(q "SELECT count(*) FROM pg_policies WHERE schemaname='connect' AND policyname='tenant_isolation'")
[ "${n:-0}" -eq 4 ] && ok "4 tenant_isolation policies" || bad "expected 4 policies, found ${n:-0}"

echo "== the nullif() guard is present in every policy =="
# Without it an unset tenant sends '' and a bare ::uuid cast THROWS, taking the
# request with it. Reading the catalogue is cheaper than reproducing it.
# ILIKE, not LIKE: Postgres re-renders the expression and prints NULLIF in
# upper case, so a case-sensitive match silently reports zero — which is what
# it did the first time this check was written.
n=$(q "SELECT count(*) FROM pg_policies WHERE schemaname='connect' AND qual ILIKE '%nullif%'")
[ "${n:-0}" -eq 4 ] && ok "every policy uses nullif(current_setting(...), '')" \
                    || bad "only ${n:-0} of 4 policies use nullif — check the migration"

echo "== the app role cannot read across tenants without context =="
n=$(qapp "SELECT count(*) FROM connect.meetings")
[ "${n:-1}" = "0" ] && ok "no tenant context returns zero meetings" \
                    || bad "DANGEROUS: ${n} meeting(s) visible to the app role with no tenant set"

n=$(qapp "SET app.tenant_id = ''; SELECT count(*) FROM connect.meetings")
[ "${n:-x}" = "0" ] && ok "empty tenant string returns zero, does not throw" \
                    || bad "empty app.tenant_id returned '${n}' — the nullif() guard is not working"

echo "== the app role is still NOBYPASSRLS =="
v=$(q "SELECT rolbypassrls FROM pg_roles WHERE rolname='tatvaos_app'")
[ "${v:-t}" = "f" ] && ok "tatvaos_app cannot bypass RLS" || bad "tatvaos_app CAN bypass RLS — tenant isolation is off"

echo "== the API has its LiveKit configuration =="
if "${COMPOSE[@]}" exec -T api printenv LiveKit__ApiKey >/dev/null 2>&1; then
    ok "LiveKit__ApiKey present in the api container"
else
    bad "the api container has no LiveKit__ApiKey — every token mint will refuse with 503"
fi

echo "== LiveKit is configured to call us back =="
# grep -c, not grep -q: -q exits on the first match and SIGPIPEs the producer,
# which under pipefail reads as a failure. Same bug, same fix, as the Phase 0
# coturn check.
c=$("${COMPOSE[@]}" exec -T livekit sh -c \
      'grep -c "api:8080/api/connect/webhooks/livekit" /etc/livekit.yaml' 2>/dev/null | tr -d '[:space:]')
if [ "${c:-0}" -gt 0 ] 2>/dev/null; then
    ok "webhook url present in livekit.yaml"
else
    bad "livekit.yaml has no webhook url — meetings will work but attendance will never record.
        The container must be RECREATED, not restarted, for a compose change to land."
fi

echo "== the guest doorstep answers, and answers the same way for anything unknown =="
DOM=$(grep -E '^CONNECT_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
# One is well-formed but unknown, the other is the wrong shape entirely. They
# take different code paths — shape check vs definer lookup — and must be
# indistinguishable from outside, or a stranger can enumerate which codes are
# real. Two requests is well inside the 60/min limiter.
a=$(curl -s --max-time 10 "https://${DOM}/api/connect/g/ZZZZZZZZZZZZZZZZZZZZZZ")
b=$(curl -s --max-time 10 "https://${DOM}/api/connect/g/notavalidcodeatall")
if [ "$a" != "$b" ]; then
    bad "the two answers differ — that is an oracle a stranger can probe"
    echo "        unknown:   $a"
    echo "        malformed: $b"
elif [ -z "$a" ]; then
    bad "no answer at all from https://${DOM}/api/connect/g/... — check: docker compose logs api caddy"
elif ! printf '%s' "$a" | grep -q 'This meeting link does not work'; then
    # Identical answers are necessary but not sufficient: if the route is not
    # registered at all, BOTH get the same generic 404 from the web app and
    # this check would pass while the guest path does not exist.
    bad "identical, but not OUR answer — the guest routes are not registered.
        Check that patch 0001 added MapConnectGuestEndpoints() to Program.cs."
    echo "        got: $a"
else
    ok "unknown and malformed codes give an identical answer (no oracle)"
    echo "        $a"
fi

echo
echo "$PASSED ok, $FAILED failed"
echo
echo "Still to check by hand — these need a signed-in session and cannot be faked:"
echo "  1. POST /api/connect/meetings            -> 201, a 22-char code, a joinUrl"
echo "  2. POST /api/connect/meetings/{id}/join  -> 200 with a token; paste it at /connect/dev"
echo "  3. join the room, then:"
echo "       docker compose ... exec -T postgres psql -U postgres -d tatvaos_mail \\"
echo "         -c \"SELECT kind, count(*) FROM connect.meeting_events GROUP BY 1\""
echo "     If that stays empty the meeting still works, but attendance does not exist."
[ "$FAILED" -eq 0 ]
