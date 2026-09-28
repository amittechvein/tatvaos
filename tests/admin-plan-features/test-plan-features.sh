#!/usr/bin/env bash
#
# TatvaOS — features inside modules, plans built from them, per-client
# exceptions, and the warnings (Amit, 26 Sept 2026). His rulings, each tested:
#
#   * existing customers KEEP EVERYTHING — set once by the migration, and a
#     customer who arrives later is not handed it by the next deploy's re-run
#   * at a limit, WARN FIRST — the warnings appear, nothing is stopped
#
# Plus what makes it safe to hand an operator: the owner has no route to any
# of it, exceptions need a reason, expiry is read in the query (no sweeper), a
# hold beats "keeps everything", and nothing crosses between organisations.
#
# Setup as tests/admin-org-detail: WSL Postgres, the Release API, OTP sign-in
# with the dev code, the school's principal made operator for the run. The run
# moves Techvein onto a throwaway plan and puts everything back on exit.
#
# Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_PLANFEAT_TEST_PORT:-5089}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/plan-features-$$"
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
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
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
# feat BODY CODE FIELD -> that feature's field from a /plan answer
feat() { jq_ "$1" "[f for f in d['entitlements']['features'] if f['code']=='$2'][0]['$3']"; }
# warned BODY CODE LEVEL -> 1 if that warning is present, else 0
warned() { jq_ "$1" "1 if any(w['code']=='$2' and w['level']=='$3' for w in d['warnings']) else 0"; }

TAG="planfeat-$RUN"
# Plan names get their own marker: the organisation is shown its plan's name,
# and step 11 must be able to tell a leaked REASON from that.
PTAG="plan-$RUN"
API_PID=""; PRINCIPAL_WAS=""; SUB_PLAN_WAS=""; TESTPLAN=""; STRAY=""
cleanup() {
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    [ -n "$SUB_PLAN_WAS" ] && PG "UPDATE core.subscriptions SET plan_id='$SUB_PLAN_WAS' WHERE tenant_id='$TECHVEIN'" >/dev/null
    PG "UPDATE core.tenants SET keeps_everything=true WHERE id IN ('$TECHVEIN','$SCHOOL')" >/dev/null
    PG "DELETE FROM core.feature_overrides WHERE reason LIKE '%$TAG%'" >/dev/null
    PG "DELETE FROM core.platform_settings WHERE key='plans.warn_clients'" >/dev/null
    [ -n "$TESTPLAN" ] && PG "DELETE FROM core.plans WHERE id='$TESTPLAN'" >/dev/null
    PG "DELETE FROM core.plans WHERE name LIKE '%$PTAG%'" >/dev/null
    [ -n "$STRAY" ] && PG "DELETE FROM core.tenants WHERE id='$STRAY'" >/dev/null
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

step "0. The migration re-runs clean, and 'keeps everything' is set ONCE"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
# The three test phones, made true every run (tests/support/test-phones.sh).
. "$(dirname "$0")/../support/test-phones.sh"
[ "$(PG "$TEST_PHONES_SQL")" = "3" ] || { fail "the test phone numbers could not be set - see tests/support/test-phones.sh"; exit 1; }
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
MIG="$ROOT/local/postgres/init/20260926-plan-features.sql"
base="${TATVAOS_PSQL% -Atc}"
out=$($base -v ON_ERROR_STOP=1 -q < "$MIG" 2>&1 | grep -v "^wsl:" | grep -E "ERROR" )
[ -z "$out" ] && pass "a re-run reports no error" || fail "the re-run said: $(brief "$out")"
same "12 features in the catalogue" "$(PG "SELECT count(*) FROM core.features")" "12"
# A customer who arrives AFTER the migration must not be handed everything by
# the next deploy's re-run. Make one, re-run, look.
STRAY=$(PG "SELECT gen_random_uuid()")
PG "INSERT INTO core.tenants (id, name) VALUES ('$STRAY', 'Stray $TAG')" >/dev/null
same "a new organisation starts without 'keeps everything'" "$(PG "SELECT keeps_everything FROM core.tenants WHERE id='$STRAY'")" "f"
$base -v ON_ERROR_STOP=1 -q < "$MIG" >/dev/null 2>&1
same "…and the next deploy's re-run leaves it that way" "$(PG "SELECT keeps_everything FROM core.tenants WHERE id='$STRAY'")" "f"
PG "DELETE FROM core.tenants WHERE id='$STRAY'" >/dev/null; STRAY=""

step "1. Start the API and sign two people in"
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
OWNER=$(signin "+919999900001")
[ -n "$OWNER" ] && pass "signed in as the Techvein owner" || { fail "owner sign-in failed"; exit 1; }
PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as an operator from the SCHOOL" || { fail "operator sign-in failed"; exit 1; }
T0=$(PG "SELECT now()")
PLAN="/api/admin/organisations/$TECHVEIN/plan"
OVR="/api/admin/organisations/$TECHVEIN/feature-overrides"

step "2. The organisation's owner has no route to any of it"
r=$(callm GET "$PLAN" "$OWNER");                          same "reading its plan" "$(status "$r")" "403"
r=$(callm POST "$OVR" "$OWNER" '{"featureCode":"mail.ai","mode":"grant","reason":"x"}')
same "granting itself Mail AI" "$(status "$r")" "403"
r=$(callm PUT "/api/admin/organisations/$TECHVEIN/keeps-everything" "$OWNER" '{"keepsEverything":true,"reason":"x"}')
same "declaring it keeps everything" "$(status "$r")" "403"
r=$(callm GET "/api/admin/plan-warnings" "$OWNER");      same "the warning list" "$(status "$r")" "403"
r=$(curl -s -w "\n%{http_code}" "$API$PLAN");            same "nobody at all" "$(status "$r")" "401"
same "…and nothing was written" "$(PG "SELECT count(*) FROM core.feature_overrides WHERE tenant_id='$TECHVEIN'")" "0"

step "3. A plan built from features, and nonsense refused"
r=$(callm POST "/api/admin/plans" "$OPERATOR" "{\"name\":\"Bad $PTAG\",\"storageModel\":\"per_user\",\"perUserQuotaBytes\":1073741824,\"includedFeatures\":[\"mail.nope\"]}")
same "an unknown feature code" "$(status "$r")" "400"
r=$(callm POST "/api/admin/plans" "$OPERATOR" "{\"name\":\"Bad $PTAG\",\"storageModel\":\"per_user\",\"perUserQuotaBytes\":1073741824,\"featureLimits\":{\"mail.ai\":3}}")
same "a number on a switch" "$(status "$r")" "400"
same "…neither made a plan" "$(PG "SELECT count(*) FROM core.plans WHERE name='Bad $PTAG'")" "0"
r=$(callm POST "/api/admin/plans" "$OPERATOR" "{\"name\":\"Lite $PTAG\",\"storageModel\":\"per_user\",\"perUserQuotaBytes\":1073741824,\"includedProducts\":[\"mail\"],\"includedFeatures\":[\"mail.aliases\"],\"featureLimits\":{\"mail.shared_mailboxes.max\":0}}")
same "a plan with Mail + aliases only, 0 shared mailboxes" "$(status "$r")" "201"
TESTPLAN=$(jq_ "$(body "$r")" "d['id']")
same "…its feature list is stored" "$(PG "SELECT array_to_string(included_features, ',') FROM core.plans WHERE id='$TESTPLAN'")" "mail.aliases"
same "…and its one limit" "$(PG "SELECT count(*) FROM core.plan_feature_limits WHERE plan_id='$TESTPLAN'")" "1"
r=$(callm GET "/api/admin/plans" "$OPERATOR")
same "the plan list carries the limit back" \
    "$(jq_ "$(body "$r")" "[p for p in d if p['id']=='$TESTPLAN'][0]['featureLimits']['mail.shared_mailboxes.max']")" "0"

SUB_PLAN_WAS=$(PG "SELECT plan_id FROM core.subscriptions WHERE tenant_id='$TECHVEIN' ORDER BY started_at DESC LIMIT 1")
r=$(callm PUT "/api/admin/organisations/$TECHVEIN/plan" "$OPERATOR" "{\"planId\":\"$TESTPLAN\"}")
same "Techvein moved onto it" "$(status "$r")" "200"

step "4. An existing customer keeps everything, and gets no warnings"
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "answers 200" "$(status "$r")" "200"
same "Techvein keeps everything (set by the migration)" "$(jq_ "$B" "d['entitlements']['keepsEverything']")" "True"
same "…so Connect recording is included though the plan has no Connect" "$(feat "$B" connect.recording included)" "True"
same "…and no warnings" "$(jq_ "$B" "len(d['warnings'])")" "0"

r=$(callm PUT "/api/admin/organisations/$TECHVEIN/keeps-everything" "$OPERATOR" '{"keepsEverything":false,"reason":""}')
same "clearing it with no reason is refused" "$(status "$r")" "400"
r=$(callm PUT "/api/admin/organisations/$TECHVEIN/keeps-everything" "$OPERATOR" "{\"keepsEverything\":false,\"reason\":\"test $TAG\"}")
same "clearing it with a reason" "$(status "$r")" "200"

step "5. On the plan: what is included, and the warnings — nothing stopped"
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "aliases: included, from the plan" "$(feat "$B" mail.aliases included)/$(feat "$B" mail.aliases source)" "True/plan"
same "Mail AI: not in plan" "$(feat "$B" mail.ai included)/$(feat "$B" mail.ai source)" "False/not in plan"
same "Connect recording: its module is not in the plan" "$(feat "$B" connect.recording source)" "module not in plan"
same "shared mailboxes allowed: 0, from the plan" "$(feat "$B" mail.shared_mailboxes.max limit)" "0"
same "Techvein HAS a shared mailbox, so: not in plan" "$(warned "$B" mail.shared_mailboxes not_in_plan)" "1"
same "…and over the 0 allowed" "$(warned "$B" mail.shared_mailboxes.max over)" "1"
same "guests are on by default and Connect is not in the plan: warned" "$(warned "$B" connect.guests not_in_plan)" "1"
same "aliases are in the plan: not warned" "$(warned "$B" mail.aliases not_in_plan)" "0"
# Warn first, measured: the thing the plan leaves out still works.
r=$(callm GET "/api/org/mailboxes" "$OWNER")
same "the owner can still list shared mailboxes (nothing was stopped)" "$(status "$r")" "200"

step "6. Exceptions: nonsense refused, nothing stored"
for bad in '{"featureCode":"mail.ai","mode":"grant","reason":""}' \
           '{"featureCode":"mail.ai","mode":"limit","limitValue":3,"reason":"r"}' \
           '{"featureCode":"mail.shared_mailboxes.max","mode":"grant","reason":"r"}' \
           '{"featureCode":"mail.shared_mailboxes.max","mode":"limit","limitValue":-1,"reason":"r"}' \
           '{"featureCode":"mail.nope","mode":"grant","reason":"r"}' \
           '{"featureCode":"mail.ai","mode":"grant","reason":"r","expiresAt":"2020-01-01T00:00:00Z"}'; do
    r=$(callm POST "$OVR" "$OPERATOR" "$bad"); same "refused: $bad" "$(status "$r")" "400"
done
same "…nothing stored" "$(PG "SELECT count(*) FROM core.feature_overrides WHERE tenant_id='$TECHVEIN'")" "0"

step "7. Grant, limit, hold — each changes the answer"
r=$(callm POST "$OVR" "$OPERATOR" "{\"featureCode\":\"mail.shared_mailboxes\",\"mode\":\"grant\",\"reason\":\"trial $TAG\"}")
same "grant shared mailboxes" "$(status "$r")" "200"; GRANT=$(jq_ "$(body "$r")" "d['id']")
r=$(callm POST "$OVR" "$OPERATOR" "{\"featureCode\":\"mail.shared_mailboxes.max\",\"mode\":\"limit\",\"limitValue\":5,\"reason\":\"trial $TAG\"}")
same "allow 5 of them" "$(status "$r")" "200"
r=$(callm POST "$OVR" "$OPERATOR" "{\"featureCode\":\"mail.aliases\",\"mode\":\"revoke\",\"reason\":\"hold $TAG\"}")
same "hold aliases" "$(status "$r")" "200"; HOLD=$(jq_ "$(body "$r")" "d['id']")
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "shared mailboxes now included, by the grant" "$(feat "$B" mail.shared_mailboxes included)/$(feat "$B" mail.shared_mailboxes source)" "True/override: granted"
same "…so that warning is gone" "$(warned "$B" mail.shared_mailboxes not_in_plan)" "0"
same "the limit is 5, from the exception" "$(feat "$B" mail.shared_mailboxes.max limit)/$(feat "$B" mail.shared_mailboxes.max source)" "5/override"
same "…so 'over' is gone" "$(warned "$B" mail.shared_mailboxes.max over)" "0"
same "aliases held, though the plan includes them" "$(feat "$B" mail.aliases included)/$(feat "$B" mail.aliases source)" "False/override: held"
same "…and Techvein still has aliases, so that is warned" "$(warned "$B" mail.aliases not_in_plan)" "1"

r=$(callm POST "$OVR" "$OPERATOR" "{\"featureCode\":\"mail.aliases\",\"mode\":\"grant\",\"reason\":\"second $TAG\"}")
same "a second exception on the same feature replaces the first" "$(status "$r")" "200"
same "…one live row for aliases, the hold kept as withdrawn" \
    "$(PG "SELECT count(*) FILTER (WHERE withdrawn_at IS NULL)||'/'||count(*) FROM core.feature_overrides WHERE tenant_id='$TECHVEIN' AND feature_code='mail.aliases'")" "1/2"

step "8. Expiry is read in the query, and withdrawal restores the plan"
PG "UPDATE core.feature_overrides SET expires_at = now() - interval '1 minute' WHERE id='$GRANT'" >/dev/null
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "an expired grant no longer counts (no sweeper ran)" "$(feat "$B" mail.shared_mailboxes included)" "False"
same "…and the warning is back" "$(warned "$B" mail.shared_mailboxes not_in_plan)" "1"
LIVE_ALIAS=$(PG "SELECT id FROM core.feature_overrides WHERE tenant_id='$TECHVEIN' AND feature_code='mail.aliases' AND withdrawn_at IS NULL")
r=$(callm POST "$OVR/$LIVE_ALIAS/withdraw" "$OPERATOR")
same "withdraw the aliases grant" "$(status "$r")" "200"
r=$(callm POST "$OVR/$LIVE_ALIAS/withdraw" "$OPERATOR")
same "…withdrawing twice is a 404, not a second write" "$(status "$r")" "404"
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "aliases back to the plan's answer" "$(feat "$B" mail.aliases source)" "plan"

step "9. A hold beats 'keeps everything'"
r=$(callm POST "$OVR" "$OPERATOR" "{\"featureCode\":\"mail.ai\",\"mode\":\"revoke\",\"reason\":\"hold $TAG\"}")
same "hold Mail AI" "$(status "$r")" "200"
r=$(callm PUT "/api/admin/organisations/$TECHVEIN/keeps-everything" "$OPERATOR" "{\"keepsEverything\":true,\"reason\":\"back $TAG\"}")
same "Techvein keeps everything again" "$(status "$r")" "200"
r=$(callm GET "$PLAN" "$OPERATOR"); B=$(body "$r")
same "Connect recording included again" "$(feat "$B" connect.recording included)" "True"
same "…but Mail AI is still held" "$(feat "$B" mail.ai included)/$(feat "$B" mail.ai source)" "False/override: held"
PG "UPDATE core.tenants SET keeps_everything=false WHERE id='$TECHVEIN'" >/dev/null

step "10. Nothing crosses to the other organisation"
r=$(callm GET "/api/admin/organisations/$SCHOOL/plan" "$OPERATOR"); SB=$(body "$r")
same "the school's page answers 200" "$(status "$r")" "200"
same "…lists none of Techvein's exceptions" "$(jq_ "$SB" "len(d['overrides'])")" "0"
same "…and Mail AI is not held there" "$(feat "$SB" mail.ai source)" "keeps everything"
r=$(callm POST "/api/admin/organisations/$SCHOOL/feature-overrides/$HOLD/withdraw" "$OPERATOR")
same "withdrawing Techvein's row through the SCHOOL's address is a 404" "$(status "$r")" "404"
r=$(callm GET "/api/admin/plan-warnings" "$OPERATOR"); WB=$(body "$r")
same "the warning list has Techvein" "$(jq_ "$WB" "1 if any(o['id']=='$TECHVEIN' for o in d['organisations']) else 0")" "1"
same "…and not the school, which keeps everything" "$(jq_ "$WB" "1 if any(o['id']=='$SCHOOL' for o in d['organisations']) else 0")" "0"

step "11. The organisation sees warnings only when the operator says so"
r=$(callm GET "/api/org/plan-warnings" "$OWNER"); OB=$(body "$r")
same "off by default: enabled false" "$(jq_ "$OB" "d['enabled']")" "False"
same "…and an empty list" "$(jq_ "$OB" "len(d['warnings'])")" "0"
PG "INSERT INTO core.platform_settings (key, value) VALUES ('plans.warn_clients','true') ON CONFLICT (key) DO UPDATE SET value='true'" >/dev/null
r=$(callm GET "/api/org/plan-warnings" "$OWNER"); OB=$(body "$r")
same "switched on: enabled" "$(jq_ "$OB" "d['enabled']")" "True"
same "…with Techvein's own warnings (shared mailboxes)" \
    "$(jq_ "$OB" "1 if any(w['code']=='mail.shared_mailboxes' for w in d['warnings']) else 0")" "1"
hasnt "…and never the operator's reasons" "$OB" "$TAG"

step "12. It is all written down"
same "exceptions audited under Techvein, as platform: acts (5 made)" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.feature_override.created' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")" "5"
same "the one withdrawal" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.feature_override.withdrawn' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")" "1"
same "both 'keeps everything' changes (the refused one wrote nothing)" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='platform:organisation.keeps_everything' AND tenant_id='$TECHVEIN' AND occurred_at > '$T0'")" "2"

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
