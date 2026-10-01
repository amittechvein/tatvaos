#!/usr/bin/env bash
#
# An operator's action names the operator, and the address it came from
# (Mr. Singh, 29 Sept 2026).
#
# WHAT WAS WRONG. Every operator endpoint read the person's id from the "sub"
# claim, which the JWT handler has renamed by the time an endpoint looks. The
# answer was Guid.Empty, always, so every platform:... audit line (reads of a
# customer's mail IDs, plan changes, overrides, invoices) was written under
# an all-zero actor. And the address recorded was the connection's, which
# behind Caddy is Caddy's container for everyone.
#
# What is proved, against a running API:
#   * create, read, suspend, activate, keep-everything, billing cycle,
#     Connect caps: each writes a line naming THE OPERATOR, not 0000...
#   * no platform line written during the run names nobody
#   * the address is the LAST X-Forwarded-For entry (the one Caddy writes),
#     never the first (which the client chose), never the connection's
#   * no copy of the old lookup is left in apps/api
#
#   * a refused audit line undoes the change: suspend, keep-everything,
#     billing cycle and Connect caps each fail and change NOTHING (step 5,
#     throwaway database only)
#
# tests/audit-actor/gates asks the three decisions directly (dotnet run).
#
# Setup as tests/admin-org-detail. Build first: dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_AUDITACTOR_TEST_PORT:-5095}"
API="http://localhost:$PORT"
TECHVEIN="11111111-1111-1111-1111-111111111111"
SCHOOL="22222222-2222-2222-2222-222222222222"
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/audit-actor-$$"
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


# callx METHOD PATH TOKEN [JSON] - as a request arriving through Caddy from
# 203.0.113.7, sent by a client that ALSO claims to be 198.51.100.9.
callx() {
    if [ -n "${4:-}" ]; then
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "X-Forwarded-For: 198.51.100.9, 203.0.113.7" -H "Content-Type: application/json" -d "$4"
    else
        curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Authorization: Bearer $3" -H "X-Forwarded-For: 198.51.100.9, 203.0.113.7"
    fi
}

export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long"
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
# House rule 13: a run through tests/lib/throwaway-db.sh (PR 359) supplies
# its own database as TDB_CONN; the shared tatvaos_mail is only the fallback.
export ConnectionStrings__Postgres="${TDB_CONN:-Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true}"
export Smtp__Host=localhost Smtp__Port=5870
export Personal__PhoneHashKey="test-only-phone-hash-key-at-least-32-characters"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

NAME="Audit Actor $RUN"
FQDN="audit-actor-$RUN.test"
ZERO="00000000-0000-0000-0000-000000000000"
API_PID=""; PRINCIPAL_WAS=""; ORG=""
cleanup() {
    [ -n "$PRINCIPAL_WAS" ] && PG "UPDATE core.users SET role='$PRINCIPAL_WAS' WHERE email='principal@abcschool.local'" >/dev/null
    PG "DELETE FROM core.tenants WHERE name='$NAME'" >/dev/null
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

step "0. No copy of the old lookup is left"
LEFT=$(grep -rn 'FindFirst("sub")' "$ROOT/apps/api" --include=*.cs \
        | grep -v "Shared/Auth/SignedIn.cs" | grep -v "Shared/Tenancy/TenantMiddleware.cs" | grep -v "apps/api/Program.cs" || true)
if [ -z "$LEFT" ]; then pass "nothing in apps/api reads \"sub\" by itself"
else fail "these still read \"sub\" by itself, and will name nobody: $(printf "%s" "$LEFT" | cut -d: -f1,2 | tr "\n" " ")"; fi
# The three allowed files read NameIdentifier FIRST. Counted, so that one of
# them losing that line is seen.
same "the readers that remain ask for NameIdentifier first (3 files)" \
    "$(grep -ln 'ClaimTypes.NameIdentifier' "$ROOT/apps/api/Shared/Auth/SignedIn.cs" "$ROOT/apps/api/Shared/Tenancy/TenantMiddleware.cs" "$ROOT/apps/api/Program.cs" | wc -l | tr -d ' ')" "3"

step "1. The database answers; the API starts; the operator signs in (${TDB_NAME:-${TATVAOS_PG_HOST:-}})"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
[ -n "$(PG "SELECT 1")" ] || { fail "psql does not answer"; exit 1; }
PLAN=$(PG "SELECT id FROM core.plans ORDER BY name LIMIT 1")
OPERATOR_ID=$(PG "SELECT id FROM core.users WHERE email='principal@abcschool.local'")
[ -n "$PLAN" ] && [ -n "$OPERATOR_ID" ] && pass "seed data is here" || { fail "seed data missing"; exit 1; }
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }
# A fresh database (rule 13) has the seeded people without phone numbers;
# give the two this suite signs in as theirs, only where none is set.
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PRINCIPAL_WAS=$(PG "SELECT role FROM core.users WHERE email='principal@abcschool.local'")
PG "UPDATE core.users SET role='super_admin' WHERE email='principal@abcschool.local'" >/dev/null
OPERATOR=$(signin "+919999900003")
[ -n "$OPERATOR" ] && pass "signed in as the operator" || { fail "operator sign-in failed"; exit 1; }
T0=$(PG "SELECT now()")

# actor ACTION - who the newest line of that action, for this run's
# organisation, says did it. "(no line)" when there is none, so that a
# missing line cannot be read as anything else.
actor() { local v; v=$(PG "SELECT COALESCE(actor_user_id::text,'(null)') FROM core.audit_logs WHERE tenant_id='$ORG' AND action='$1' AND occurred_at > '$T0' ORDER BY occurred_at DESC LIMIT 1"); printf "%s" "${v:-(no line)}"; }
addr()  { local v; v=$(PG "SELECT COALESCE(actor_ip,'(null)') FROM core.audit_logs WHERE tenant_id='$ORG' AND action='$1' AND occurred_at > '$T0' ORDER BY occurred_at DESC LIMIT 1"); printf "%s" "${v:-(no line)}"; }

step "2. Each operator action names the operator"
r=$(callx POST "/api/admin/organisations" "$OPERATOR" "{\"name\":\"$NAME\",\"type\":\"business\",\"country\":\"IN\",\"adminName\":\"Test Admin\",\"adminEmail\":\"admin@$FQDN\",\"primaryDomain\":\"$FQDN\",\"planId\":\"$PLAN\",\"storageModel\":\"pooled\",\"maxUsers\":5,\"pooledStorageBytes\":1073741824}")
same "an organisation is created" "$(status "$r")" "201"
ORG=$(PG "SELECT id FROM core.tenants WHERE name='$NAME'")
[ -n "$ORG" ] || { fail "the organisation is not in the database"; exit 1; }
CREATED=$(PG "SELECT action FROM core.audit_logs WHERE tenant_id='$ORG' AND occurred_at > '$T0' ORDER BY occurred_at LIMIT 1")
same "creating it ($CREATED)" "$(actor "$CREATED")" "$OPERATOR_ID"

r=$(callx GET "/api/admin/organisations/$ORG/overview" "$OPERATOR"); same "reading its page answers 200" "$(status "$r")" "200"
same "reading its page (a read of a customer's details)" "$(actor "platform:organisation.detail_viewed")" "$OPERATOR_ID"
r=$(callx GET "/api/admin/organisations/$ORG/mailboxes" "$OPERATOR"); same "listing its mail IDs answers 200" "$(status "$r")" "200"
same "listing its mail IDs" "$(actor "platform:organisation.mail_ids_viewed")" "$OPERATOR_ID"
r=$(callx POST "/api/admin/organisations/$ORG/suspend" "$OPERATOR"); same "suspending answers 200" "$(status "$r")" "200"
same "suspending it" "$(actor "platform:organisation.suspended")" "$OPERATOR_ID"
r=$(callx POST "/api/admin/organisations/$ORG/activate" "$OPERATOR"); same "activating answers 200" "$(status "$r")" "200"
same "activating it" "$(actor "platform:organisation.activated")" "$OPERATOR_ID"
r=$(callx PUT "/api/admin/organisations/$ORG/keeps-everything" "$OPERATOR" "{\"keepsEverything\":true,\"reason\":\"audit-actor $RUN\"}")
same "keep-everything answers 2xx" "$(status "$r" | cut -c1)" "2"
same "changing keep-everything" "$(actor "platform:organisation.keeps_everything")" "$OPERATOR_ID"
r=$(callx PUT "/api/admin/organisations/$ORG/billing/cycle" "$OPERATOR" "{\"cycle\":\"yearly\"}")
same "billing cycle answers 2xx" "$(status "$r" | cut -c1)" "2"
same "changing the billing cycle" "$(actor "platform:billing.cycle_changed")" "$OPERATOR_ID"
r=$(callx PUT "/api/admin/organisations/$ORG/connect-invitation-caps" "$OPERATOR" "{\"perRequest\":50,\"perMeeting\":100}")
same "Connect invitation caps answers 2xx" "$(status "$r" | cut -c1)" "2"
same "changing Connect's invitation caps" "$(actor "platform:connect.settings.invitation_caps")" "$OPERATOR_ID"

step "3. Nothing written in this run names nobody"
LINES=$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE 'platform:%' AND occurred_at > '$T0'")
[ "${LINES:-0}" -ge 8 ] && pass "$LINES platform lines were written" || fail "only ${LINES:-0} platform lines were written, so 'none names nobody' would prove little"
same "platform lines with an all-zero or missing actor" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE 'platform:%' AND occurred_at > '$T0' AND (actor_user_id IS NULL OR actor_user_id='$ZERO')")0" "00"
same "every one of them names the operator" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE 'platform:%' AND occurred_at > '$T0' AND actor_user_id='$OPERATOR_ID'")" "$LINES"

step "4. The address is the one Caddy wrote"
same "suspending: the LAST forwarded entry" "$(addr "platform:organisation.suspended")" "203.0.113.7"
same "reading its page: the same" "$(addr "platform:organisation.detail_viewed")" "203.0.113.7"
same "no line carries the address the client claimed" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE occurred_at > '$T0' AND actor_ip='198.51.100.9'")0" "00"
same "no platform line carries the connection's own address" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE 'platform:%' AND occurred_at > '$T0' AND actor_ip IN ('::1','127.0.0.1','::ffff:127.0.0.1')")0" "00"


step "5. A refused audit line undoes the change (Mr. Singh, 30 Sept)"
# The database is made to refuse every audit line for this run's
# organisation. Each operator change below must then fail AND leave nothing
# changed: the change and its line commit together or not at all. A trigger
# is added for this, so the step runs only on a database of its own.
if [ -z "${TDB_NAME:-}" ]; then
    fail "step 5 adds a trigger and runs only on a throwaway database (tests/lib/throwaway-db.sh): NOT run"
else
    grep -q "operator write route(s) covered, 0 uncovered" "$LOG" \
        && pass "start-up: every operator write route carries the transaction" \
        || fail "start-up did not report 0 uncovered routes: $(grep -m1 'Operator write transaction' "$LOG" | cut -c1-200)"
    status_was=$(PG "SELECT status FROM core.tenants WHERE id='$ORG'")
    keeps_was=$(PG "SELECT keeps_everything FROM core.tenants WHERE id='$ORG'")
    cycle_was=$(PG "SELECT billing_cycle FROM core.subscriptions WHERE tenant_id='$ORG' ORDER BY started_at DESC LIMIT 1")
    caps_was=$(PG "SELECT invite_max_per_request||'/'||invite_max_per_meeting FROM connect.tenant_settings WHERE tenant_id='$ORG'")
    same "before: active, keeps everything, yearly, caps 50/100" "$status_was/$keeps_was/$cycle_was/$caps_was" "active/t/yearly/50/100"
    PG "CREATE OR REPLACE FUNCTION public.zz_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION 'test: audit refused'; END \$\$" >/dev/null
    PG "CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON core.audit_logs FOR EACH ROW WHEN (NEW.tenant_id = '$ORG') EXECUTE FUNCTION public.zz_refuse_audit()" >/dev/null
    same "the refusing trigger is in place" "$(PG "SELECT count(*) FROM pg_trigger WHERE tgname='zz_refuse_audit'")" "1"

    r=$(callx POST "/api/admin/organisations/$ORG/suspend" "$OPERATOR")
    same "suspend, line refused: the request fails (500)" "$(status "$r")" "500"
    same "…and the organisation is NOT suspended" "$(PG "SELECT status FROM core.tenants WHERE id='$ORG'")" "$status_was"
    r=$(callx PUT "/api/admin/organisations/$ORG/keeps-everything" "$OPERATOR" "{\"keepsEverything\":false,\"reason\":\"audit-actor $RUN\"}")
    same "keep-everything off, line refused: fails (500)" "$(status "$r")" "500"
    same "…and it still keeps everything" "$(PG "SELECT keeps_everything FROM core.tenants WHERE id='$ORG'")" "$keeps_was"
    r=$(callx PUT "/api/admin/organisations/$ORG/billing/cycle" "$OPERATOR" "{\"cycle\":\"monthly\"}")
    same "billing cycle to monthly, line refused: fails (500)" "$(status "$r")" "500"
    same "…and it is still yearly" "$(PG "SELECT billing_cycle FROM core.subscriptions WHERE tenant_id='$ORG' ORDER BY started_at DESC LIMIT 1")" "$cycle_was"
    r=$(callx PUT "/api/admin/organisations/$ORG/connect-invitation-caps" "$OPERATOR" "{\"perRequest\":70,\"perMeeting\":140}")
    same "Connect caps to 70/140, line refused: fails (500)" "$(status "$r")" "500"
    same "…and they are still 50/100" "$(PG "SELECT invite_max_per_request||'/'||invite_max_per_meeting FROM connect.tenant_settings WHERE tenant_id='$ORG'")" "$caps_was"

    # The calibration: with the trigger gone the same request goes through,
    # so the "nothing changed" above was the refusal, not a broken request.
    PG "DROP TRIGGER zz_refuse_audit ON core.audit_logs" >/dev/null
    r=$(callx POST "/api/admin/organisations/$ORG/suspend" "$OPERATOR")
    same "trigger gone: the same suspend succeeds" "$(status "$r")" "200"
    same "…and the organisation is suspended" "$(PG "SELECT status FROM core.tenants WHERE id='$ORG'")" "suspended"
fi

printf "\n  ═════════════════════════════════════════════\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
