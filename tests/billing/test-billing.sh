#!/usr/bin/env bash
#
# TatvaOS billing, part 1 — GST invoices (Amit, 26 Sept 2026: prices PLUS
# 18% GST, monthly and yearly). What is proved:
#
#   * no invoice until Techvein's seller details AND the customer's billing
#     details are complete (an issued invoice cannot be edited)
#   * same state = CGST 9% + SGST 9%; another state = IGST 18%; yearly =
#     12 x monthly when no yearly price is set; the figures to the paisa
#   * one platform-wide number per financial year, PREFIX/FY/0001, never
#     reused (a void keeps its number; the re-issue gets the next)
#   * the same period cannot be billed twice
#   * paid only in full, once; a paid invoice cannot be voided
#   * each organisation sees only its own invoices; the owner has no
#     operator route; the app's database role cannot delete or edit
#
# Setup as tests/admin-plan-features. Puts every setting, profile, sequence
# and subscription back on exit.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_BILLING_TEST_PORT:-5091}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/billing-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf "%s" "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf "  %s✓%s %s\n" "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  %s✗%s %s\n" "$RED" "$RST" "$1"; }
step() { printf "\n%s>> %s%s\n" "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
jq_() { printf "%s" "$1" | j "$2"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
brief() { printf "%s" "$1" | head -c 220 | tr "\n" " "; }
# An empty operand is REFUSED, not compared: [ "" = "" ] is true, and that has
# already printed false greens in this repository (tests/orgapi).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}
# hasnt refuses an empty haystack: "not found in nothing" is the false green.
hasnt() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then fail "$1 — FOUND in: $(brief "$2")"
    else pass "$1"; fi
}
call() { curl -s -w "\n%{http_code}" -X GET "$API$1" -H "Authorization: Bearer $2"; }
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
# House rule 13: a run through tests/lib/throwaway-db.sh (PR 359) supplies
# its own database as TDB_CONN; the shared tatvaos_mail is only the fallback.
export ConnectionStrings__Postgres="${TDB_CONN:-Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true}"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
# call METHOD PATH TOKEN [JSON]
callm() {
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3"
    fi
}
feat() { :; }
TAG="billing-$RUN"
API_PID=""; PRINCIPAL_WAS=""; SEQ_WAS=""; FY=""
SUBS_WAS="$SCRATCH/subs.tsv"
cleanup() {
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    # This run's invoices and profiles go; the numbering goes back to where it was.
    PG "DELETE FROM core.invoices WHERE tenant_id IN ('$TECHVEIN','$SCHOOL') AND created_at >= '${T0:-infinity}'" >/dev/null
    PG "DELETE FROM core.billing_profiles WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
    [ -n "$FY" ] && { if [ -n "$SEQ_WAS" ]; then PG "UPDATE core.invoice_sequences SET last_seq=$SEQ_WAS WHERE financial_year='$FY'" >/dev/null
                      else PG "DELETE FROM core.invoice_sequences WHERE financial_year='$FY'" >/dev/null; fi; }
    PG "DELETE FROM core.platform_settings WHERE key LIKE 'billing.seller.%' OR key IN ('billing.invoice_prefix','billing.payment_terms_days','billing.payment_instructions')" >/dev/null
    if [ -s "$SUBS_WAS" ]; then
        while IFS='|' read -r tid cycle renews; do
            PG "UPDATE core.subscriptions SET billing_cycle='$cycle', renews_at=$( [ -z "$renews" ] && echo NULL || echo "'$renews'") WHERE tenant_id='$tid'" >/dev/null
        done < "$SUBS_WAS"
    fi
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
        fi
        kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

step "0. The migration re-runs clean; the database itself refuses the shapes that matter"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
base="${TATVAOS_PSQL% -Atc}"
out=$($base -v ON_ERROR_STOP=1 -q < "$ROOT/local/postgres/init/20260926-d-billing-invoices.sql" 2>&1 | grep -v "^wsl:" | grep ERROR)
[ -z "$out" ] && pass "a re-run reports no error" || fail "the re-run said: $(brief "$out")"
PG "SELECT tenant_id||'|'||billing_cycle||'|'||coalesce(renews_at::text,'') FROM core.subscriptions WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
$TATVAOS_PSQL "SELECT tenant_id||'|'||billing_cycle||'|'||coalesce(renews_at::text,'') FROM core.subscriptions WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" 2>/dev/null | grep -v "^wsl:" | tr -d '\r' > "$SUBS_WAS"
same "both organisations' subscriptions saved for restoring" "$(wc -l < "$SUBS_WAS" | tr -d ' ')" "2"
PG "UPDATE core.subscriptions SET billing_cycle='monthly', renews_at=NULL WHERE tenant_id='$TECHVEIN'" >/dev/null
PG "UPDATE core.subscriptions SET billing_cycle='monthly', renews_at=NULL WHERE tenant_id='$SCHOOL'" >/dev/null
r=$(PG "INSERT INTO core.billing_profiles (tenant_id, legal_name, gstin, address, state_code, email) VALUES ('$SCHOOL','x','29AAAAA0000A1Z5','a','10','a@b') RETURNING 'stored'")
[ "$r" = "stored" ] && fail "the database stored a GSTIN whose state differs from the state" || pass "the database refuses a GSTIN that does not match its state"
FY=$(PG "SELECT CASE WHEN extract(month FROM (now() AT TIME ZONE 'Asia/Kolkata')) >= 4 THEN extract(year FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int ELSE extract(year FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int - 1 END")
FY="$FY-$(printf '%02d' $(( (FY + 1) % 100 )))"
SEQ_WAS=$(PG "SELECT last_seq FROM core.invoice_sequences WHERE financial_year='$FY'")
pass "financial year is $FY (numbering was at ${SEQ_WAS:-nothing})"

step "1. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
# A fresh database (rule 13) has the operator-to-be without a phone number.
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as the operator" || { fail "operator sign-in failed"; exit 1; }
T0=$(PG "SELECT now()")
TV="/api/admin/organisations/$TECHVEIN"; SC="/api/admin/organisations/$SCHOOL"

step "2. No invoice before Techvein's own seller details exist"
PG "UPDATE core.subscriptions SET billing_cycle='monthly' WHERE tenant_id='$TECHVEIN'" >/dev/null
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":true}')
same "refused" "$(status "$r")" "400"
has  "…naming the seller GSTIN as missing" "$(body "$r")" "seller GSTIN"
same "…and nothing was numbered" "$(PG "SELECT count(*) FROM core.invoices WHERE created_at > '$T0'")" "0"
for kv in "billing.seller.legal_name|Techvein IT Solutions Pvt. Ltd." "billing.seller.gstin|10AAACT1234A1Z5" \
          "billing.seller.address|Patna, Bihar" "billing.seller.state_code|10" "billing.seller.sac|998315" \
          "billing.invoice_prefix|TV" "billing.payment_terms_days|15"; do
    k="${kv%%|*}"; v="${kv#*|}"
    PG "INSERT INTO core.platform_settings (key, value) VALUES ('$k', '$v') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null
done
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":true}')
same "with seller details but no customer billing details: refused" "$(status "$r")" "400"
has  "…saying so" "$(body "$r")" "no billing details"

step "3. Billing details: nonsense refused, the organisation can set its own"
r=$(callm PUT "/api/org/billing/profile" "$OWNER" '{"legalName":"Techvein","gstin":"27AAACT1234A1Z5","address":"Patna","stateCode":"10","email":"accounts@techvein.local"}')
same "a GSTIN from another state than the one chosen" "$(status "$r")" "400"
r=$(callm PUT "/api/org/billing/profile" "$OWNER" '{"legalName":"Techvein","address":"Patna","stateCode":"99","email":"accounts@techvein.local"}')
same "a state code that does not exist" "$(status "$r")" "400"
r=$(callm PUT "/api/org/billing/profile" "$OWNER" '{"legalName":"Techvein Test Buyer","gstin":"10AABCT9999B1Z3","address":"Boring Road, Patna","stateCode":"10","pincode":"800001","email":"accounts@techvein.local"}')
same "the owner saves Techvein's own billing details (Bihar, same state as the seller)" "$(status "$r")" "200"
r=$(callm PUT "$SC/billing/profile" "$OPERATOR" '{"legalName":"ABC School Trust","address":"Bengaluru","stateCode":"29","email":"fees@abcschool.local"}')
same "the operator saves the school's (Karnataka, another state)" "$(status "$r")" "200"
r=$(callm PUT "/api/org/billing/profile" "$OPERATOR" '{"legalName":"x","address":"x","stateCode":"10","email":"a@b"}')
# The operator's own session is the school's: this writes the SCHOOL's row, never Techvein's.
same "Techvein's details are still Techvein's" "$(PG "SELECT legal_name FROM core.billing_profiles WHERE tenant_id='$TECHVEIN'")" "Techvein Test Buyer"
r=$(callm PUT "$SC/billing/profile" "$OPERATOR" '{"legalName":"ABC School Trust","address":"Bengaluru","stateCode":"29","email":"fees@abcschool.local"}')

step "4. Same state: CGST 9% + SGST 9%. Business plan, 10 users at 99, monthly"
r=$(callm POST "$TV/invoices/preview" "$OPERATOR" '{"includePlan":true}'); B=$(body "$r")
same "a preview answers 200" "$(status "$r")" "200"
same "subtotal 990.00" "$(jq_ "$B" "'%.2f' % d['subtotal']")" "990.00"
same "CGST 89.10" "$(jq_ "$B" "'%.2f' % d['cgst']")" "89.10"
same "SGST 89.10" "$(jq_ "$B" "'%.2f' % d['sgst']")" "89.10"
same "no IGST" "$(jq_ "$B" "'%.2f' % d['igst']")" "0.00"
same "total 1168.20" "$(jq_ "$B" "'%.2f' % d['total']")" "1168.20"
same "…and a preview numbers nothing" "$(PG "SELECT count(*) FROM core.invoices WHERE created_at > '$T0'")" "0"

r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":true,"extraLines":[{"description":"AI credits top-up","quantity":1,"unitPrice":500}]}')
same "issued" "$(status "$r")" "201"; B=$(body "$r"); INV1=$(jq_ "$B" "d['id']")
# It names who issued it. Until 29 Sept 2026 every invoice carried the all-zero
# id here: the operator's id was read from a claim the JWT handler had renamed
# (apps/api/Shared/Auth/SignedIn.cs).
same "the invoice names the operator who issued it" "$(PG "SELECT created_by FROM core.invoices WHERE id='$INV1'")" \
    "$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")"
same "numbered PREFIX/FY/next" "$(jq_ "$B" "d['number']")" "TV/$FY/$(printf '%04d' $(( ${SEQ_WAS:-0} + 1 )))"
same "two lines, total 1758.20 (1490 + 18%)" "$(jq_ "$B" "str(len(d['lines']))+'/'+('%.2f' % d['total'])")" "2/1758.20"
same "the seller is copied onto it" "$(jq_ "$B" "d['seller']['gstin']")" "10AAACT1234A1Z5"
same "the next period now starts the day after this one ends" \
    "$(PG "SELECT (renews_at AT TIME ZONE 'Asia/Kolkata')::date = (SELECT period_end + 1 FROM core.invoices WHERE id='$INV1') FROM core.subscriptions WHERE tenant_id='$TECHVEIN'")" "t"
PERIOD1=$(PG "SELECT period_start FROM core.invoices WHERE id='$INV1'")
r=$(callm POST "$TV/invoices" "$OPERATOR" "{\"includePlan\":true,\"periodStart\":\"$PERIOD1\"}")
same "billing the same period twice is refused" "$(status "$r")" "400"
has  "…saying it is already invoiced" "$(body "$r")" "already invoiced"

step "5. Another state: IGST 18%. Institution, flat 14,999, YEARLY = 12 x monthly"
r=$(callm PUT "$SC/billing/cycle" "$OPERATOR" '{"cycle":"yearly"}');   same "school switched to yearly" "$(status "$r")" "200"
r=$(callm PUT "$SC/billing/cycle" "$OPERATOR" '{"cycle":"weekly"}');   same "weekly is refused" "$(status "$r")" "400"
r=$(callm POST "$SC/invoices" "$OPERATOR" '{"includePlan":true}'); B=$(body "$r")
same "issued" "$(status "$r")" "201"; INV2=$(jq_ "$B" "d['id']")
same "subtotal 179988.00, IGST 32397.84, no CGST/SGST, total 212385.84" \
    "$(jq_ "$B" "'%.2f/%.2f/%.2f/%.2f' % (d['subtotal'], d['igst'], d['cgst']+d['sgst'], d['total'])")" "179988.00/32397.84/0.00/212385.84"
same "a year long" "$(PG "SELECT period_end - period_start FROM core.invoices WHERE id='$INV2'")" "364"
same "numbered straight after Techvein's (one sequence for the platform)" \
    "$(jq_ "$B" "d['number']")" "TV/$FY/$(printf '%04d' $(( ${SEQ_WAS:-0} + 2 )))"

step "6. Each organisation sees its own invoices, and nothing else"
r=$(callm GET "/api/org/billing" "$OWNER"); B=$(body "$r")
same "Techvein's billing page: its one invoice" "$(jq_ "$B" "len(d['invoices'])")" "1"
same "…owing 1758.20" "$(jq_ "$B" "'%.2f' % d['outstanding']")" "1758.20"
r=$(callm GET "/api/org/billing/invoices/$INV2" "$OWNER");  same "the school's invoice through Techvein's own route" "$(status "$r")" "404"
r=$(callm GET "$SC/invoices/$INV1" "$OPERATOR");            same "Techvein's invoice through the school's operator address" "$(status "$r")" "404"
r=$(callm GET "$TV/billing" "$OWNER");                      same "the owner has no operator route" "$(status "$r")" "403"
r=$(callm POST "$TV/invoices" "$OWNER" '{"includePlan":false,"extraLines":[{"description":"x","quantity":1,"unitPrice":0}]}')
same "…and cannot issue itself an invoice" "$(status "$r")" "403"
r=$(callm GET "/api/admin/invoices" "$OPERATOR"); B=$(body "$r")
same "the operator's unpaid list has both" "$(jq_ "$B" "sum(1 for i in d['invoices'] if i['id'] in ('$INV1','$INV2'))")" "2"

step "7. Paid: whole amounts only, once"
r=$(callm POST "$TV/invoices/$INV1/paid" "$OPERATOR" '{"amount":1000,"method":"upi"}')
same "part payment refused" "$(status "$r")" "400"
r=$(callm POST "$TV/invoices/$INV1/paid" "$OPERATOR" '{"method":"bitcoin"}')
same "an unknown method refused" "$(status "$r")" "400"
r=$(callm POST "$TV/invoices/$INV1/paid" "$OPERATOR" '{"method":"upi","reference":"UTR123"}')
same "paid in full by UPI" "$(status "$r")" "200"
same "…recorded" "$(PG "SELECT status||'/'||paid_amount||'/'||payment_reference FROM core.invoices WHERE id='$INV1'")" "paid/1758.20/UTR123"
r=$(callm POST "$TV/invoices/$INV1/paid" "$OPERATOR" '{"method":"upi"}');           same "paying twice refused" "$(status "$r")" "400"
r=$(callm POST "$TV/invoices/$INV1/void" "$OPERATOR" '{"reason":"x"}');            same "voiding a paid invoice refused" "$(status "$r")" "400"

step "8. Void keeps the number; the period can then be billed again"
r=$(callm POST "$SC/invoices/$INV2/void" "$OPERATOR" '{"reason":""}');              same "no reason, no void" "$(status "$r")" "400"
r=$(callm POST "$SC/invoices/$INV2/void" "$OPERATOR" "{\"reason\":\"wrong cycle $TAG\"}")
same "voided with a reason" "$(status "$r")" "200"
same "…the row and its number are still there" "$(PG "SELECT status FROM core.invoices WHERE id='$INV2'")" "void"
PERIOD2=$(PG "SELECT period_start FROM core.invoices WHERE id='$INV2'")
r=$(callm POST "$SC/invoices" "$OPERATOR" "{\"includePlan\":true,\"periodStart\":\"$PERIOD2\"}"); B=$(body "$r")
same "the voided period is issued again" "$(status "$r")" "201"
INV3=$(jq_ "$B" "d['id']")
same "…with a NEW number, never the voided one's" "$(jq_ "$B" "d['number']")" "TV/$FY/$(printf '%04d' $(( ${SEQ_WAS:-0} + 3 )))"

step "9. The app's database role cannot delete an invoice or edit a line"
out=$($TATVAOS_PSQL "SET ROLE tatvaos_app; SELECT set_config('app.tenant_id','$TECHVEIN',false); DELETE FROM core.invoices WHERE id='$INV1';" 2>&1 | grep -v "^wsl:" | tr -d '\r')
has "DELETE on an invoice: permission denied" "$out" "permission denied"
out=$($TATVAOS_PSQL "SET ROLE tatvaos_app; SELECT set_config('app.tenant_id','$TECHVEIN',false); UPDATE core.invoice_lines SET amount=0 WHERE invoice_id='$INV1';" 2>&1 | grep -v "^wsl:" | tr -d '\r')
has "UPDATE on a line: permission denied" "$out" "permission denied"
same "the invoice is untouched" "$(PG "SELECT total FROM core.invoices WHERE id='$INV1'")" "1758.20"

step "9b. The DATABASE keeps an issued invoice as issued (Mr. Singh, 26 Sept: not only the code)"
appsql() { $TATVAOS_PSQL "SET ROLE tatvaos_app; SELECT set_config('app.tenant_id','$1',false); $2" 2>&1 | grep -v "^wsl:" | tr -d '\r'; }
has "UPDATE of the total: permission denied"  "$(appsql "$TECHVEIN" "UPDATE core.invoices SET total=1 WHERE id='$INV1';")" "permission denied"
has "UPDATE of the buyer: permission denied"  "$(appsql "$TECHVEIN" "UPDATE core.invoices SET buyer='{}' WHERE id='$INV1';")" "permission denied"
has "UPDATE of the number: permission denied" "$(appsql "$TECHVEIN" "UPDATE core.invoices SET number='X1' WHERE id='$INV1';")" "permission denied"
has "a paid invoice cannot go back to unpaid" \
    "$(appsql "$TECHVEIN" "UPDATE core.invoices SET status='issued', paid_on=NULL, paid_amount=NULL, payment_method=NULL WHERE id='$INV1';")" "paid invoice"
has "a paid invoice cannot be voided" \
    "$(appsql "$TECHVEIN" "UPDATE core.invoices SET status='void', voided_at=now(), void_reason='x', paid_on=NULL, paid_amount=NULL WHERE id='$INV1';")" "paid invoice"
has "a paid invoice's payment record cannot be rewritten" \
    "$(appsql "$TECHVEIN" "UPDATE core.invoices SET payment_reference='FORGED' WHERE id='$INV1';")" "paid invoice"
has "nothing on a void invoice can change" \
    "$(appsql "$SCHOOL" "UPDATE core.invoices SET void_reason='changed later' WHERE id='$INV2';")" "void invoice"
same "…Techvein's invoice is exactly as it was" \
    "$(PG "SELECT status||'/'||total||'/'||payment_reference FROM core.invoices WHERE id='$INV1'")" "paid/1758.20/UTR123"
# The grants are not so tight that paying stops working: the app may still
# record a payment on an issued invoice (the calibration for the refusals above).
has "…but an ISSUED invoice can still be marked paid by the app" \
    "$(appsql "$SCHOOL" "UPDATE core.invoices SET status='paid', paid_on=current_date, paid_amount=total, payment_method='upi' WHERE id='$INV3';")" "UPDATE 1"

step "9c. Invoice numbers never pass GST's 16 characters"
LONG="INSERT INTO core.invoices (tenant_id, number, financial_year, seq, issued_on, due_on, seller, buyer, place_of_supply, subtotal, total, created_by) VALUES ('$TECHVEIN', 'TATV/$FY/0001', '$FY', 99999, current_date, current_date, '{}', '{}', '10', 0, 0, '$TECHVEIN');"
out=$($TATVAOS_PSQL "$LONG" 2>&1 | grep -v "^wsl:" | tr -d '\r')
has "the database refuses a 17-character number, whatever the code does" "$out" "invoices_number_length"
PG "UPDATE core.platform_settings SET value='TATV' WHERE key='billing.invoice_prefix'" >/dev/null
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":false,"extraLines":[{"description":"x","quantity":1,"unitPrice":1}]}')
same "a 4-letter prefix: issuing is refused" "$(status "$r")" "400"
has  "…naming the prefix" "$(body "$r")" "prefix"
PG "UPDATE core.platform_settings SET value='ABC' WHERE key='billing.invoice_prefix'" >/dev/null
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":false,"extraLines":[{"description":"x","quantity":1,"unitPrice":1}]}')
same "a 3-letter prefix issues" "$(status "$r")" "201"
same "…at exactly 16 characters" "$(jq_ "$(body "$r")" "len(d['number'])")" "16"
PG "UPDATE core.platform_settings SET value='TV' WHERE key='billing.invoice_prefix'" >/dev/null

step "10. Written down"
same "4 issues, 1 payment, 1 void in the audit trail" \
    "$(PG "SELECT count(*) FILTER (WHERE action LIKE '%invoice.issued')||'/'||count(*) FILTER (WHERE action LIKE '%invoice.paid')||'/'||count(*) FILTER (WHERE action LIKE '%invoice.voided') FROM core.audit_logs WHERE occurred_at > '$T0'")" "4/1/1"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
