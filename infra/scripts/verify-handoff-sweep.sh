#!/usr/bin/env bash
# ============================================================================
#  Prove that the handoff-code sweep deletes what it should and nothing else.
#
#      bash infra/scripts/verify-handoff-sweep.sh
#      bash infra/scripts/verify-handoff-sweep.sh --calibrate
#
#  Exit 0 = the sweep is right. Exit 1 = it is not. Exit 2 = could not run.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHAT IT PROVES, 17 SEPTEMBER 2026.
#
#   core.auth_handoff_codes had no deletion at all: a hashed, single-use,
#   sixty-second credential per phone-to-browser sign-in, kept for ever. The
#   CTO's ruling: keep twenty-four hours past expiry for debugging, delete
#   after that, from a worker that already wakes up.
#
#   A sweep is a DELETE, so the dangerous failure is deleting too much — a
#   live code, which signs somebody out mid-handoff, or a recent one somebody
#   is debugging. So the rows below straddle every edge: live, just expired,
#   an hour expired, spent recently, and only the two a day past expiry should
#   go. Every row is checked by name, not by count — a count of 2 is also what
#   deleting the wrong two rows looks like.
#
#   It runs AS tatvaos_app with NO tenant set, which is how the worker calls
#   it. That proves the grant and the SECURITY DEFINER reach across tenants;
#   run as the superuser, as a harness usually is, neither would be tested.
#
#   --calibrate replaces the function's predicate with `true`. The live and
#   recent rows must then be reported deleted — if they are not, this harness
#   cannot see the failure it exists for.
#
#   Throwaway container, no port published — as verify-handoff-single-use.sh.
# ============================================================================

set -euo pipefail

CALIBRATE=0
[ "${1:-}" = "--calibrate" ] && CALIBRATE=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/local/postgres/init"
NAME="tv-handoff-sweep-$$"
DBNAME=handoff_check

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not on PATH — the check cannot run."; exit 2; }
docker info >/dev/null 2>&1 || {
  echo "Docker is installed but not running — the check cannot run."; exit 2; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB="$DBNAME" \
  postgres:17-alpine >/dev/null

PSQL=(docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DBNAME")

printf 'Waiting for postgres'
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d "$DBNAME" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 1
done
echo

# Same loop and the same seed rule as verify-migrations.sh and deploy.sh.
for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  case "$name" in *seed*) continue ;; esac
  "${PSQL[@]}" -q < "$f" >/dev/null 2>&1 || {
    echo "FAILED to apply $name — run verify-migrations.sh, which reports properly."; exit 2; }
done

q() { "${PSQL[@]}" -tAc "$1"; }

if [ "$CALIBRATE" = 1 ]; then
  echo "CALIBRATING: the sweep's predicate replaced with 'true'"
  q "CREATE OR REPLACE FUNCTION core.sweep_handoff_codes()
     RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp
     AS \$\$
       WITH gone AS (DELETE FROM core.auth_handoff_codes WHERE true RETURNING 1)
       SELECT count(*)::int FROM gone;
     \$\$;" >/dev/null
fi

# FKs off for harness rows: this asks what the DELETE does, not what a user is.
# Two tenants, so "no tenant set" has something to reach across.
T1='00000000-0000-0000-0000-000000000001'
T2='00000000-0000-0000-0000-000000000003'
U='00000000-0000-0000-0000-000000000002'
q "SET session_replication_role = replica;
   INSERT INTO core.auth_handoff_codes (tenant_id, user_id, code_hash, path, expires_at, redeemed_at) VALUES
     ('$T1', '$U', 'live',                 '/mail', now() + interval '60 seconds', NULL),
     ('$T1', '$U', 'expired-a-minute',     '/mail', now() - interval '1 minute',   NULL),
     ('$T2', '$U', 'expired-an-hour',      '/mail', now() - interval '1 hour',     NULL),
     ('$T2', '$U', 'spent-an-hour-ago',    '/mail', now() - interval '59 minutes', now() - interval '1 hour'),
     ('$T1', '$U', 'expired-23h59m',       '/mail', now() - interval '23 hours 59 minutes', NULL),
     ('$T1', '$U', 'expired-a-day-ago',    '/mail', now() - interval '25 hours',   NULL),
     ('$T2', '$U', 'spent-two-days-ago',   '/mail', now() - interval '48 hours',   now() - interval '48 hours 1 minute');" >/dev/null

# As the application role, no tenant: exactly how the worker runs it.
set +e
out=$(q "SET ROLE tatvaos_app; SELECT core.sweep_handoff_codes();" 2>&1)
deleted=$(printf '%s\n' "$out" | grep -E '^[0-9]+$' | tail -n1)
set -e
left=$(q "SELECT string_agg(code_hash, ',' ORDER BY code_hash) FROM core.auth_handoff_codes;")

has() { case ",$left," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

echo
echo "  sweep returned : ${deleted:-no number}"
# Not a number means the call itself failed; say what it said.
[ -n "$deleted" ] || printf '%s\n' "$out" | grep -v '^SET$' | sed 's/^/    /'
echo "  rows remaining : ${left:-(none)}"
echo

fail=0
if [ "$CALIBRATE" = 1 ]; then
  if ! has live && ! has expired-an-hour; then
    echo "CALIBRATION OK: with the predicate removed, the live and recent rows"
    echo "are gone and this harness reports it — its green means something."
    exit 0
  fi
  echo "CALIBRATION FAILED: a predicate of 'true' left live or recent rows —"
  echo "this harness is not testing what it claims to test."
  exit 1
fi

for keep in live expired-a-minute expired-an-hour spent-an-hour-ago expired-23h59m; do
  has "$keep" || { echo "RED: '$keep' was deleted — it is inside the 24 hours, or still live."; fail=1; }
done
for gone in expired-a-day-ago spent-two-days-ago; do
  has "$gone" && { echo "RED: '$gone' was kept — it is more than 24 hours past expiry."; fail=1; }
done
[ "$deleted" = "2" ] || { echo "RED: the sweep reported '$deleted' deleted, not 2 (as tatvaos_app, no tenant)."; fail=1; }

if [ "$fail" = 0 ]; then
  echo "────────────────────────────────────────────────────────────────"
  echo "The sweep deletes codes more than 24 hours past expiry, across tenants,"
  echo "as the application role — and leaves every live and recent one."
fi
exit "$fail"
