#!/usr/bin/env bash
# ============================================================================
#  Prove that a sign-in handoff code can be redeemed exactly ONCE.
#
#      bash infra/scripts/verify-handoff-single-use.sh
#      bash infra/scripts/verify-handoff-single-use.sh --calibrate
#
#  Exit 0 = single use holds. Exit 1 = it does not. Exit 2 = could not run.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY THIS EXISTS SEPARATELY FROM verify-migrations.sh.
#
#   That script proves the schema CAN BE BUILT, twice, and says so itself. It
#   cannot see whether core.redeem_handoff_code actually behaves. Single use
#   is the whole security property of decision 0003: a code that redeems
#   twice is a session anyone who saw the URL can take, and nothing about a
#   successful deploy would look different.
#
#   It is proven HERE, in SQL, rather than in the application, because that is
#   where it is enforced. Two requests arriving together both pass any check
#   written in C#; only the UPDATE's own WHERE clause can be right. A test
#   that drove the C# would be testing the wrong layer and would pass even if
#   the guard were removed from the function — which is exactly what
#   --calibrate demonstrates.
#
#   --calibrate replaces the function with one missing `AND redeemed_at IS
#   NULL`, the single line that enforces this, and expects the SECOND redeem
#   to SUCCEED. If it does, this check can fail and its green means something.
#   Decision 0003 asks for that red first; this is it, runnable.
#
#   The container is throwaway and publishes no port, like verify-migrations.
#   FK checks are switched off for the harness rows (session_replication_role
#   = replica) so this needs no tenant or user fixture: the question is what
#   the redeem statement does, not what a user row looks like.
# ============================================================================

set -euo pipefail

CALIBRATE=0
[ "${1:-}" = "--calibrate" ] && CALIBRATE=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/local/postgres/init"
NAME="tv-handoff-single-use-$$"
DBNAME=handoff_check

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not on PATH — the check cannot run."; exit 2; }
docker info >/dev/null 2>&1 || {
  echo "Docker is installed but not running — the check cannot run."; exit 2; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB="$DBNAME" \
  postgres:16-alpine >/dev/null

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
  echo "CALIBRATING: removing 'AND redeemed_at IS NULL' from core.redeem_handoff_code"
  q "CREATE OR REPLACE FUNCTION core.redeem_handoff_code(p_hash text)
     RETURNS TABLE (tenant_id uuid, user_id uuid, path text)
     LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp
     AS \$\$
       UPDATE core.auth_handoff_codes SET redeemed_at = now()
        WHERE code_hash = p_hash AND expires_at > now()
       RETURNING auth_handoff_codes.tenant_id, auth_handoff_codes.user_id, auth_handoff_codes.path;
     \$\$;" >/dev/null
fi

# FKs off for harness rows: this asks what the redeem does, not what a user is.
q "SET session_replication_role = replica;
   INSERT INTO core.auth_handoff_codes (tenant_id, user_id, code_hash, path, expires_at)
   VALUES ('00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000002',
           'hash-live', '/mail/inbox', now() + interval '60 seconds'),
          ('00000000-0000-0000-0000-000000000001',
           '00000000-0000-0000-0000-000000000002',
           'hash-expired', '/mail/inbox', now() - interval '1 second');" >/dev/null

first=$(q  "SELECT count(*) FROM core.redeem_handoff_code('hash-live');")
second=$(q "SELECT count(*) FROM core.redeem_handoff_code('hash-live');")
expired=$(q "SELECT count(*) FROM core.redeem_handoff_code('hash-expired');")
unknown=$(q "SELECT count(*) FROM core.redeem_handoff_code('hash-never-existed');")
landed=$(q  "SELECT coalesce(string_agg(path, ','), '(none)')
               FROM core.auth_handoff_codes WHERE code_hash = 'hash-live';")

echo
echo "  first redeem  : $first  (want 1)"
if [ "$CALIBRATE" = 1 ]; then
  echo "  second redeem : $second  (want 1 — the guard is removed)"
else
  echo "  second redeem : $second  (want 0)"
fi
echo "  expired code  : $expired  (want 0)"
echo "  unknown code  : $unknown  (want 0)"
echo "  stored path   : $landed  (want /mail/inbox — the redirect comes from the row)"
echo

fail=0
[ "$first"   = "1" ] || { echo "RED: a valid code did not redeem."; fail=1; }
[ "$expired" = "0" ] || { echo "RED: an expired code redeemed."; fail=1; }
[ "$unknown" = "0" ] || { echo "RED: a code that never existed redeemed."; fail=1; }

if [ "$CALIBRATE" = 1 ]; then
  if [ "$second" = "1" ]; then
    echo "CALIBRATION OK: without the guard the second redeem SUCCEEDS,"
    echo "so the check below can fail and its green means something."
    exit 0
  fi
  echo "CALIBRATION FAILED: the second redeem was refused even with the guard"
  echo "removed — this harness is not testing what it claims to test."
  exit 1
fi

[ "$second" = "0" ] || { echo "RED: a code redeemed TWICE. Single use is not enforced."; fail=1; }

if [ "$fail" = 0 ]; then
  echo "────────────────────────────────────────────────────────────────"
  echo "A handoff code redeems once, and only once."
  echo "(Says nothing about the endpoints around it — see the PR body.)"
fi
exit "$fail"
