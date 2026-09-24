#!/usr/bin/env bash
#
# TatvaOS — the development-only operator sign-in (Mr. Singh, 24 Sept 2026).
#
# Runs the BUILT API six times, each in a different configuration, and asks
# the one question that matters in each: can a password-less platform-
# operator session be had here?
#
#   1  Production  + switch on   the API must refuse to start, for THAT reason
#   2  Staging     + switch on   the same
#   3  Production  + switch off  starts; the route does not exist
#   4  Development + switch off  starts; the route does not exist (CI's case)
#   5  Development + switch on   the route exists and issues a real operator
#                                session that opens the operator console API;
#                                a forwarded header claiming a remote address
#                                does not move the connection address
#   6  Development + switch on,  the route exists (GET 405) but refuses (409):
#      database NOT loopback     gate 5, on the data (Mr. Singh, 25 Sept)
#
# 5 is the calibration for 3 and 4: the same request, the same URL, answered
# with a session. Without it a 404 could mean a typo in the path. And 3 is
# the calibration for 1: Production boots with this very configuration once
# the switch is off, so a refusal in 1 is the switch and nothing else.
#
# "The route does not exist" is asked two ways. POST answers 404 whichever
# gate stops it; GET answers 405 when the route is MAPPED (POST-only) and 404
# only when it is not — so GET tells the routing gate apart from the
# request-time one, which POST alone cannot.
#
# Gate 4 (loopback caller) is NOT exercised from a remote socket here: that
# needs the API listening on a LAN address, which on Windows raises a
# firewall prompt. tests/dev-operator/gates proves that decision directly,
# including production's own caller address and forwarded headers claiming
# loopback; stage 5 below proves the header cannot move the address the
# gate reads.
#
# Stages 1-5 connect the API to Postgres as Host=localhost (gate 5 requires a
# loopback database; WSL forwards localhost). Stage 6 connects the same
# database by a NON-loopback address: the WSL address on a laptop, this
# machine's first address elsewhere (CI, where the service port is published
# on every interface).
#
# Needs: dotnet, a built Release API (dotnet build -c Release
# apps/api/TatvaOS.Api.csproj), python, and local Postgres (WSL or Docker),
# like the other scripts under tests/. Creates dev-operator@tatvaos.test in
# the LOCAL database on first run; later runs reuse it.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_DEVOP_TEST_PORT:-5083}"
API="http://localhost:$PORT"
ROUTE="/api/dev/operator-session"
EMAIL="dev-operator@tatvaos.test"
SCRATCH="$ROOT/.tmp/dev-operator-$$"
mkdir -p "$SCRATCH"
if command -v cygpath >/dev/null 2>&1; then KEYDIR="$(cygpath -w "$SCRATCH")\keys"; else KEYDIR="$SCRATCH/keys"; fi
LOG="$SCRATCH/api.log"

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
PG() { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1 | tr -d '\r'; }

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
# What a failure line may say about a response: its error text, or the NAMES
# of its fields — never their values. A sign-in response carries an access
# and a refresh token, and a test must not print a token (house rule 5),
# local or not. Caught 25 Sept 2026, when a calibration run printed one.
safe() { "$PY" -c "import sys,json
try:
    d=json.load(sys.stdin); print(d.get('error') or 'fields: ' + ','.join(sorted(d)))
except Exception: print('(not JSON)')" 2>/dev/null; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_URLS="$API"
pg_conn() { printf 'Host=%s;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true' "$1"; }
LOOPBACK_DB="${TATVAOS_DEVOP_DB_HOST:-localhost}"
if command -v wsl >/dev/null 2>&1; then REMOTE_DB="$(wsl hostname -I | awk '{print $1}' | tr -d '\r')"
else REMOTE_DB="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
export ConnectionStrings__Postgres="$(pg_conn "$LOOPBACK_DB")"
export Smtp__Host=localhost Smtp__Port=5870
export Oidc__KeyDirectory="$KEYDIR"
# Never inherited from the caller's shell: every run below sets it itself.
unset DevOperatorSignIn__Enabled

API_PID=""
# start_api <environment> <switch value or empty>. Returns 0 when /health
# answers, 1 when the process exited first, 2 on timeout.
start_api() {
    : > "$LOG"
    if [ -n "$2" ]; then
        ASPNETCORE_ENVIRONMENT="$1" DevOperatorSignIn__Enabled="$2" \
            dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
    else
        ASPNETCORE_ENVIRONMENT="$1" \
            dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
    fi
    API_PID=$!
    for _ in $(seq 1 120); do
        curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && return 0
        kill -0 "$API_PID" 2>/dev/null || { wait "$API_PID" 2>/dev/null; API_PID=""; return 1; }
        sleep 1
    done
    return 2
}
stop_api() {
    # dotnet run spawns the real process; kill by port so the child dies too.
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
    else
        fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    fi
    [ -n "$API_PID" ] && { kill "$API_PID" >/dev/null 2>&1; wait "$API_PID" 2>/dev/null; }
    API_PID=""
}
cleanup() { stop_api; rm -rf "$SCRATCH"; [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" 2>/dev/null; true; }
trap cleanup EXIT

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Refusal to start: the process must EXIT, never answer /health, and say why.
# Exiting for any other reason would be red for the wrong reason (rule 6).
expect_refusal() {
    start_api "$1" "true"; local r=$?
    if [ "$r" = "0" ]; then
        fail "$1 + switch on: the API STARTED and answers /health"
        local h; h=$(code -X POST "$API$ROUTE")
        [ "$h" = "200" ] && fail "$1 + switch on: and it ISSUED AN OPERATOR SESSION ($h)"
        stop_api; return
    fi
    [ "$r" = "1" ] && pass "$1 + switch on: the process exited without answering /health" \
                   || fail "$1 + switch on: neither started nor exited within 120s"
    grep -qF -- "Refusing to start: DevOperatorSignIn__Enabled is on but ASPNETCORE_ENVIRONMENT is '$1'" "$LOG" \
        && pass "$1 + switch on: it exited for THIS reason (the refusal names '$1')" \
        || { fail "$1 + switch on: exited, but not with the refusal — tail of its log:"; tail -5 "$LOG"; }
    stop_api
}

# The route must not exist — asked of a running API.
expect_absent() {
    local label="$1"
    local h
    h=$(code -X POST "$API$ROUTE");  [ "$h" = "404" ] && pass "$label: POST $ROUTE answers 404" || fail "$label: POST answered $h"
    h=$(code "$API$ROUTE");          [ "$h" = "404" ] && pass "$label: GET answers 404 — the route is not even mapped" || fail "$label: GET answered $h (405 would mean it is mapped)"
    grep -q "is mapped" "$LOG" && fail "$label: the startup log says the route is mapped" || pass "$label: the startup log does not announce the route"
    # Calibration inside the run: a real anonymous route answers, so the 404s
    # above are this route missing and not everything missing.
    h=$(code -X POST -H 'Content-Type: application/json' -d '{"phone":"nonsense"}' "$API/api/auth/otp/request")
    [ "$h" = "400" ] && pass "$label: a neighbouring auth route answers (400), so routing itself works" || fail "$label: /api/auth/otp/request answered $h"
    [ "$(PG "select count(*) from core.users where email = '$EMAIL' and created_at > '$RUN_STARTED'")" = "0" ] \
        && pass "$label: no operator account was created by this run" || fail "$label: an operator account was created during this run"
}

RUN_STARTED=$(PG "select now()")

# ---------------------------------------------------------------------------
step "0. The database answers ($TATVAOS_PG_HOST)"
[ -n "$RUN_STARTED" ] && pass "local Postgres answers ($RUN_STARTED)" || { fail "no answer from local Postgres"; exit 1; }
[ -f "$ROOT/apps/api/bin/Release/net10.0/TatvaOS.Api.dll" ] && pass "a Release build exists" || { fail "no Release build — dotnet build -c Release apps/api/TatvaOS.Api.csproj"; exit 1; }

step "1. Production with the switch on — must refuse to start"
expect_refusal "Production"

step "2. Staging with the switch on — must refuse to start"
expect_refusal "Staging"

step "3. Production with the switch off — starts, and the route does not exist"
if start_api "Production" ""; then
    pass "Production starts with this configuration (so 1 was the switch, not the setup)"
    expect_absent "Production"
else
    fail "Production did not start with the switch off — tail of its log:"; tail -8 "$LOG"
fi
stop_api

step "4. Development with the switch off — CI's configuration; the route does not exist"
if start_api "Development" ""; then
    pass "Development starts"
    expect_absent "Development, switch off"
else
    fail "Development did not start — tail of its log:"; tail -8 "$LOG"
fi
stop_api

step "5. Development with the switch on — a real operator session (calibrates 3 and 4)"
AUDIT_BEFORE=$(PG "select count(*) from core.audit_logs where action = 'auth.dev_operator_session'")
if start_api "Development" "true"; then
    pass "Development starts with the switch on"
    grep -q "DEVELOPMENT ONLY: $ROUTE is mapped" "$LOG" && pass "the startup log announces the route" || fail "no startup warning naming the route"
    h=$(code "$API$ROUTE"); [ "$h" = "405" ] && pass "GET answers 405 — mapped, POST only (so 4's 404 meant unmapped)" || fail "GET answered $h"
    # A note, not a check: the positive results below are the proof that a
    # loopback database passes gate 5.
    printf '  (the API connects to the database as Host=%s)\n' "$LOOPBACK_DB"

    body=$(curl -s -D "$SCRATCH/h1" -X POST "$API$ROUTE")
    [ "$(printf '%s' "$body" | j "d['user']['role']")" = "super_admin" ] && pass "session issued for a super_admin" || fail "response: $(printf '%s' "$body" | safe)"
    [ "$(printf '%s' "$body" | j "d['user']['email']")" = "$EMAIL" ] && pass "the account is $EMAIL, not the bootstrap operator" || fail "email: $(printf '%s' "$body" | j "d['user'].get('email')")"
    [ "$(printf '%s' "$body" | j "d['mustChangePassword']")" = "False" ] && pass "not forced into a password change" || fail "mustChangePassword: $(printf '%s' "$body" | j "d.get('mustChangePassword')")"
    grep -qi "^set-cookie: tv_refresh_" "$SCRATCH/h1" && pass "a refresh cookie is set — a browser is signed in by this call" || fail "no tv_refresh_ cookie in the response"
    TOKEN=$(printf '%s' "$body" | j "d['accessToken']")
    ID1=$(printf '%s' "$body" | j "d['user']['id']")

    h=$(code -H "Authorization: Bearer $TOKEN" "$API/api/admin/organisations")
    [ "$h" = "200" ] && pass "the token opens GET /api/admin/organisations (the operator console's list)" || fail "/api/admin/organisations answered $h"
    h=$(code "$API/api/admin/organisations")
    [ "$h" = "401" ] && pass "…and without it the same call is 401 (the 200 is the session's doing)" || fail "unauthenticated /api/admin/organisations answered $h"

    body2=$(curl -s -X POST "$API$ROUTE")
    [ "$(printf '%s' "$body2" | j "d['user']['id']")" = "$ID1" ] && pass "a second call signs in the SAME account" || fail "second call: $(printf '%s' "$body2" | safe)"
    [ "$(PG "select count(*) from core.users where email = '$EMAIL'")" = "1" ] && pass "exactly one $EMAIL row" || fail "rows for $EMAIL: $(PG "select count(*) from core.users where email = '$EMAIL'")"
    [ "$(PG "select (password_hash is null)::text || ',' || (phone is null)::text || ',' || role from core.users where email = '$EMAIL'")" = "true,true,super_admin" ] \
        && pass "the row has no password and no phone — no other door opens it" || fail "row: $(PG "select (password_hash is null)::text || ',' || (phone is null)::text || ',' || role from core.users where email = '$EMAIL'")"
    h=$(code -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"not-a-password-anyone-has\"}" "$API/api/auth/login")
    [ "$h" = "401" ] && pass "password sign-in to the account is refused (401)" || fail "password login answered $h"

    # Gate 4 reads the CONNECTION's address. If anything — a middleware
    # someone "harmonised" with the rate limiters, ForwardedHeaders with
    # X-Forwarded-For turned on — rewrote it from this header, a loopback
    # caller would become 203.0.113.9 and be refused here. The dangerous
    # direction (remote caller claiming loopback) is in gates/.
    h=$(code -X POST -H "X-Forwarded-For: 203.0.113.9" -H "X-Real-IP: 203.0.113.9" -H "Forwarded: for=203.0.113.9" "$API$ROUTE")
    [ "$h" = "200" ] && pass "a loopback caller claiming 203.0.113.9 in forwarded headers is still served — no header moves the address gate 4 reads" \
                     || fail "a loopback caller with forwarded headers answered $h — something rewrites the connection address from a header"

    AUDIT_AFTER=$(PG "select count(*) from core.audit_logs where action = 'auth.dev_operator_session'")
    [ "$((AUDIT_AFTER - AUDIT_BEFORE))" = "3" ] && pass "three sign-ins, three audit rows" || fail "audit rows went $AUDIT_BEFORE -> $AUDIT_AFTER"
    [ "$(grep -c "DEVELOPMENT ONLY: issued a platform-operator session" "$LOG")" = "3" ] && pass "three sign-ins, three warnings in the log" || fail "warnings: $(grep -c "DEVELOPMENT ONLY: issued" "$LOG")"
else
    fail "Development did not start with the switch on — tail of its log:"; tail -8 "$LOG"
fi
stop_api

step "6. Development with the switch on, database NOT loopback — gate 5 refuses"
if [ -z "$REMOTE_DB" ]; then
    fail "NOT RUN: no non-loopback address for the database on this machine — gate 5 unproven here"
else
    ConnectionStrings__Postgres="$(pg_conn "$REMOTE_DB")"; export ConnectionStrings__Postgres
    AUDIT_BEFORE=$(PG "select count(*) from core.audit_logs where action = 'auth.dev_operator_session'")
    if start_api "Development" "true"; then
        pass "Development starts with the switch on, database at $REMOTE_DB"
        h=$(code "$API$ROUTE"); [ "$h" = "405" ] && pass "GET answers 405 — the route IS mapped, so what follows is gate 5 and not gate 2" || fail "GET answered $h"
        # The calibration for the refusal: this address really is the database
        # — the API reaches it — so a 409 is the gate, not a dead link.
        h=$(code "$API/health/db"); [ "$h" = "200" ] && pass "the API reaches the database at $REMOTE_DB (/health/db 200)" || fail "/health/db answered $h — a refusal below would prove nothing"
        body=$(curl -s -w '\n%{http_code}' -X POST "$API$ROUTE")
        [ "$(printf '%s' "$body" | tail -n1)" = "409" ] && pass "POST answers 409 — refused, the database is not on this machine" || fail "POST answered $(printf '%s' "$body" | tail -n1): $(printf '%s' "$body" | sed '$d' | safe)"
        [[ "$body" == *accessToken* ]] && fail "a SESSION WAS ISSUED against a non-loopback database" || pass "no session in the response"
        grep -q "the database host is not loopback" "$LOG" && pass "the refusal is logged" || fail "no refusal line in the log"
        [ "$(PG "select count(*) from core.audit_logs where action = 'auth.dev_operator_session'")" = "$AUDIT_BEFORE" ] && pass "no audit row: nothing was written" || fail "an audit row was written"
    else
        fail "Development did not start against $REMOTE_DB — tail of its log:"; tail -8 "$LOG"
    fi
    stop_api
    ConnectionStrings__Postgres="$(pg_conn "$LOOPBACK_DB")"; export ConnectionStrings__Postgres
fi

echo
if [ "$FAILED" = "0" ]; then printf '%sPASS %s%s\n' "$GREEN" "$PASSED" "$RST"; exit 0
else printf '%sFAIL %s of %s%s\n' "$RED" "$FAILED" "$((PASSED+FAILED))" "$RST"; exit 1; fi
