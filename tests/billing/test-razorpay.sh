#!/usr/bin/env bash
#
# TatvaOS billing, part 2 — paying invoices online through Razorpay (Amit,
# 26 Sept 2026: "payment mode only online via razorpay").
#
# Against tests/billing/fake-razorpay.py, a stand-in that refuses the wrong
# keys exactly as Razorpay does. What is proved:
#
#   * no keys / wrong keys: Pay now fails clearly and stores nothing
#   * one Payment Link per invoice, for the exact total in paise, no part
#     payment, back to the invoice's own page, Razorpay not mailing anyone
#   * the return from Razorpay counts only with the right signature for THIS
#     invoice's link
#   * the webhook: refused with no secret, a wrong secret, or a signature of
#     another body; a wrong amount never marks paid; a repeat is recorded
#     once; an unknown link is recorded, not crashed on
#   * with no session at all, the webhook pays the right organisation's
#     invoice and no other
#   * a missed webhook is recovered by the operator's "check with Razorpay"
#   * money arriving for a voided invoice leaves it void and flags a refund
#
# Setup as tests/billing/test-billing.sh. Puts everything back on exit.
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_RZP_TEST_PORT:-5093}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/razorpay-$$"
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
# A here-string, NOT printf | grep -q: under pipefail, grep -q exits at the
# first match, printf dies of SIGPIPE writing the rest, and the pipeline is
# "false". On a long text with an early match that made has() FAIL with the
# line present and hasnt() PASS with it present (3 Oct 2026, PR 386).
has() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif grep -qF -- "$3" <<< "$2"; then pass "$1"
    else fail "$1 — not found in: $(brief "$2")"; fi
}
# hasnt refuses an empty haystack: "not found in nothing" is the false green.
hasnt() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif grep -qF -- "$3" <<< "$2"; then fail "$1 — FOUND in: $(brief "$2")"
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
# House rule 13: a run through tests/lib/throwaway-db.sh supplies its own
# database as TDB_CONN; the shared tatvaos_mail is only the fallback.
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
FAKE_PORT="${TATVAOS_FAKE_RZP_PORT:-5198}"
FAKE="http://127.0.0.1:$FAKE_PORT"
KEY_ID="rzp_test_fake"; KEY_SECRET="fake_key_secret_$RUN"; HOOK_SECRET="fake_hook_secret_$RUN"
export Razorpay__BaseUrl="$FAKE" Billing__ReturnBaseUrl="http://localhost:3063"
TAG="rzp-$RUN"
API_PID=""; FAKE_PID=""; PRINCIPAL_WAS=""; SEQ_WAS=""; FY=""
cleanup() {
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    PG "DELETE FROM core.invoices WHERE tenant_id IN ('$TECHVEIN','$SCHOOL') AND created_at >= '${T0:-infinity}'" >/dev/null
    PG "DELETE FROM core.razorpay_events WHERE received_at >= '${T0:-infinity}'" >/dev/null
    PG "DELETE FROM core.billing_profiles WHERE tenant_id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
    [ -n "$FY" ] && { if [ -n "$SEQ_WAS" ]; then PG "UPDATE core.invoice_sequences SET last_seq=$SEQ_WAS WHERE financial_year='$FY'" >/dev/null
                      else PG "DELETE FROM core.invoice_sequences WHERE financial_year='$FY'" >/dev/null; fi; }
    PG "DELETE FROM core.platform_settings WHERE key LIKE 'billing.%'" >/dev/null
    PG "UPDATE core.razorpay_events SET acknowledged_at = now() WHERE acknowledged_at IS NULL" >/dev/null
    for port in "$PORT" "$FAKE_PORT" 5870; do
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$port/tcp" >/dev/null 2>&1 || true; fi
    done
    [ -n "$API_PID" ] && { kill "$API_PID" >/dev/null 2>&1; wait "$API_PID" 2>/dev/null; }
    [ -n "$FAKE_PID" ] && kill "$FAKE_PID" >/dev/null 2>&1
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT
hmac() { "$PY" -c "import hmac,hashlib,sys; print(hmac.new(sys.argv[1].encode(), sys.argv[2].encode(), hashlib.sha256).hexdigest())" "$1" "$2"; }
setting() { PG "INSERT INTO core.platform_settings (key, value, is_secret) VALUES ('$1', '$2', $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null; }
events() { PG "SELECT count(*) FROM core.razorpay_events WHERE received_at > '$T0'"; }
# hook BODY [SIGNATURE] [EVENT_ID] -> status
hook() {
    local sig="${2:-$(hmac "$HOOK_SECRET" "$1")}"
    curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/billing/razorpay/webhook" \
        -H "Content-Type: application/json" -H "X-Razorpay-Signature: $sig" -H "X-Razorpay-Event-Id: ${3:-evt_$RANDOM$RANDOM}" \
        --data-binary "$1"
}
paid_event() {  # LINK_ID AMOUNT_PAISE PAYMENT_ID
    printf '{"entity":"event","event":"payment_link.paid","payload":{"payment_link":{"entity":{"id":"%s","amount_paid":%s,"status":"paid"}},"payment":{"entity":{"id":"%s","amount":%s,"currency":"INR"}}}}' "$1" "$2" "$3" "$2"
}
invoice() {  # ORG_PATH_PREFIX -> id   (a one-line invoice for 990 before GST)
    jq_ "$(body "$(callm POST "$1/invoices" "$OPERATOR" '{"includePlan":false,"extraLines":[{"description":"Test service","quantity":1,"unitPrice":990}]}')")" "d['id']"
}

step "0. The migrations re-run clean; the fake Razorpay answers"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
base="${TATVAOS_PSQL% -Atc}"
for f in 20260926-d-billing-invoices.sql 20260926-e-billing-razorpay.sql; do
    out=$($base -v ON_ERROR_STOP=1 -q < "$ROOT/local/postgres/init/$f" 2>&1 | grep -v "^wsl:" | grep ERROR)
    [ -z "$out" ] && pass "$f re-runs clean" || fail "$f: $(brief "$out")"
done
FY=$(PG "SELECT CASE WHEN extract(month FROM (now() AT TIME ZONE 'Asia/Kolkata')) >= 4 THEN extract(year FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int ELSE extract(year FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int - 1 END")
FY="$FY-$(printf '%02d' $(( (FY + 1) % 100 )))"
SEQ_WAS=$(PG "SELECT last_seq FROM core.invoice_sequences WHERE financial_year='$FY'")
"$PY" "$ROOT/tests/billing/fake-razorpay.py" "$FAKE_PORT" "$KEY_ID" "$KEY_SECRET" > "$SCRATCH/fake.log" 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 20); do curl -s "$FAKE/_control/log" >/dev/null 2>&1 && break; sleep 0.5; done
same "the fake answers, and has seen nothing" "$(curl -s "$FAKE/_control/log")" "[]"

PG "INSERT INTO core.platform_settings (key, value, is_secret) VALUES ('billing.razorpay.key_secret', 'plain-before-$RUN', true) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value" >/dev/null
same "a secret saved before encryption existed is in the table as plain text" \
    "$(PG "SELECT value FROM core.platform_settings WHERE key='billing.razorpay.key_secret'")" "plain-before-$RUN"

step "1. API up; two people; seller and buyer details; invoices issued"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; exit 1; }
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
# A fresh database (rule 13) has the seeded people without phone numbers.
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OWNER" ] && [ -n "$OPERATOR" ] && pass "signed in (Techvein owner; operator from the school)" || { fail "sign-in failed"; exit 1; }
T0=$(PG "SELECT now()")
for kv in "billing.seller.legal_name|Techvein TEST" "billing.seller.gstin|10AAACT1234A1Z5" "billing.seller.address|Patna" \
          "billing.seller.state_code|10" "billing.seller.sac|998315" "billing.invoice_prefix|TV"; do
    setting "${kv%%|*}" "${kv#*|}" false
done
TV="/api/admin/organisations/$TECHVEIN"; SC="/api/admin/organisations/$SCHOOL"
callm PUT "$TV/billing/profile" "$OPERATOR" '{"legalName":"Techvein Buyer","address":"Patna","stateCode":"10","email":"accounts@techvein.local"}' >/dev/null
callm PUT "$SC/billing/profile" "$OPERATOR" '{"legalName":"ABC School Trust","address":"Bengaluru","stateCode":"29","email":"fees@abcschool.local"}' >/dev/null
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":false,"extraLines":[{"description":"Test service","quantity":1,"unitPrice":990}]}')
same "an invoice issues although the email could not be sent (no mail server here)" "$(status "$r")" "201"
INV1=$(jq_ "$(body "$r")" "d['id']"); NUM1=$(jq_ "$(body "$r")" "d['number']")
same "…and it is recorded as NOT emailed, not as sent" "$(PG "SELECT emailed_at IS NULL FROM core.invoices WHERE id='$INV1'")" "t"
step "1b. Secrets at rest: sealed at start, encrypted when saved, never returned, never logged (Mr. Singh fix 4)"
same "starting the API does NOT seal it (a rollback must still read it)" \
    "$(PG "SELECT value FROM core.platform_settings WHERE key='billing.razorpay.key_secret'")" "plain-before-$RUN"
same "…the operator is told one secret is still in plain text" \
    "$(jq_ "$(body "$(callm GET "/api/admin/settings/secrets-status" "$OPERATOR")")" "d['plainText']")" "1"
r=$(callm POST "/api/admin/settings/seal-secrets" "$OWNER")
same "the owner cannot seal (operator only)" "$(status "$r")" "403"
r=$(callm POST "/api/admin/settings/seal-secrets" "$OPERATOR")
same "the operator presses Encrypt stored secrets" "$(status "$r")" "200"
SEALED=$(PG "SELECT value FROM core.platform_settings WHERE key='billing.razorpay.key_secret'")
has   "…the plain-text secret is now encrypted" "$SEALED" "enc:v1:"
hasnt "…and the plain text is gone from the table" "$SEALED" "plain-before-$RUN"
same "…none left in plain text" "$(jq_ "$(body "$(callm GET "/api/admin/settings/secrets-status" "$OPERATOR")")" "d['plainText']")" "0"
r=$(callm PUT "/api/admin/settings" "$OPERATOR" "{\"billing.razorpay.webhook_secret\":\"typed-in-$RUN\"}")
same "the operator saves the webhook secret" "$(status "$r")" "200"
STORED=$(PG "SELECT value FROM core.platform_settings WHERE key='billing.razorpay.webhook_secret'")
has   "…it is stored encrypted" "$STORED" "enc:v1:"
hasnt "…not as typed" "$STORED" "typed-in-$RUN"
r=$(callm GET "/api/admin/settings" "$OPERATOR"); LIST=$(body "$r")
same "the settings list says it is set" "$(jq_ "$LIST" "[x['hasValue'] for x in d if x['key']=='billing.razorpay.webhook_secret'][0]")" "True"
same "…and returns no value for it" "$(jq_ "$LIST" "[x['value'] for x in d if x['key']=='billing.razorpay.webhook_secret'][0]")" "None"
hasnt "…anywhere in the answer" "$LIST" "typed-in-$RUN"
PG "DELETE FROM core.platform_settings WHERE key='billing.razorpay.webhook_secret'" >/dev/null

INV2=$(invoice "$TV"); INV3=$(invoice "$TV"); INV4=$(invoice "$TV"); SINV=$(invoice "$SC")
"$PY" "$ROOT/tests/billing/smtp-sink.py" 5870 "$SCRATCH/mail" > "$SCRATCH/sink.log" 2>&1 &
for _ in $(seq 1 20); do [ -d "$SCRATCH/mail" ] && break; sleep 0.3; done
sleep 1
r=$(callm POST "$TV/invoices" "$OPERATOR" '{"includePlan":false,"extraLines":[{"description":"Mailed","quantity":1,"unitPrice":1}]}')
MAILED=$(jq_ "$(body "$r")" "d['number']")
MAILFILE=$(grep -l "Invoice $MAILED" "$SCRATCH"/mail/*.eml 2>/dev/null | head -1)
[ -n "$MAILFILE" ] && pass "with a mail server, the invoice email really leaves ($MAILED)" || fail "no email for $MAILED reached the mail catcher"
has "…addressed to the billing contact" "$(head -1 "${MAILFILE:-/dev/null}")" "accounts@techvein.local"
[ -n "$INV2" ] && [ -n "$INV3" ] && [ -n "$INV4" ] && [ -n "$SINV" ] && pass "four more invoices (three Techvein, one school)" || fail "could not issue the test invoices"

step "2. Pay now without Razorpay keys: a clear refusal, nothing created"
r=$(callm POST "/api/org/billing/invoices/$INV1/pay" "$OWNER")
same "refused" "$(status "$r")" "502"
has  "…saying the keys are missing" "$(body "$r")" "Razorpay keys are missing"
setting billing.razorpay.key_id "$KEY_ID" false
setting billing.razorpay.key_secret "wrong_secret" true
r=$(callm POST "/api/org/billing/invoices/$INV1/pay" "$OWNER")
same "with the WRONG key secret Razorpay refuses, and so do we" "$(status "$r")" "502"
has  "…passing on Razorpay's reason" "$(body "$r")" "Authentication failed"
same "…and the invoice has no link" "$(PG "SELECT razorpay_link_id IS NULL FROM core.invoices WHERE id='$INV1'")" "t"
setting billing.razorpay.key_secret "$KEY_SECRET" true

step "3. Pay now: one link, for the exact total, back to the invoice page"
r=$(callm POST "/api/org/billing/invoices/$INV1/pay" "$OWNER"); URL1=$(jq_ "$(body "$r")" "d['url']")
same "answers 200 with Razorpay's page" "$(status "$r")" "200"
has  "…a Razorpay short link" "$URL1" "https://rzp.io/fake/"
r=$(callm POST "/api/org/billing/invoices/$INV1/pay" "$OWNER")
same "pressing it again gives the SAME link" "$(jq_ "$(body "$r")" "d['url']")" "$URL1"
LOGJ=$(curl -s "$FAKE/_control/log")
same "…Razorpay was asked once" "$(jq_ "$LOGJ" "len(d)")" "1"
same "…for 116820 paise (990 + 18% GST)" "$(jq_ "$LOGJ" "d[0]['amount']")" "116820"
same "…no part payment" "$(jq_ "$LOGJ" "d[0]['accept_partial']")" "False"
same "…reference = the invoice number" "$(jq_ "$LOGJ" "d[0]['reference_id']")" "$NUM1"
same "…returning to this invoice's page" "$(jq_ "$LOGJ" "d[0]['callback_url']")" "http://localhost:3063/org/billing/invoices/$INV1"
same "…and Razorpay does not mail or text the customer itself" "$(jq_ "$LOGJ" "str(d[0]['notify'])")" "{'email': False, 'sms': False}"
LINK1=$(PG "SELECT razorpay_link_id FROM core.invoices WHERE id='$INV1'")
r=$(callm POST "/api/org/billing/invoices/$SINV/pay" "$OWNER")
same "Techvein cannot open Pay now on the school's invoice" "$(status "$r")" "404"

step "4. The return from Razorpay: only a correct signature for THIS link counts"
callm POST "/api/org/billing/invoices/$INV2/pay" "$OWNER" >/dev/null
LINK2=$(PG "SELECT razorpay_link_id FROM core.invoices WHERE id='$INV2'"); NUM2=$(PG "SELECT number FROM core.invoices WHERE id='$INV2'")
SIG=$(hmac "$KEY_SECRET" "$LINK2|$NUM2|paid|pay_ret_$RUN")
r=$(callm POST "/api/org/billing/invoices/$INV2/confirm" "$OWNER" "{\"razorpayPaymentId\":\"pay_ret_$RUN\",\"razorpayPaymentLinkId\":\"$LINK2\",\"razorpayPaymentLinkReferenceId\":\"$NUM2\",\"razorpayPaymentLinkStatus\":\"paid\",\"razorpaySignature\":\"$(hmac wrong "$LINK2|$NUM2|paid|pay_ret_$RUN")\"}")
same "a wrong signature" "$(status "$r")" "400"
r=$(callm POST "/api/org/billing/invoices/$INV2/confirm" "$OWNER" "{\"razorpayPaymentId\":\"pay_ret_$RUN\",\"razorpayPaymentLinkId\":\"$LINK1\",\"razorpayPaymentLinkReferenceId\":\"$NUM2\",\"razorpayPaymentLinkStatus\":\"paid\",\"razorpaySignature\":\"$(hmac "$KEY_SECRET" "$LINK1|$NUM2|paid|pay_ret_$RUN")\"}")
same "a correctly signed return for ANOTHER invoice's link" "$(status "$r")" "400"
same "…still unpaid" "$(PG "SELECT status FROM core.invoices WHERE id='$INV2'")" "issued"
r=$(callm POST "/api/org/billing/invoices/$INV2/confirm" "$OWNER" "{\"razorpayPaymentId\":\"pay_ret_$RUN\",\"razorpayPaymentLinkId\":\"$LINK2\",\"razorpayPaymentLinkReferenceId\":\"$NUM2\",\"razorpayPaymentLinkStatus\":\"paid\",\"razorpaySignature\":\"$SIG\"}")
same "the genuine return" "$(status "$r")" "200"
same "…marks it paid by Razorpay with the payment id" \
    "$(PG "SELECT status||'/'||payment_method||'/'||razorpay_payment_id||'/'||paid_amount FROM core.invoices WHERE id='$INV2'")" "paid/razorpay/pay_ret_$RUN/1168.20"

step "5. The webhook: signature, amount, idempotence"
B=$(paid_event "$LINK1" 116820 "pay_hook_$RUN")
same "with NO webhook secret set, even a correctly signed event is refused" "$(hook "$B")" "400"
setting billing.razorpay.webhook_secret "$HOOK_SECRET" true
same "secret set: a body signed with the wrong secret is refused" "$(hook "$B" "$(hmac nottheSecret "$B")")" "400"
same "a body carrying the signature of a DIFFERENT body is refused" "$(hook "$B" "$(hmac "$HOOK_SECRET" "${B/116820/116821}")")" "400"
same "…none of the three recorded anything" "$(events)" "0"
BAD=$(paid_event "$LINK1" 100000 "pay_short_$RUN")
same "a genuine event paying the wrong amount is acknowledged" "$(hook "$BAD")" "200"
same "…the invoice stays unpaid" "$(PG "SELECT status FROM core.invoices WHERE id='$INV1'")" "issued"
PROBS=$(body "$(callm GET "/api/admin/billing/payment-problems" "$OPERATOR")")
same "the wrong amount is on the operator's payment-problems list" \
    "$(jq_ "$PROBS" "sum(1 for x in d['problems'] if x['outcome'].startswith('REVIEW') and x['invoiceId']=='$INV1')")" "1"
ALERTS=$(grep -l "needs attention" "$SCRATCH"/mail/*.eml 2>/dev/null)
[ -n "$ALERTS" ] && pass "…and an alert email went out" || fail "no payment-problem email reached the mail catcher"
# One email per active operator; the school's principal is one for this run.
has "…to the platform operator(s), this run's among them" "$(for f in $ALERTS; do head -1 "$f"; done)" "principal@abcschool.local"
has "…sent from alerts@tatvaos.com (the address Amit's never-Spam filter covers)" "$(grep -h -i '^From:' $ALERTS | head -1)" "alerts@tatvaos.com"
PID1=$(jq_ "$PROBS" "[x['eventId'] for x in d['problems'] if x['invoiceId']=='$INV1'][0]")
r=$(callm POST "/api/admin/billing/payment-problems/$PID1/acknowledge" "$OPERATOR")
same "acknowledged" "$(status "$r")" "200"
same "…and off the list" "$(jq_ "$(body "$(callm GET "/api/admin/billing/payment-problems" "$OPERATOR")")" "sum(1 for x in d['problems'] if x['invoiceId']=='$INV1')")" "0"
same "…and the event is kept for review" \
    "$(PG "SELECT count(*) FROM core.razorpay_events WHERE outcome LIKE 'REVIEW%' AND invoice_id='$INV1'")" "1"
same "the genuine, full payment" "$(hook "$B" "" "evt_full_$RUN")" "200"
same "…marks it paid" "$(PG "SELECT status||'/'||razorpay_payment_id FROM core.invoices WHERE id='$INV1'")" "paid/pay_hook_$RUN"
same "the same event delivered again" "$(hook "$B" "" "evt_full_$RUN")" "200"
same "…is recorded once" "$(PG "SELECT count(*) FROM core.razorpay_events WHERE event_id='evt_full_$RUN'")" "1"
same "a webhook for a link nobody has is acknowledged and recorded as unmatched" \
    "$(hook "$(paid_event plink_nobody 116820 pay_x)")/$(PG "SELECT count(*) FROM core.razorpay_events WHERE outcome LIKE 'unmatched%' AND received_at > '$T0'")" "200/1"

step "6. The webhook finds the right organisation on its own (no session at all)"
callm POST "/api/admin/organisations/$SCHOOL/invoices/$SINV/email" "$OPERATOR" >/dev/null
# The school's owner is not signed in; create the school's link through the operator's
# own session, which IS the school (the operator is the school's principal).
r=$(callm POST "/api/org/billing/invoices/$SINV/pay" "$OPERATOR")
same "the school's link" "$(status "$r")" "200"
SLINK=$(PG "SELECT razorpay_link_id FROM core.invoices WHERE id='$SINV'")
STOTAL=$(PG "SELECT (total*100)::bigint FROM core.invoices WHERE id='$SINV'")
same "the school's total is IGST (another state): 116820 paise" "$STOTAL" "116820"
same "a paid event for the school's link" "$(hook "$(paid_event "$SLINK" "$STOTAL" "pay_school_$RUN")")" "200"
same "…pays the SCHOOL's invoice" "$(PG "SELECT status FROM core.invoices WHERE id='$SINV'")" "paid"
same "…and no Techvein invoice took that payment" "$(PG "SELECT count(*) FROM core.invoices WHERE tenant_id='$TECHVEIN' AND razorpay_payment_id='pay_school_$RUN'")" "0"

step "7. A missed webhook: the operator asks Razorpay directly"
callm POST "/api/org/billing/invoices/$INV3/pay" "$OWNER" >/dev/null
LINK3=$(PG "SELECT razorpay_link_id FROM core.invoices WHERE id='$INV3'")
r=$(callm POST "$TV/invoices/$INV3/check-payment" "$OPERATOR")
same "before paying: Razorpay says created, still unpaid" "$(jq_ "$(body "$r")" "d['razorpay']+'/'+d['status']")" "created/issued"
curl -s -X POST "$FAKE/_control/pay/$LINK3" >/dev/null
r=$(callm POST "$TV/invoices/$INV3/check-payment" "$OPERATOR")
same "after paying (and no webhook): the check marks it paid" "$(jq_ "$(body "$r")" "d['razorpay']+'/'+d['status']")" "paid/paid"
r=$(callm POST "$TV/invoices/$INV3/check-payment" "$OWNER")
same "the owner has no such route" "$(status "$r")" "403"

step "8. Paid after a void: the invoice stays void and a refund is flagged"
callm POST "/api/org/billing/invoices/$INV4/pay" "$OWNER" >/dev/null
LINK4=$(PG "SELECT razorpay_link_id FROM core.invoices WHERE id='$INV4'")
callm POST "$TV/invoices/$INV4/void" "$OPERATOR" "{\"reason\":\"test $TAG\"}" >/dev/null
AUTH="$(printf '%s:%s' "$KEY_ID" "$KEY_SECRET" | base64 | tr -d '\n')"
same "voiding cancelled the invoice's Razorpay link, so an old email cannot pay it" \
    "$(jq_ "$(curl -s -H "Authorization: Basic $AUTH" "$FAKE/v1/payment_links/$LINK4")" "d['status']")" "cancelled"
same "a paid event for the voided invoice's link is acknowledged" "$(hook "$(paid_event "$LINK4" 116820 "pay_void_$RUN")")" "200"
same "…the invoice stays void" "$(PG "SELECT status FROM core.invoices WHERE id='$INV4'")" "void"
same "…and REFUND NEEDED is on record" "$(PG "SELECT count(*) FROM core.razorpay_events WHERE invoice_id='$INV4' AND outcome LIKE 'REFUND NEEDED%'")" "1"
r=$(callm POST "/api/org/billing/invoices/$INV4/pay" "$OWNER")
same "Pay now on a voided invoice is refused" "$(status "$r")" "400"

step "8b. The webhook refuses an oversized body before reading it (Mr. Singh fix 3)"
# From a file: a 70 KB command-line argument is over Windows' limit, and the
# curl would never run (an empty result, not a refusal).
# (Python writes through the shell: Windows Python cannot open a /c/... path.)
"$PY" -c "import sys; sys.stdout.write('{\"pad\":\"' + 'x'*70000 + '\"}')" > "$SCRATCH/big.json"
BIGSIG=$("$PY" -c "import sys,hmac,hashlib; print(hmac.new(b'$HOOK_SECRET', sys.stdin.buffer.read(), hashlib.sha256).hexdigest())" < "$SCRATCH/big.json")
same "the oversized body really is over 64 KB" "$(( $(wc -c < "$SCRATCH/big.json") > 65536 ))" "1"
same "a 70 KB body is refused as too large, even correctly signed" \
    "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/billing/razorpay/webhook" -H "Content-Type: application/json" -H "X-Razorpay-Signature: $BIGSIG" --data-binary "@$SCRATCH/big.json")" "413"
hasnt "no secret ever reached the API's log" "$(cat "$LOG")" "$KEY_SECRET"
hasnt "…nor the webhook secret" "$(cat "$LOG")" "$HOOK_SECRET"
hasnt "…nor the one typed into Settings" "$(cat "$LOG")" "typed-in-$RUN"

step "9. Written down"
same "four payments by Razorpay in the audit trail (return, webhook, webhook, check)" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%invoice.paid' AND occurred_at > '$T0' AND after_state::text LIKE '%razorpay%'")" "4"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
