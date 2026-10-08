#!/usr/bin/env bash
#
# A personal plan is NEVER invoiced by the organisation issuer
# (Mr. Singh on PR 313, 28 Sept 2026).
#
#   1. the personal house: preview and issue are REFUSED, and no invoice row
#      is written, even with a personal Premium subscription in it and a
#      complete billing profile (so the guard is the only thing stopping it)
#   2. a personal row inside an ORGANISATION (it should never exist; nothing
#      forbids it in the schema): the organisation's invoice still bills the
#      organisation's own plan, never the personal one
#   3. the cycle change and the billing summary read the organisation's row
#
# RED FIRST: run this against the combined branch WITHOUT the guard (the
# commit before it): 1 and 2 fail — the house is invoiced for a personal plan,
# and the organisation is billed "Personal Premium".
#
# Needs: the Development API ($TATVAOS_API) with DevOperatorSignIn on, built
# from a tree holding both 313 and billing; the local seed (the house on
# personal.local, Techvein).
#   bash tests/billing-personal/test.sh
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
HOUSE="99999999-9999-9999-9999-999999999999"; HOUSE_DOMAIN="a9999999-9999-9999-9999-999999999999"
TECHVEIN="11111111-1111-1111-1111-111111111111"; TECHVEIN_OWNER="d1111111-1111-1111-1111-111111111111"
PREMIUM="b0000000-0000-0000-0000-000000000003"
RUN=$(date +%s)

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  ✗ %s\n' "$1"; }
step() { printf '\n>> %s\n' "$1"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — got [$2], wanted [$3]"; fi
}
has()   { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 240)]"; fi; }
hasnt() { if [ -z "$2" ]; then fail "$1 — nothing to look in"; elif printf '%s' "$2" | grep -qF -- "$3"; then fail "$1 — FOUND '$3' in [$(printf '%s' "$2" | head -c 240)]"; else pass "$1"; fi; }
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d '\r'; }
req() {
    local a=(-s -w '\n%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json' -H "Authorization: Bearer $3")
    [ -n "${4:-}" ] && a+=(-d "$4")
    curl "${a[@]}"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

step "0. Setup: seller details, an operator, a personal Premium subscriber with a billing profile"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ] && pass "API health 200" || { fail "API down"; exit 1; }
OP=$(curl -s -X POST "$API/api/dev/operator-session" | j "d['accessToken']")
[ -n "$OP" ] && pass "operator signed in" || { fail "no operator"; exit 1; }
for kv in "billing.seller.legal_name|Techvein IT Solutions Pvt. Ltd." "billing.seller.gstin|10AAACT1234A1Z5" \
          "billing.seller.address|Patna, Bihar" "billing.seller.state_code|10" "billing.seller.sac|998315" \
          "billing.invoice_prefix|TVP" "billing.payment_terms_days|15"; do
    PG "INSERT INTO core.platform_settings (key, value) VALUES ('${kv%%|*}', '${kv#*|}') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null
done
P_ID=$(PG "INSERT INTO core.users (tenant_id, domain_id, email, display_name, role, status) VALUES ('$HOUSE', '$HOUSE_DOMAIN', 'payer.$RUN@personal.local', 'Payer $RUN', 'employee', 'active') RETURNING id" | head -1)
PG "INSERT INTO core.subscriptions (tenant_id, plan_id, status, seats, started_at, renews_at, user_id) VALUES ('$HOUSE', '$PREMIUM', 'active', 1, now(), now() + interval '30 days', '$P_ID')" >/dev/null
same "a personal Premium subscription in the house" "$(PG "SELECT count(*) FROM core.subscriptions WHERE user_id='$P_ID'")" "1"
r=$(req PUT "/api/admin/organisations/$HOUSE/billing/profile" "$OP" '{"legalName":"TatvaOS Personal","address":"Patna","stateCode":"10","email":"billing@personal.local"}')
[ "$(status "$r")" -lt 300 ] && pass "the house has a complete billing profile (so only the guard can stop an invoice)" || fail "profile: $(status "$r") $(body "$r" | head -c 200)"
HOUSE_INV_BEFORE=$(PG "SELECT count(*) FROM core.invoices WHERE tenant_id='$HOUSE'")

step "1. The personal house is never invoiced"
r=$(req POST "/api/admin/organisations/$HOUSE/invoices/preview" "$OP" '{"includePlan":true}')
same "preview for the house: refused (400)" "$(status "$r")" "400"
has "…saying personal accounts are not invoiced here" "$(body "$r")" "Personal accounts are not invoiced here"
r=$(req POST "/api/admin/organisations/$HOUSE/invoices" "$OP" '{"includePlan":true}')
same "issue for the house: refused (400)" "$(status "$r")" "400"
same "…and no invoice row was written for the house" "$(PG "SELECT count(*) FROM core.invoices WHERE tenant_id='$HOUSE'")" "$HOUSE_INV_BEFORE"
r=$(req POST "/api/admin/organisations/$HOUSE/invoices" "$OP" '{"includePlan":false,"extraLines":[{"description":"anything","quantity":1,"unitPrice":100}]}')
same "…not even a plan-less invoice (400)" "$(status "$r")" "400"

step "2. A personal row inside an organisation is never billed to it"
ORG_PLAN=$(PG "SELECT p.name FROM core.subscriptions s JOIN core.plans p ON p.id=s.plan_id WHERE s.tenant_id='$TECHVEIN' AND s.user_id IS NULL AND s.status<>'cancelled' ORDER BY s.started_at DESC LIMIT 1")
PG "INSERT INTO core.subscriptions (tenant_id, plan_id, status, seats, started_at, renews_at, user_id) VALUES ('$TECHVEIN', '$PREMIUM', 'active', 1, now() + interval '1 day', now() + interval '31 days', '$TECHVEIN_OWNER')" >/dev/null
r=$(req PUT "/api/admin/organisations/$TECHVEIN/billing/profile" "$OP" '{"legalName":"Techvein Test Buyer","address":"Patna","stateCode":"10","email":"accounts@techvein.local"}')
r=$(req POST "/api/admin/organisations/$TECHVEIN/invoices/preview" "$OP" '{"includePlan":true}')
B=$(body "$r")
same "the organisation's preview still works (200)" "$(status "$r")" "200"
has "…billing the organisation's own plan ($ORG_PLAN)" "$B" "$ORG_PLAN plan"
hasnt "…never the personal row's plan" "$B" "Personal Premium"
r=$(req GET "/api/admin/organisations/$TECHVEIN/billing" "$OP")
[ "$(status "$r")" = "200" ] && hasnt "the billing summary shows the organisation's row, not the personal one" "$(body "$r")" "$PREMIUM" || pass "(no operator summary route here)"
CYCLE_BEFORE=$(PG "SELECT billing_cycle FROM core.subscriptions WHERE tenant_id='$TECHVEIN' AND user_id='$TECHVEIN_OWNER'")
req PUT "/api/admin/organisations/$TECHVEIN/billing/cycle" "$OP" '{"cycle":"yearly"}' >/dev/null
same "the cycle change touches the organisation's row, not the personal one" "$(PG "SELECT billing_cycle FROM core.subscriptions WHERE tenant_id='$TECHVEIN' AND user_id='$TECHVEIN_OWNER'")" "$CYCLE_BEFORE"
req PUT "/api/admin/organisations/$TECHVEIN/billing/cycle" "$OP" '{"cycle":"monthly"}' >/dev/null

# Clean up everything this run made.
PG "DELETE FROM core.subscriptions WHERE user_id IN ('$P_ID', '$TECHVEIN_OWNER')" >/dev/null
PG "DELETE FROM core.billing_profiles WHERE tenant_id IN ('$HOUSE', '$TECHVEIN')" >/dev/null
PG "DELETE FROM core.users WHERE id='$P_ID'" >/dev/null
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
