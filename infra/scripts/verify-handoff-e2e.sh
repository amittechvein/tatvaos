#!/usr/bin/env bash
# ============================================================================
#  Drive the sign-in handoff through the REAL API: mint, redeem, and the
#  refusals on either side of them.
#
#      bash infra/scripts/verify-handoff-e2e.sh
#
#  Exit 0 = the endpoints behave. Exit 1 = they do not. Exit 2 = could not run.
#
#  ─────────────────────────────────────────────────────────────────────────
#   WHY IT EXISTS, 16 SEPTEMBER 2026.
#
#   verify-handoff-single-use.sh proves the DATABASE spends a code once. It
#   cannot see the endpoints around it, and the first version of this feature
#   was reviewed on the strength of reading the sign-in code and arguing that
#   the redeem set the same cookies. It did not: AppDbContext maps every
#   entity to its table explicitly, the new one had no ToTable, and EF looked
#   for a relation called "AuthHandoffCodes" that does not exist. Mint answered
#   500 to every call. Nothing in a build, a lint, a migration replay or an
#   isolation suite could have caught it — they all passed.
#
#   So this asks the only question those cannot: what does the running server
#   actually answer.
#
#   NO PASSWORDS. The JWT signing key is generated here and never printed, and
#   the bearer token is minted locally against it for a seeded user — so this
#   needs no credential to exist anywhere, and prints none.
#
#   The database and the API are throwaway: a container on port 55432 and a
#   dotnet process on 5099, both stopped on exit.
# ============================================================================

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG="tv-handoff-e2e-$$"
PORT=5099
API="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
PASS=0; FAIL=0

ok()  { printf '  [PASS] %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  [FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
  [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null
  docker rm -f "$PG" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "Docker is not on PATH — cannot run."; exit 2; }
docker info >/dev/null 2>&1 || { echo "Docker is not running — cannot run."; exit 2; }
command -v dotnet >/dev/null 2>&1 || { echo "dotnet is not on PATH — cannot run."; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is not on PATH — cannot run."; exit 2; }

echo "== database"
docker run -d --rm --name "$PG" -p 55432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=tatvaos_mail \
  postgres:17-alpine >/dev/null || { echo "could not start postgres"; exit 2; }
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -d tatvaos_mail >/dev/null 2>&1 && break; sleep 1
done
for f in "$REPO"/local/postgres/init/*.sql; do
  docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U postgres -d tatvaos_mail -q < "$f" >/dev/null 2>&1
done
read -r USER_ID TENANT_ID <<<"$(docker exec "$PG" psql -tAF' ' -U postgres -d tatvaos_mail \
  -c "SELECT id, tenant_id FROM core.users WHERE email = 'amit@techvein.local' LIMIT 1")"
[ -n "${USER_ID:-}" ] || { echo "the seed has no user to act as — cannot run"; exit 2; }
echo "  acting as seeded user ${USER_ID:0:8}… in tenant ${TENANT_ID:0:8}…"

echo "== api"
KEY=$(openssl rand -hex 32)          # generated here; never printed, never stored
export Jwt__SigningKey="$KEY"
export Jwt__Issuer="$API"
export Jwt__Audience="tatvaos-mail"
export ConnectionStrings__Postgres="Host=127.0.0.1;Port=55432;Database=tatvaos_mail;Username=tatvaos_app;Password=ignored;Pooling=true"
export ASPNETCORE_URLS="$API"
export ASPNETCORE_ENVIRONMENT=Development
dotnet run --project "$REPO/apps/api" > "$WORK/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 120); do curl -sf "$API/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/health" >/dev/null 2>&1 || {
  echo "  the API did not start. Last lines:"; tail -15 "$WORK/api.log"; exit 2; }
echo "  answering on $API/health"

TOKEN=$(KEY="$KEY" USER_ID="$USER_ID" TENANT_ID="$TENANT_ID" ISS="$API" node -e '
const c=require("crypto");
const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const now=Math.floor(Date.now()/1000);
const p={sub:process.env.USER_ID,
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier":process.env.USER_ID,
  email:"amit@techvein.local",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role":"org_owner",
  tenant_id:process.env.TENANT_ID, jti:c.randomUUID(),
  iss:process.env.ISS, aud:"tatvaos-mail", nbf:now, exp:now+900};
const h=b({alg:"HS256",typ:"JWT"}), y=b(p);
const s=c.createHmac("sha256",Buffer.from(process.env.KEY,"utf8")).update(h+"."+y).digest("base64url");
process.stdout.write(h+"."+y+"."+s);')

mint() {
  curl -s -o "$WORK/mint.json" -w '%{http_code}' -X POST "$API/api/auth/handoff" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"path\":\"$1\"}"
}

echo
echo "== mint"
[ "$(mint "/mail/inbox")" = "200" ] && ok "an allowed path mints (200)" \
  || { bad "an allowed path was refused"; tail -8 "$WORK/api.log"; }

URL=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$WORK/mint.json")
case "$URL" in
  *"/handoff#c="*"&p=%2Fmail%2Finbox") ok "the code is in the FRAGMENT and the path is escaped" ;;
  *) bad "unexpected url shape (code withheld): ${URL%%#*}#…" ;;
esac
CODE=$(printf '%s' "$URL" | sed -n 's/.*#c=\([^&]*\).*/\1/p')
[ "${#CODE}" -ge 40 ] && ok "the code is 256 bits of base64url (${#CODE} chars)" \
                      || bad "the code is too short (${#CODE} chars)"

[ "$(mint "/org")"                  = "200" ] && ok "/org mints — the customer console the app's Admin tile opens" || bad "/org was refused"
[ "$(mint "/platform")"             = "400" ] && ok "/platform is refused — not on the allowlist" || bad "/platform was NOT refused"
[ "$(mint "//evil.example.com")"    = "400" ] && ok "a scheme-relative //host is refused" || bad "//host was NOT refused"
[ "$(mint "/mail/../org")"          = "400" ] && ok "path traversal is refused" || bad "traversal was NOT refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/handoff" \
      -H 'Content-Type: application/json' -d '{"path":"/mail"}')" = "401" ] \
  && ok "minting without a token is 401" || bad "mint answered someone with no token"

echo
echo "== redeem"
st=$(curl -s -o "$WORK/r1.json" -D "$WORK/r1.h" -w '%{http_code}' -X POST "$API/api/auth/handoff/redeem" \
      -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
[ "$st" = "200" ] && ok "a fresh code redeems (200)" || { bad "redeem answered $st"; cat "$WORK/r1.json"; }

# The half that cannot be proven by reading: does it actually sign the browser in.
grep -qi 'set-cookie: *tv_refresh_0=' "$WORK/r1.h" && ok "it sets the sign-in cookie (tv_refresh_0)" || bad "no tv_refresh_0 — the browser would NOT be signed in"
grep -qi 'set-cookie: *tv_active='    "$WORK/r1.h" && ok "it sets the active-account cookie" || bad "no tv_active cookie"
grep -qi 'httponly'                   "$WORK/r1.h" && ok "the cookie is HttpOnly" || bad "the cookie is not HttpOnly"
grep -q '"redirect":"/mail/inbox"'    "$WORK/r1.json" && ok "the redirect is the path stored at mint, not one from the URL" || bad "unexpected redirect"
grep -qi 'accessToken\|refreshToken'  "$WORK/r1.json" && bad "LEAK: a token was handed to the page" || ok "no token in the body — cookies only"

st2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/handoff/redeem" \
       -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
[ "$st2" = "401" ] && ok "the same code a second time is 401" || bad "single use failed through the endpoint ($st2)"

st3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/handoff/redeem" \
       -H 'Content-Type: application/json' -d '{"code":"not-a-real-code"}')
[ "$st3" = "401" ] && ok "an invented code gets the same 401" || bad "an unknown code answered $st3"

echo
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" = 0 ] || exit 1
