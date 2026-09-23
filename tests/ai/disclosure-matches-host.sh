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
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 7200 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-$(wsl hostname -I | tr -d ' \r\n')}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
        TATVAOS_PG_HOST="${TATVAOS_PG_HOST:-localhost}"
    fi
fi
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }

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
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
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
cleanup() { stop_api; [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

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

run_case "1. OpenAI host, location says the United States: accepted, and the screen names the place" \
    "https://api.openai.com/v1" "the United States" true \
    "on a third-party service in the United States."

run_case "2. OpenAI host, location claims India: refused — the screen would lie" \
    "https://api.openai.com/v1" "India" false \
    "TatvaOS AI is not configured" "Refused: the consent screen would name the wrong place"

run_case "3. A key with no location at all: refused — the screen could not say where" \
    "https://api.openai.com/v1" "" false \
    "TatvaOS AI is not configured" "Ai:DataLocation is not set"

run_case "4. An unknown host with a stated location: accepted on trust, and the screen prints it" \
    "https://example-resource.openai.azure.com/v1" "India (Azure, Central India)" true \
    "on a third-party service in India (Azure, Central India)."

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
