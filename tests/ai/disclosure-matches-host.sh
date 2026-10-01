#!/usr/bin/env bash
# ============================================================================
#  TatvaOS AI — the consent disclosure cannot disagree with the provider
# ============================================================================
#
#  The consent screen prints where an organisation's content goes. That place
#  comes from Ai:DataLocation, and the gateway refuses to be configured when
#  the setting is missing or contradicts a host it recognises. This proves
#  both refusals and the one acceptance, by starting the API three times and
#  reading /api/org/ai as an organisation owner.
#
#  Modelled on tests/oidc/stage3-flow.sh: same launch, same OTP sign-in, same
#  WSL Postgres. Needs dotnet, a built Release API, python, and psql reachable.
#
#  What would make this test wrong: a green on an empty body. Every check
#  asserts the field it is about, and the accepting run asserts the exact
#  phrase the screen will print.
#
#  30 Sept 2026: the screen names the VENDOR as well as the place ("sent to
#  OpenAI, in the United States"), guarded the same way (Mr. Singh): a known
#  host names its own vendor and refuses a contradicting Ai:Vendor; an unknown
#  host must state one. Cases 5 and 6 are those refusals. And the run now has
#  a database of its own (house rule 13).
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_AI_TEST_PORT:-5079}"
API="http://localhost:$PORT"
SCRATCH="$ROOT/.tmp/ai-disclosure-$$"
mkdir -p "$SCRATCH"
LOG="$SCRATCH/api.log"
PY="${PYTHON:-python}"

WSL_KEEPALIVE=""
# House rule 13: this run's own database (every migration applied twice).
source "$ROOT/tests/lib/throwaway-db.sh"
tdb_create aidisclosure || { echo "  the throwaway database could not be made - the check did NOT run"; exit 2; }
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | tail -n1; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="$TDB_CONN"
export Smtp__Host=localhost Smtp__Port=5870
# A key that is never used: the gateway is only ever asked whether it is
# configured. No call leaves this machine.
export Ai__ApiKey='test-key-never-sent' Ai__Model='test-model'

API_PID=""
start_api() {
    dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
    API_PID=$!
    for _ in $(seq 1 150); do
        curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && return 0
        sleep 1
    done
    fail "the API did not answer on $API within 150s — tail of its log:"; tail -5 "$LOG"; return 1
}
stop_api() {
    [ -n "$API_PID" ] || return 0
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
    else
        fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    fi
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
}
cleanup() { stop_api; rm -rf "$SCRATCH"; tdb_drop; }
trap cleanup EXIT
# The seeded owner has no phone on a fresh database; give them the test one.
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null

PHONE='+919999900001'   # the seeded org owner (amit@techvein.local)

org_ai() {
    # Returns the /api/org/ai body as the org owner, or empty on any failure.
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$PHONE'" >/dev/null
    local r code token
    r=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}")
    code=$(jq_ "$r" "d.get('devCode') or ''")
    [ -n "$code" ] || { fail "no devCode for $PHONE: $r"; return 1; }
    r=$(curl -s -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\",\"code\":\"$code\"}")
    token=$(jq_ "$r" "d.get('accessToken') or ''")
    [ -n "$token" ] || { fail "verify failed for $PHONE"; return 1; }
    curl -s "$API/api/org/ai" -H "Authorization: Bearer $token"
}

# One run of the API under a (BaseUrl, DataLocation) pair. $3 is what
# platformConfigured must be; $4, when given, a phrase the disclosure must
# contain; $5, when given, a phrase the API log must contain (the refusal).
run_case() {
    local name=$1 base=$2 loc=$3 want_cfg=$4 want_phrase=${5:-} want_log=${6:-}
    step "$name"
    export Ai__BaseUrl="$base"
    if [ -n "$loc" ]; then export Ai__DataLocation="$loc"; else unset Ai__DataLocation; fi
    # VENDOR, when set by the caller for this case only.
    if [ -n "${CASE_VENDOR:-}" ]; then export Ai__Vendor="$CASE_VENDOR"; else unset Ai__Vendor; fi
    start_api || return 1
    local body cfg disc
    body=$(org_ai) || { stop_api; return 1; }
    cfg=$(jq_ "$body" "str(d.get('platformConfigured')).lower()")
    disc=$(jq_ "$body" "d.get('disclosure') or ''")
    if [ "$cfg" = "$want_cfg" ]; then pass "platformConfigured is $cfg"; else fail "platformConfigured is '$cfg', expected $want_cfg — body: $(printf '%s' "$body" | head -c 200)"; fi
    if [ -n "$want_phrase" ]; then
        if printf '%s' "$disc" | grep -qF -- "$want_phrase"; then pass "disclosure says \"$want_phrase\""; else fail "disclosure lacks \"$want_phrase\": $disc"; fi
    fi
    if [ -n "$want_log" ]; then
        if grep -qF -- "$want_log" "$LOG"; then pass "the API log says why: \"$want_log\""; else fail "the API log does not contain \"$want_log\""; fi
    fi
    stop_api
}

step "0. Postgres answers"
for _ in $(seq 1 30); do [ -n "$(PG 'SELECT 1')" ] && break; sleep 1; done
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer ($TATVAOS_PSQL)"; exit 1; }
pass "psql answers"

run_case "1. OpenAI host, location says the United States, no Ai:Vendor: accepted, and the screen names OpenAI and the place" \
    "https://api.openai.com/v1" "the United States" true \
    "are sent to OpenAI, in the United States, to write meeting notes."

run_case "2. OpenAI host, location claims India: refused — the screen would lie" \
    "https://api.openai.com/v1" "India" false \
    "TatvaOS AI is not configured" "Refused: the consent screen would name the wrong place"

run_case "3. A key with no location at all: refused — the screen could not say where" \
    "https://api.openai.com/v1" "" false \
    "TatvaOS AI is not configured" "Ai:DataLocation is not set"

CASE_VENDOR="Microsoft (Azure OpenAI)" run_case "4. An unknown host with a stated vendor and location: accepted on trust, and the screen prints both" \
    "https://example-resource.openai.azure.com/v1" "India (Azure, Central India)" true \
    "are sent to Microsoft (Azure OpenAI), in India (Azure, Central India), to write meeting notes."

CASE_VENDOR="Anthropic" run_case "5. OpenAI host, Ai:Vendor names another company: refused - the screen would name the wrong company" \
    "https://api.openai.com/v1" "the United States" false \
    "TatvaOS AI is not configured" "Refused: the consent screen would name the wrong company"

run_case "6. An unknown host with a location but no vendor: refused - the screen could not say who" \
    "https://example-resource.openai.azure.com/v1" "India (Azure, Central India)" false \
    "TatvaOS AI is not configured" "Refused: AI features are unavailable until the company the data goes to is stated"

# Every case must have RUN. On 30 Sept a case whose API could not start
# (the laptop out of memory: fork failed) printed nothing, and the run said
# "15 passed, 0 failed". 1 + 2+3+3+2+3+3 checks when all six run.
EXPECTED=17
if [ $((PASSED + FAILED)) -ne "$EXPECTED" ]; then
    fail "only $((PASSED + FAILED)) of $EXPECTED checks ran - a case did not run, so this proves nothing"
fi
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
