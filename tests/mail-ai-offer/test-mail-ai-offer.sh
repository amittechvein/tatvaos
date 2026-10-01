#!/usr/bin/env bash
#
# The operator's "offer Mail AI to this organisation" action (30 Sept 2026).
#
# WHY. Organisation 5 switched Mail AI on on 25 Sept, before its privacy text
# existed. The Techvein-only list (ai.mail.organisations) hides that switch;
# it does not reset it - on production, 30 Sept, it was still on. Adding them
# to the list by hand would have resumed Mail AI at once on the old consent.
# So offering and resetting are one action, audited as the operator
# (Mr. Singh, 30 Sept: console, not raw SQL; keep the "is the list still what
# I think it is" guard as the action's own check).
#
# ABC School stands in for organisation 5: Mail AI on, suggestions on,
# sorting on, and not on the list. Its principal is its administrator, so
# "their Mail AI page no longer says not available" is asked of the same
# API response the page renders (GET /api/org/ai, mailOffered).
#
# What is proved, against a running API on a database of its own (rule 13):
#   * before: the school's page says not available; its switch is still on
#   * refused, changing nothing: no expectedList (400), a stale list (409),
#     a non-operator (403)
#   * the offer: school on the list, appended after Techvein; its Mail AI
#     off, sorting off, Help me write on, suggestions and Summarise off; the
#     setting row names the operator
#   * one audit line in the SCHOOL's trail, naming the operator, saying
#     onList false -> true, and NOT carrying the list (other organisations' ids)
#   * after: the page offers Mail AI (no "not available"), Mail AI is off, and
#     Mail itself reports AI unavailable until the administrator agrees again
#   * offering twice, or when the list is "all", is refused
#
# Build first: dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_MAILAIOFFER_TEST_PORT:-5097}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
ZERO="00000000-0000-0000-0000-000000000000"

SCRATCH="$ROOT/.tmp/mail-ai-offer-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

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
# jsonb prints "key": value, with the space.
# Empty operands are refused, never compared ([ "" = "" ] is a false green).
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
hasnt() {
    if [ -z "$3" ]; then fail "$1 — nothing to look for"
    elif [ -z "$2" ]; then fail "$1 — nothing to look in"
    elif printf "%s" "$2" | grep -qF -- "$3"; then fail "$1 — FOUND in: $(brief "$2")"
    else pass "$1"; fi
}

API_PID=""
stop_api() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
        fi
        kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
    fi
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
# Set BEFORE tdb_create, which chains it after dropping the database.
trap stop_api EXIT

# House rule 13: this run's own database, every migration applied twice.
source "$ROOT/tests/lib/throwaway-db.sh"
tdb_create mailaioffer || { echo "  the throwaway database could not be made - the check did NOT run"; exit 2; }
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

call() {   # METHOD PATH TOKEN [JSON]
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3"
    fi
}
signin() {
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$1'" >/dev/null
    local code
    code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d "{\"phone\":\"$1\"}" | j "d.get('devCode') or ''")
    curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"$1\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''"
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="$TDB_CONN"
export Smtp__Host=localhost Smtp__Port=5870
# AI configured (nothing is ever sent: no request reaches the provider in
# this suite), so Mail's status answers from the SWITCHES. Unconfigured, it
# says "unavailable" whatever they are, and step 6 would prove nothing.
# An unknown host must name its vendor (PR 366), or AI stays unconfigured.
export Ai__Vendor=OpenAI Ai__BaseUrl=http://127.0.0.1:9/v1 Ai__ApiKey=test-only-not-a-key Ai__Model=test-model Ai__DataLocation="the United States"
export Personal__PhoneHashKey="test-only-phone-hash-key-at-least-32-characters"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

step "1. The API starts on $TDB_NAME; the operator and the school's administrator sign in"
PG "UPDATE core.users SET phone='+919999900001', role='super_admin' WHERE email='amit@techvein.local'" >/dev/null
# The seeded principal's role is not an administrator's; this run's own
# database, so make them the school's owner (OrgAdmin policy).
PG "UPDATE core.users SET phone='+919999900003', role='org_owner' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
OPERATOR=$(signin "+919999900001")
ADMIN=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as the operator" || { fail "operator sign-in failed"; exit 1; }
[ -n "$ADMIN" ] && pass "signed in as the school's administrator" || { fail "administrator sign-in failed"; exit 1; }

step "2. The school is organisation 5's shape: Mail AI on, behind the list"
PG "INSERT INTO core.platform_settings (key, value, is_secret, updated_at) VALUES ('ai.mail.organisations', '$TECHVEIN', false, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
PG "UPDATE core.tenants SET allow_ai=true, allow_mail_ai=true, mail_ai_rewrite=true, mail_ai_suggest=true, mail_ai_summary=true, mail_ai_triage_since=now() WHERE id='$SCHOOL'" >/dev/null
same "the list is Techvein only" "$(PG "SELECT value FROM core.platform_settings WHERE key='ai.mail.organisations'")" "$TECHVEIN"
r=$(call GET /api/org/ai "$ADMIN")
same "the school's Mail AI page answers" "$(status "$r")" "200"
same "  and says Mail AI is not offered" "$(jq_ "$(body "$r")" "d.get('mailOffered')")" "False"
has  "  with the not-available sentence" "$(jq_ "$(body "$r")" "d.get('mailNotOffered') or ''")" "not available for your organisation yet"
r=$(call GET "/api/admin/organisations/$SCHOOL/mail-ai" "$OPERATOR")
same "the console reads it" "$(status "$r")" "200"
same "  not on the list" "$(jq_ "$(body "$r")" "d['onList']")" "False"
same "  but its own Mail AI switch is ON (the trap)" "$(jq_ "$(body "$r")" "d['allowMailAi']")" "True"
same "  and the list it shows is the stored one" "$(jq_ "$(body "$r")" "d['list']")" "$TECHVEIN"
TV_BEFORE=$(PG "SELECT allow_mail_ai::text||','||mail_ai_suggest::text||','||(mail_ai_triage_since IS NULL)::text FROM core.tenants WHERE id='$TECHVEIN'")
T0=$(PG "SELECT now()")

# Mr. Singh, 30 Sept 2026: the button must refuse while the privacy text
# still has a blank. Until PR 366 there is no text, so this API refuses.
step "2b. Refused while the Mail AI privacy text is incomplete"
r=$(call GET "/api/admin/organisations/$SCHOOL/mail-ai" "$OPERATOR")
same "the console is told the text is incomplete" "$(jq_ "$(body "$r")" "d['privacyTextComplete']")" "False"
has  "  with the sentence it shows instead of the button" "$(jq_ "$(body "$r")" "d.get('privacyTextIncomplete') or ''")" "still has a blank"
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" "{\"expectedList\":\"$TECHVEIN\"}")
same "the offer is refused: 409" "$(status "$r")" "409"
has  "  saying why" "$(body "$r")" "still has a blank"
same "  list unchanged" "$(PG "SELECT value FROM core.platform_settings WHERE key='ai.mail.organisations'")" "$TECHVEIN"
same "  school's Mail AI untouched" "$(PG "SELECT allow_mail_ai FROM core.tenants WHERE id='$SCHOOL'")" "t"
same "  no audit line" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%org.ai.mail.offered' AND occurred_at > '$T0'")" "0"

# The rest proves the offer itself: the same API, restarted with the
# Development-only switch that treats the text as complete.
stop_one_api() {
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
    else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
    kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
}
stop_one_api
export MailAi__PrivacyTextCompleteForTests=1
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API restarted with the test switch" || { fail "API did not restart"; tail -5 "$LOG"; exit 1; }
has "  and its log says the text is treated as complete, for tests" "$(cat "$LOG")" "TREATED AS COMPLETE for tests"

step "3. Refused, and nothing changes"
unchanged() {
    same "  list unchanged" "$(PG "SELECT value FROM core.platform_settings WHERE key='ai.mail.organisations'")" "$TECHVEIN"
    same "  school's Mail AI still on" "$(PG "SELECT allow_mail_ai FROM core.tenants WHERE id='$SCHOOL'")" "t"
    same "  no audit line" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%org.ai.mail.offered' AND occurred_at > '$T0'")" "0"
}
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" '{}')
same "no expectedList: 400" "$(status "$r")" "400"; unchanged
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" '{"expectedList":""}')
same "a stale list (the page saw none, the store has Techvein): 409" "$(status "$r")" "409"
has  "  saying the list changed" "$(body "$r")" "has changed since this page loaded"; unchanged
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$ADMIN" "{\"expectedList\":\"$TECHVEIN\"}")
same "the school's own administrator: 403" "$(status "$r")" "403"; unchanged

step "4. The offer"
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" "{\"expectedList\":\"$TECHVEIN\"}")
same "offered: 200" "$(status "$r")" "200"
same "the list is Techvein, then the school" "$(PG "SELECT value FROM core.platform_settings WHERE key='ai.mail.organisations'")" "$TECHVEIN,$SCHOOL"
same "the setting row names the operator" "$(PG "SELECT updated_by FROM core.platform_settings WHERE key='ai.mail.organisations'")" "$OPERATOR_ID"
same "school: Mail AI off, sorting off, Help me write on, suggestions off, Summarise off" \
    "$(PG "SELECT allow_mail_ai::text||','||(mail_ai_triage_since IS NULL)::text||','||mail_ai_rewrite::text||','||mail_ai_suggest::text||','||mail_ai_summary::text FROM core.tenants WHERE id='$SCHOOL'")" \
    "false,true,true,false,false"
same "school: its organisation-wide AI consent is left as it was" "$(PG "SELECT allow_ai FROM core.tenants WHERE id='$SCHOOL'")" "t"
same "Techvein's own switches are untouched" "$(PG "SELECT allow_mail_ai::text||','||mail_ai_suggest::text||','||(mail_ai_triage_since IS NULL)::text FROM core.tenants WHERE id='$TECHVEIN'")" "$TV_BEFORE"

step "5. One audit line, in the school's trail, naming the operator"
same "exactly one line" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")" "1"
same "  in the school's trail" "$(PG "SELECT tenant_id FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")" "$SCHOOL"
same "  naming the operator (not 0000…)" "$(PG "SELECT actor_user_id FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")" "$OPERATOR_ID"
AFTER=$(PG "SELECT after_state FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")
BEFORE=$(PG "SELECT before_state FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")
has   "  before: not on the list, Mail AI on" "$BEFORE" '"onList": false'
has   "  before records the switch that was on" "$BEFORE" '"allowMailAi": true'
has   "  after: on the list" "$AFTER" '"onList": true'
has   "  after: Mail AI off" "$AFTER" '"allowMailAi": false'
hasnt "  the line does not carry the list (Techvein's id)" "$BEFORE$AFTER" "$TECHVEIN"

step "6. The school's page now offers Mail AI, and nothing is sent until they agree"
r=$(call GET /api/org/ai "$ADMIN")
same "the page says Mail AI is offered" "$(jq_ "$(body "$r")" "d.get('mailOffered')")" "True"
same "  with no not-available sentence" "$(jq_ "$(body "$r")" "d.get('mailNotOffered')")" "None"
same "  and Mail AI shown off" "$(jq_ "$(body "$r")" "d.get('mailEnabled')")" "False"
r=$(call GET /api/mail/ai/status "$ADMIN")
same "Mail reports AI unavailable to the school's people" "$(jq_ "$(body "$r")" "d.get('available')")" "False"
same "  because Mail AI is off (not because AI is unconfigured)" "$(jq_ "$(body "$r")" "d.get('reason')")" "mail"

step "7. Offering twice, or to everyone, is refused"
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" "{\"expectedList\":\"$TECHVEIN,$SCHOOL\"}")
same "already on the list: 409" "$(status "$r")" "409"
PG "UPDATE core.platform_settings SET value='all' WHERE key='ai.mail.organisations'" >/dev/null
PG "UPDATE core.tenants SET allow_mail_ai=true WHERE id='$SCHOOL'" >/dev/null
r=$(call POST "/api/admin/organisations/$SCHOOL/mail-ai/offer" "$OPERATOR" '{"expectedList":"all"}')
same "the list is \"all\": 409" "$(status "$r")" "409"
same "  and the school's switch was not reset by the refusal" "$(PG "SELECT allow_mail_ai FROM core.tenants WHERE id='$SCHOOL'")" "t"
same "  and still one audit line in all" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:org.ai.mail.offered' AND occurred_at > '$T0'")" "1"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (%s)\n\n" "$PASSED" "$TDB_NAME"; exit 0
else printf "  FAIL  %d of %d checks (%s)\n\n" "$FAILED" $((PASSED+FAILED)) "$TDB_NAME"; exit 1; fi
