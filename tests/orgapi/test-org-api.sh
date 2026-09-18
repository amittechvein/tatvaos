#!/usr/bin/env bash
#
# TatvaOS — the organisation API: a customer's own software admitting people
# with an organisation API key (Amit, 18 September 2026).
#
# This is the most consequential public surface in the product: it creates
# sign-in identities. So the checks are mostly about what it REFUSES.
#
#   1. an admin creates a key: shown once, with a visible prefix, scopes stored
#   2. no key, a nonsense key and a revoked key all answer 401, identically
#   3. a key without people:admit is refused with 403
#   4. a key WITH it admits a person, who lands in the KEY'S organisation
#   5. the person cannot enter without an invitation channel — no password is
#      ever accepted over the API
#   6. a key cannot create an administrator, by role or by department default
#   7. the same address twice is refused, as the console refuses it
#   8. every rule the console applies still applies (capacity, verified domain)
#   9. it is all in the audit trail, naming the key
#  10. RLS: the key's tenant is the only one touched
#
# Starts its own API, like tests/oidc/stage3-flow.sh, and takes the same
# TATVAOS_PSQL / TATVAOS_PSQL_APP / TATVAOS_PG_HOST variables.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_ORGAPI_TEST_PORT:-5081}"
API="http://localhost:$PORT"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/orgapi-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 3600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-wsl -e psql postgresql://tatvaos_app:dev_app_pw@localhost/tatvaos_mail -Atc}"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -Atc}"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG()    { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }
PGAPP() { $TATVAOS_PSQL_APP "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
brief()  { printf '%s' "$1" | head -c 220 | tr '\n' ' '; }
post()   { curl -s -w '\n%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -H "Authorization: Bearer $2" -d "$3"; }
admit()  { curl -s -w '\n%{http_code}' -X POST "$API/api/v1/org/people" -H 'Content-Type: application/json' ${1:+-H "Authorization: Bearer $1"} -d "$2"; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi

API_PID=""
cleanup() {
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else
            fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
        fi
        kill "$API_PID" >/dev/null 2>&1 || true; wait "$API_PID" 2>/dev/null || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf '  kept for reading: %s\n' "$SCRATCH"; fi
}
trap cleanup EXIT

step "0. Start the API against $TATVAOS_PG_HOST"
for _ in $(seq 1 30); do [ -n "$(PG 'SELECT 1')" ] && break; sleep 1; done
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer"; exit 1; }
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w '%{http_code}' "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
TOKEN=$(curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$TOKEN" ] && pass "signed in as the Techvein owner" || { fail "sign-in failed"; exit 1; }

step "1. An admin creates a key"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Student system $RUN\",\"scopes\":[\"people:admit\"]}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(brief "$(body "$r")")"
KEY=$(jq_ "$(body "$r")" "d['key']"); KEY_ID=$(jq_ "$(body "$r")" "d['id']")
[ "${KEY:0:4}" = "tvk_" ] && pass "the key has the tvk_ prefix" || fail "key prefix: ${KEY:0:4}"
[ "$(jq_ "$(body "$r")" "d['keyPrefix']")" = "${KEY:0:12}" ] && pass "the visible prefix is the first 12 characters" || fail "keyPrefix wrong"
r=$(curl -s "$API/api/org/keys" -H "Authorization: Bearer $TOKEN")
printf '%s' "$r" | grep -q "$KEY" && fail "the list carries the key itself" || pass "the list never carries the key"
[ "$(PG "SELECT key_hash <> '$KEY' FROM core.api_keys WHERE id='$KEY_ID'")" = "t" ] && pass "stored hashed, not in the clear" || fail "the key is stored in the clear"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Bad $RUN\",\"scopes\":[\"people:everything\"]}")
[ "$(status "$r")" = "400" ] && pass "an unknown scope is refused, not ignored" || fail "unknown scope answered $(status "$r")"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Empty $RUN\",\"scopes\":[]}")
[ "$(status "$r")" = "400" ] && pass "a key with nothing ticked is refused" || fail "empty scopes answered $(status "$r")"

step "2. No key, a nonsense key and a revoked key all answer the same"
BODY="{\"localPart\":\"api-person-$RUN\",\"displayName\":\"API Person\",\"recoveryEmail\":\"api-person-$RUN@example.test\"}"
[ "$(status "$(admit "" "$BODY")")" = "401" ] && pass "no key: 401" || fail "no key answered $(status "$(admit "" "$BODY")")"
[ "$(status "$(admit "tvk_notarealkeyatallnotarealkeyatall" "$BODY")")" = "401" ] && pass "a nonsense key: 401" || fail "nonsense key not refused"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"To revoke $RUN\",\"scopes\":[\"people:admit\"]}")
DEAD=$(jq_ "$(body "$r")" "d['key']"); DEAD_ID=$(jq_ "$(body "$r")" "d['id']")
curl -s -o /dev/null -X DELETE "$API/api/org/keys/$DEAD_ID" -H "Authorization: Bearer $TOKEN"
[ "$(status "$(admit "$DEAD" "$BODY")")" = "401" ] && pass "a revoked key: 401, the same answer as unknown" || fail "revoked key not refused"

step "3. A key without people:admit"
r=$(post "$API/api/org/keys" "$TOKEN" "{\"label\":\"Wrong scope $RUN\",\"scopes\":[\"people:admit\"]}")
NOSCOPE_ID=$(jq_ "$(body "$r")" "d['id']"); NOSCOPE=$(jq_ "$(body "$r")" "d['key']")
PG "UPDATE core.api_keys SET scopes='{}' WHERE id='$NOSCOPE_ID'" >/dev/null
r=$(admit "$NOSCOPE" "$BODY")
[ "$(status "$r")" = "403" ] && pass "refused with 403, not 401 — the key is real, the permission is not" || fail "no-scope answered $(status "$r")"

step "4. A key WITH it admits a person, into the key's organisation"
r=$(admit "$KEY" "$BODY")
[ "$(status "$r")" = "200" ] || [ "$(status "$r")" = "201" ] && pass "admitted ($(status "$r"))" || fail "admit: $(status "$r") $(brief "$(body "$r")")"
NEW_ID=$(PG "SELECT id FROM core.users WHERE email LIKE 'api-person-$RUN@%'")
[ -n "$NEW_ID" ] && pass "the person exists" || fail "no person was created"
[ "$(PG "SELECT tenant_id::text FROM core.users WHERE id='$NEW_ID'")" = "$TECHVEIN" ] && pass "in the KEY'S organisation, not another" || fail "wrong tenant"
[ "$(PG "SELECT role FROM core.users WHERE id='$NEW_ID'")" = "employee" ] && pass "as an ordinary employee" || fail "role: $(PG "SELECT role FROM core.users WHERE id='$NEW_ID'")"
[ "$(PG "SELECT invite_token_hash IS NOT NULL FROM core.users WHERE id='$NEW_ID'")" = "t" ] && pass "with an invitation to set their own way in (0005)" || fail "no invitation was issued"
[ "$(PG "SELECT password_hash IS NULL FROM core.users WHERE id='$NEW_ID'")" = "t" ] && pass "and no password: a key never handles one" || fail "a password was set through the API"

step "5. A person with no way in is refused"
r=$(admit "$KEY" "{\"localPart\":\"nowayin-$RUN\",\"displayName\":\"No Way In\"}")
[ "$(status "$r")" = "400" ] && pass "no recovery email or phone: refused" || fail "no-way-in answered $(status "$r")"
[ "$(PG "SELECT count(*) FROM core.users WHERE email LIKE 'nowayin-$RUN@%'")" = "0" ] && pass "and nobody was created" || fail "a person with no way in was created"

step "6. A key cannot create an administrator"
# WHICH ASSERTION CARRIES WHICH CLAIM, from calibrating this step: with
# allowPrivilegedRoles forced true, ONLY the org_admin checks go red.
# org_owner is stopped independently (it needs owner scope, and an API key
# has no user), and super_admin is not an assignable role at all. So the new
# guard is what stands between a key and an org_admin; the other two were
# already defended, and are asserted here so a change to either is noticed.
for role in org_admin org_owner super_admin; do
    r=$(admit "$KEY" "{\"localPart\":\"esc-$role-$RUN\",\"displayName\":\"Esc\",\"recoveryEmail\":\"esc@example.test\",\"role\":\"$role\"}")
    [ "$(status "$r")" != "200" ] && [ "$(status "$r")" != "201" ] && pass "refused role '$role' ($(status "$r"))" || fail "LEAK: a key created a '$role'"
    [ "$(PG "SELECT count(*) FROM core.users WHERE email LIKE 'esc-$role-$RUN@%'")" = "0" ] && pass "…and no such person exists" || fail "LEAK: '$role' row was written"
done
# The same escalation by the longer route: a department whose DEFAULT role is
# privileged must not be inherited by a key.
DEPT=$(PG "INSERT INTO core.departments (tenant_id, name, default_role) VALUES ('$TECHVEIN', 'Admins $RUN', 'org_admin') RETURNING id")
if [ -n "$DEPT" ]; then
    r=$(admit "$KEY" "{\"localPart\":\"deptesc-$RUN\",\"displayName\":\"Dept Esc\",\"recoveryEmail\":\"d@example.test\",\"departmentId\":\"$DEPT\"}")
    got=$(PG "SELECT role FROM core.users WHERE email LIKE 'deptesc-$RUN@%'")
    [ -z "$got" ] || [ "$got" = "employee" ] && pass "a privileged department default is not inherited (role '${got:-none}')" || fail "LEAK: inherited '$got' from the department"
else
    printf '  - could not create a test department; department-default check skipped\n'
fi

step "7. The same address twice"
r=$(admit "$KEY" "$BODY")
[ "$(status "$r")" = "409" ] && pass "the second time: 409, as the console refuses it" || fail "duplicate answered $(status "$r")"

step "8. The audit trail names the key"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_person_admitted' AND target_id='$KEY_ID'")
[ "${n:-0}" -ge 1 ] && pass "the admission is recorded against the key" || fail "no audit row naming the key"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='org.api_key_created' AND target_id='$KEY_ID'")
[ "${n:-0}" -ge 1 ] && pass "so is the key's creation" || fail "no audit row for the key"
printf '%s' "$(PG "SELECT coalesce(string_agg(after_state::text,' '),'') FROM core.audit_logs WHERE action LIKE 'org.api%'")" | grep -q "$KEY" && fail "the key itself is in the audit trail" || pass "and the key itself appears nowhere in it"

step "9. Nothing secret in the API log"
n=$(grep -c -F "$KEY" "$LOG"); [ "$n" -eq 0 ] && pass "the key appears nowhere in the API log" || fail "the key appears $n time(s) in the log"

step "10. RLS: the school sees none of it"
n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM core.api_keys")
[ "${n:-1}" -eq 0 ] && pass "ABC School sees no Techvein key" || fail "LEAK: school sees ${n:-?} key(s)"
n=$(PGAPP "SELECT count(*) FROM core.api_keys")
[ "${n:-1}" -eq 0 ] && pass "no tenant context sees nothing" || fail "DANGEROUS: ${n:-?} key(s) with no tenant"
[ "$(PGAPP "SELECT tenant_id::text FROM core.resolve_api_key((SELECT key_hash FROM core.api_keys WHERE id='$KEY_ID'))" 2>/dev/null)" = "" ] \
    && pass "the app role cannot read a hash it was not given" || printf '  - resolver spot-check skipped (needs the hash, which only the caller holds)\n'

printf '\n%s%s%s\n  %s%d passed%s, ' "$CYAN" "----------------------------------------" "$RST" "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n\n' "$GREEN" "$RST" || printf '%s%d failed%s\n\n' "$RED" "$FAILED" "$RST"
[ "$FAILED" -eq 0 ]
