#!/usr/bin/env bash
#
# TatvaOS — OpenID Connect provider, stage 3 (decision 0004): the ten steps
# of "What proves it", run as a real relying party over HTTP against an API
# this script starts itself, on the local database.
#
#   1. register an application in tenant A; authorize, consent and token
#      with PKCE; the ID token verifies against the key set by kid; iss,
#      aud, nonce, exp, sub, email, tid are right
#   2. userinfo with the access token answers the same sub
#   3. revoke the application: refresh refused, userinfo 401, introspection
#      inactive, a new authorize issues no code — and the step-1 ID token
#      STILL verifies (the documented limit)
#   4. a person from tenant B at tenant A's application: refused, no code
#   5. the same code redeemed twice: invalid_grant, and the first exchange's
#      access token stops working
#   6. a redirect URI off by a trailing slash or a query parameter: an error
#      on TatvaOS, never a redirect
#   7. a wrong or missing PKCE verifier: refused
#   8. a suspended person's refresh token: refused (and their access token)
#   9. the API log holds none of the secrets, codes, verifiers, tokens or
#      redirect Locations this run used
#  10. RLS: as tenant B the app role reads no tenant A row from any provider
#      table
#
# The browser is curl with a cookie jar. curl will not SEND a Secure cookie
# over plain http, so the session cookies are read back out of the jar and
# sent as a literal Cookie header — the same bytes a browser would send over
# https. Sign-in is by on-screen OTP, as the other tests here do.
#
# Needs: dotnet, a built Release API, python, node, and psql reachable —
#   TATVAOS_PG_HOST     where the API finds Postgres (default: the WSL VM's
#                       address when wsl exists, else localhost)
#   TATVAOS_PSQL        superuser psql command prefix (default: wsl as postgres,
#                       else docker exec tv-postgres)
#   TATVAOS_PSQL_APP    the same as tatvaos_app
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_OIDC_TEST_PORT:-5078}"
API="http://localhost:$PORT"
ISSUER="https://core.tatvaos.com"
RP="https://rp.test/cb"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
RUN=$(date +%s)

SCRATCH="$ROOT/.tmp/oidc-stage3-$$"
mkdir -p "$SCRATCH"
if command -v cygpath >/dev/null 2>&1; then KEYDIR="$(cygpath -w "$SCRATCH")\keys"; else KEYDIR="$SCRATCH/keys"; fi
LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        # WSL stops its VM a few seconds after the last wsl process ends, and
        # Postgres dies with it — found on the first run of this script, whose
        # API lost its connections between two psql calls. One idle wsl
        # process for the length of the run keeps the VM, and its address, up.
        wsl -e sleep 7200 >/dev/null 2>&1 &
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
# For failure messages: the first line or two, never a whole exception page.
brief()  { printf '%s' "$1" | head -c 240 | tr '
' ' '; }
urlenc() { "$PY" -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }

# A browser's Cookie header, rebuilt from a curl jar (Netscape format; the
# #HttpOnly_ prefix and the Secure column are why curl itself will not send
# them to http://).
cookies() { awk '!/^$/ && !/^#( |$)/ { sub(/^#HttpOnly_/, ""); if (NF >= 7) printf "%s=%s; ", $6, $7 }' "$1"; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export Oidc__KeyDirectory="$KEYDIR" Oidc__Issuer="$ISSUER"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
# Low limits for step 11, high enough that the flow itself never trips them
# (the flow makes about a dozen token and two dozen authorize calls, all from
# 127.0.0.1; step 11 hammers from its own forwarded address).
export Oidc__TokenRequestsPerMinute=25 Oidc__AuthorizeRequestsPerMinute=40

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
cleanup() {
    stop_api
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    PG "UPDATE core.users SET status='active' WHERE email='hr@techvein.local' AND status='suspended'" >/dev/null
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf '  kept for reading: %s
' "$SCRATCH"; fi
}
trap cleanup EXIT

# ---- protocol helpers -----------------------------------------------------
# Every secret this run creates is remembered here for step 9.
SECRETS=()
remember() { [ -n "${1:-}" ] && SECRETS+=("$1"); }

pkce() { # sets VERIFIER and CHALLENGE
    VERIFIER=$("$PY" -c "import secrets; print(secrets.token_urlsafe(48))")
    CHALLENGE=$("$PY" -c "import hashlib,base64,sys; print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).rstrip(b'=').decode())" "$VERIFIER")
    remember "$VERIFIER"
}

# authorize_url <client_id> <redirect_uri> <state> <nonce> <challenge> [scope]
authorize_url() {
    printf '%s/api/auth/oauth/authorize?response_type=code&client_id=%s&redirect_uri=%s&scope=%s&state=%s&nonce=%s&code_challenge=%s&code_challenge_method=S256' \
        "$API" "$1" "$(urlenc "$2")" "$(urlenc "${6:-openid profile email offline_access}")" "$3" "$4" "$5"
}

# authorize <jar> <url> [decision]  → HTTP_CODE, LOCATION; a POST when a decision is given
authorize() {
    local jar=$1 url=$2 decision=${3:-}
    local out
    if [ -z "$decision" ]; then
        out=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' -H "Cookie: $(cookies "$jar")" "$url")
    else
        # The consent page's form: the same parameters as the query, plus the decision, as a same-site POST.
        local query=${url#*\?}
        out=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' -X POST -H "Cookie: $(cookies "$jar")" \
              -H 'Content-Type: application/x-www-form-urlencoded' --data "$query&tv_decision=$decision" "$API/api/auth/oauth/authorize")
    fi
    HTTP_CODE=${out%%|*}; LOCATION=${out#*|}
    remember "$LOCATION"
}
code_from() { "$PY" -c "import sys,urllib.parse; q=urllib.parse.urlparse(sys.argv[1]).query; print(urllib.parse.parse_qs(q).get('code',[''])[0])" "$1"; }
param_from() { "$PY" -c "import sys,urllib.parse; q=urllib.parse.urlparse(sys.argv[1]).query; print(urllib.parse.parse_qs(q).get(sys.argv[2],[''])[0])" "$1" "$2"; }

# token <form-data...> → prints body + status line
token() { curl -s -w '\n%{http_code}' -X POST "$API/api/oauth/token" "$@"; }
userinfo() { curl -s -o /dev/null -w '%{http_code}' "$API/api/oauth/userinfo" -H "Authorization: Bearer $1"; }
userinfo_body() { curl -s "$API/api/oauth/userinfo" -H "Authorization: Bearer $1"; }

# sign_in <phone> <jar> → TOKEN (bearer), cookies in the jar
sign_in() {
    local phone=$1 jar=$2
    PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$phone'" >/dev/null
    local r code
    r=$(curl -s -X POST "$API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\"}")
    code=$(jq_ "$r" "d.get('devCode') or ''")
    [ -n "$code" ] || { fail "no devCode for $phone: $r"; return 1; }
    r=$(curl -s -c "$jar" -X POST "$API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\",\"code\":\"$code\"}")
    TOKEN=$(jq_ "$r" "d.get('accessToken') or ''")
    [ -n "$TOKEN" ] || { fail "verify failed for $phone: $r"; return 1; }
    grep -q "tv_refresh_" "$jar" || { fail "no session cookie in the jar for $phone"; return 1; }
    return 0
}

# register_app <bearer> <name> → APP_ID, CLIENT_ID, CLIENT_SECRET
register_app() {
    local r
    r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications" -H 'Content-Type: application/json' -H "Authorization: Bearer $1" \
        -d "{\"name\":\"$2\",\"redirectUris\":[\"$RP\"],\"confidential\":true,\"scopes\":[\"profile\",\"email\",\"offline_access\"]}")
    [ "$(status "$r")" = "201" ] || { fail "register '$2': $(status "$r") $(brief "$(body "$r")")"; return 1; }
    APP_ID=$(jq_ "$(body "$r")" "d['id']"); CLIENT_ID=$(jq_ "$(body "$r")" "d['clientId']"); CLIENT_SECRET=$(jq_ "$(body "$r")" "d['clientSecret']")
    remember "$CLIENT_SECRET"
}

# ===========================================================================
step "0. Start the API against $TATVAOS_PG_HOST, with its own key directory"
for _ in $(seq 1 30); do [ -n "$(PG 'SELECT 1')" ] && break; sleep 1; done
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer ($TATVAOS_PSQL)"; exit 1; }
start_api || exit 1
pass "API up; log at $LOG"
# The seeded people, given phones for OTP sign-in (the seed has none).
PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET phone='+919999900002' WHERE email='hr@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET phone='+919999900003' WHERE email='principal@abcschool.local' AND phone IS NULL" >/dev/null
OWNER_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
HR_ID=$(PG "SELECT id FROM core.users WHERE email='hr@techvein.local'")
curl -s "$API/api/oauth/jwks" > "$SCRATCH/jwks.json"
[ "$(j "len(d['keys'])" < "$SCRATCH/jwks.json")" -ge 1 ] && pass "key set published" || { fail "no key set"; exit 1; }
DISC=$(curl -s "$API/.well-known/openid-configuration")
[ "$(jq_ "$DISC" "d['authorization_endpoint']")" = "$ISSUER/oauth/authorize" ] && pass "discovery advertises the web authorize page" || fail "authorization_endpoint: $(jq_ "$DISC" "d.get('authorization_endpoint')")"
ISS_CLAIM=$(jq_ "$DISC" "d['issuer']")

step "Sign in the Techvein owner and register application A"
JAR_A="$SCRATCH/owner.jar"
sign_in '+919999900001' "$JAR_A" || exit 1
OWNER_TOKEN=$TOKEN
register_app "$OWNER_TOKEN" "Payroll $RUN" || exit 1
APP_A=$APP_ID; CID_A=$CLIENT_ID; SEC_A=$CLIENT_SECRET
pass "application A registered (confidential, redirect $RP)"

# ===========================================================================
step "1. Authorize → consent → code → tokens; the ID token verifies"
pkce; V1=$VERIFIER
STATE="st$RUN"; NONCE="n$RUN"
URL=$(authorize_url "$CID_A" "$RP" "$STATE" "$NONCE" "$CHALLENGE")
authorize "$JAR_A" "$URL"
[ "$HTTP_CODE" = "302" ] && [[ "$LOCATION" == */oauth/consent?* ]] && pass "first visit: sent to the consent page (302)" || fail "first visit answered $HTTP_CODE → ${LOCATION%%\?*}"
[[ "$LOCATION" != *code=* ]] && pass "no code before consent" || fail "a code was issued before consent"
# The consent page's own read: what it shows.
r=$(curl -s -w '\n%{http_code}' "$API/api/auth/oauth/consent?client_id=$CID_A&redirect_uri=$(urlenc "$RP")&scope=openid%20profile%20email%20offline_access" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "200" ] && pass "consent details 200" || fail "consent details: $(status "$r") $(brief "$(body "$r")")"
[ "$(jq_ "$(body "$r")" "d['returnsTo']")" = "rp.test" ] && pass "consent shows the return host" || fail "returnsTo: $(body "$r")"
[ "$(jq_ "$(body "$r")" "', '.join(d['receives'])")" = "your name, your work email address, which organisation you belong to, access to your information when you are not using the application" ] \
    && pass "consent lists what leaves, in words - offline_access says what it does" \
    || fail "receives: $(brief "$(body "$r")")"
# The person clicks Continue.
authorize "$JAR_A" "$URL" allow
[ "$HTTP_CODE" = "302" ] && [[ "$LOCATION" == "$RP?"* ]] && pass "consent given: redirected to the application (302)" || fail "after consent: $HTTP_CODE → ${LOCATION%%\?*}"
CODE1=$(code_from "$LOCATION"); remember "$CODE1"
[ -n "$CODE1" ] && pass "a code came back" || fail "no code in the redirect"
[ "$(param_from "$LOCATION" state)" = "$STATE" ] && pass "state echoed" || fail "state missing or wrong"

r=$(token -d grant_type=authorization_code -d "code=$CODE1" -d "redirect_uri=$RP" -d "client_id=$CID_A" -d "client_secret=$SEC_A" -d "code_verifier=$V1")
[ "$(status "$r")" = "200" ] && pass "token endpoint 200" || fail "token: $(status "$r") $(brief "$(body "$r")")"
ACCESS1=$(jq_ "$(body "$r")" "d.get('access_token','')"); REFRESH1=$(jq_ "$(body "$r")" "d.get('refresh_token','')"); ID1=$(jq_ "$(body "$r")" "d.get('id_token','')")
remember "$ACCESS1"; remember "$REFRESH1"; remember "$ID1"
[ -n "$ACCESS1" ] && pass "access token issued" || fail "no access token"
[ -n "$REFRESH1" ] && pass "refresh token issued (offline_access asked)" || fail "no refresh token"
[ -n "$ID1" ] && pass "ID token issued" || fail "no ID token"
[ "$(jq_ "$(body "$r")" "d.get('token_type','')")" = "Bearer" ] && pass "token_type Bearer" || fail "token_type: $(jq_ "$(body "$r")" "d.get('token_type')")"
[[ "$ACCESS1" != *.*.* ]] && pass "access token is opaque, not a JWT" || fail "access token looks like a JWT"
v=$(node "$ROOT/tests/oidc/verify-id-token.js" "$ID1" "$SCRATCH/jwks.json" "$ISS_CLAIM" "$CID_A" "$NONCE" "$OWNER_ID" "$TECHVEIN")
[ "$v" = "ok" ] && pass "ID token: signature by the published kid; iss, aud, nonce, exp, sub, tid correct" || fail "ID token: $v"
[ "$("$PY" -c "import sys,json,base64; p=sys.argv[1].split('.')[1]; p+='='*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p)).get('email',''))" "$ID1")" = "amit@techvein.local" ] \
    && pass "ID token carries the work email" || fail "ID token email wrong"

step "2. Userinfo"
r=$(userinfo_body "$ACCESS1")
[ "$(jq_ "$r" "d['sub']")" = "$OWNER_ID" ] && pass "userinfo sub is the user id" || fail "userinfo: $r"
[ "$(jq_ "$r" "d['tid']")" = "$TECHVEIN" ] && pass "userinfo tid is the organisation" || fail "userinfo tid: $r"
[ "$(jq_ "$r" "d.get('email')")" = "amit@techvein.local" ] && pass "userinfo email" || fail "userinfo email: $r"
# Consent is remembered: the second visit goes straight back with a code.
pkce; URL2=$(authorize_url "$CID_A" "$RP" "s2$RUN" "n2$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL2"
[ "$HTTP_CODE" = "302" ] && [[ "$LOCATION" == "$RP?"*code=* ]] && pass "second visit: consent remembered, code issued without asking" || fail "second visit: $HTTP_CODE → ${LOCATION%%\?*}"
# Introspection while live, by the application itself.
r=$(curl -s -X POST "$API/api/oauth/introspect" -u "$CID_A:$SEC_A" -d "token=$ACCESS1")
[ "$(jq_ "$r" "d['active']")" = "True" ] && pass "introspection: active while live" || fail "introspection while live: $r"

# A second, live application in tenant A for the steps after the revoke.
register_app "$OWNER_TOKEN" "Accounts $RUN" || exit 1
APP_B=$APP_ID; CID_B=$CLIENT_ID; SEC_B=$CLIENT_SECRET

# ===========================================================================
step "3. Revoke application A — everything of A stops, the ID token does not"
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications/$APP_A/revoke" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "200" ] && pass "revoked" || fail "revoke: $(status "$r")"
r=$(token -d grant_type=refresh_token -d "refresh_token=$REFRESH1" -d "client_id=$CID_A" -d "client_secret=$SEC_A")
e=$(jq_ "$(body "$r")" "d.get('error','')")
[ "$(status "$r")" != "200" ] && [ "$e" = "invalid_client" -o "$e" = "invalid_grant" ] && pass "refresh refused ($e — the client is refused before the grant is read)" || fail "refresh after revoke: $(status "$r") $(brief "$(body "$r")")"
[ "$(userinfo "$ACCESS1")" = "401" ] && pass "userinfo with the still-unexpired access token: 401" || fail "userinfo after revoke: $(userinfo "$ACCESS1")"
r=$(curl -s -X POST "$API/api/oauth/introspect" -u "$CID_B:$SEC_B" -d "token=$ACCESS1")
[ "$(jq_ "$r" "d.get('active')")" = "False" ] && pass "introspection (by a live application): active false" || fail "introspection after revoke: $r"
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/oauth/introspect" -u "$CID_A:$SEC_A" -d "token=$ACCESS1")
[ "$(status "$r")" != "200" ] && pass "introspection by the revoked application itself: refused as a client" || fail "revoked client could introspect"
pkce; URL3=$(authorize_url "$CID_A" "$RP" "s3$RUN" "n3$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL3"
[[ "$LOCATION" != *code=* ]] && [ "$HTTP_CODE" != "302" -o -z "$LOCATION" ] && pass "a new authorize shows an error and issues no code ($HTTP_CODE)" || fail "authorize after revoke: $HTTP_CODE → ${LOCATION%%\?*}"
v=$(node "$ROOT/tests/oidc/verify-id-token.js" "$ID1" "$SCRATCH/jwks.json" "$ISS_CLAIM" "$CID_A" "$NONCE" "$OWNER_ID" "$TECHVEIN")
[ "$v" = "ok" ] && pass "the step-1 ID token STILL verifies — the documented limit, not a bug" || fail "ID token after revoke: $v"

# ===========================================================================
step "4. A person from ABC School at Techvein's application B"
JAR_B="$SCRATCH/school.jar"
sign_in '+919999900003' "$JAR_B" || exit 1
pkce; URL4=$(authorize_url "$CID_B" "$RP" "s4$RUN" "n4$RUN" "$CHALLENGE")
authorize "$JAR_B" "$URL4"
[[ "$LOCATION" != *code=* ]] && pass "no code" || fail "LEAK: a school person got a code for a Techvein application"
[ "$HTTP_CODE" = "302" ] && [ "$(param_from "$LOCATION" error)" = "access_denied" ] && pass "refused: error=access_denied back to the application" || fail "cross-tenant authorize: $HTTP_CODE error=$(param_from "$LOCATION" error)"
authorize "$JAR_B" "$URL4" allow
[[ "$LOCATION" != *code=* ]] && pass "even with a forged 'allow' POST: no code" || fail "LEAK: forged allow issued a code across tenants"
# The consent details are not readable across tenants either.
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/auth/oauth/consent?client_id=$CID_B&redirect_uri=$(urlenc "$RP")&scope=openid" -H "Authorization: Bearer $TOKEN")
[ "$h" = "404" ] && pass "consent details for another organisation's application: 404" || fail "cross-tenant consent details: $h"

# ===========================================================================
step "5. The same code redeemed twice"
pkce; V5=$VERIFIER; URL5=$(authorize_url "$CID_B" "$RP" "s5$RUN" "n5$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL5"; [[ "$LOCATION" == */oauth/consent?* ]] && authorize "$JAR_A" "$URL5" allow
CODE5=$(code_from "$LOCATION"); remember "$CODE5"
[ -n "$CODE5" ] && pass "code for application B" || fail "no code for B: $HTTP_CODE"
r=$(token -d grant_type=authorization_code -d "code=$CODE5" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$V5")
[ "$(status "$r")" = "200" ] && pass "first redemption 200" || fail "first redemption: $(status "$r") $(brief "$(body "$r")")"
ACCESS5=$(jq_ "$(body "$r")" "d.get('access_token','')"); remember "$ACCESS5"; remember "$(jq_ "$(body "$r")" "d.get('refresh_token','')")"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
[ "$(userinfo "$ACCESS5")" = "200" ] && pass "its access token works" || fail "access token from the first redemption: $(userinfo "$ACCESS5")"
r=$(token -d grant_type=authorization_code -d "code=$CODE5" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$V5")
[ "$(jq_ "$(body "$r")" "d.get('error','')")" = "invalid_grant" ] && pass "second redemption: invalid_grant" || fail "second redemption: $(status "$r") $(brief "$(body "$r")")"
[ "$(userinfo "$ACCESS5")" = "401" ] && pass "and the first redemption's access token stops working" || fail "access token survived a replay: $(userinfo "$ACCESS5")"

# ===========================================================================
step "6. A redirect URI off by a trailing slash or a query parameter"
for bad in "$RP/" "$RP?x=1"; do
    pkce; URL6=$(authorize_url "$CID_B" "$bad" "s6$RUN" "n6$RUN" "$CHALLENGE")
    authorize "$JAR_A" "$URL6"
    [ "$HTTP_CODE" != "302" ] && [ -z "$LOCATION" ] && pass "'$bad': error shown on TatvaOS ($HTTP_CODE), no redirect" || fail "'$bad': $HTTP_CODE → ${LOCATION%%\?*}"
done

# ===========================================================================
step "7. A wrong or missing PKCE verifier"
pkce; V7=$VERIFIER; URL7=$(authorize_url "$CID_B" "$RP" "s7$RUN" "n7$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL7"; CODE7=$(code_from "$LOCATION"); remember "$CODE7"
r=$(token -d grant_type=authorization_code -d "code=$CODE7" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=${V7}x")
[ "$(jq_ "$(body "$r")" "d.get('error','')")" = "invalid_grant" ] && pass "wrong verifier: invalid_grant" || fail "wrong verifier: $(status "$r") $(brief "$(body "$r")")"
pkce; V7b=$VERIFIER; URL7b=$(authorize_url "$CID_B" "$RP" "s7b$RUN" "n7b$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL7b"; CODE7b=$(code_from "$LOCATION"); remember "$CODE7b"
r=$(token -d grant_type=authorization_code -d "code=$CODE7b" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B")
e=$(jq_ "$(body "$r")" "d.get('error','')")
[ "$(status "$r")" != "200" ] && [ "$e" = "invalid_grant" -o "$e" = "invalid_request" ] && pass "missing verifier: refused ($e)" || fail "missing verifier: $(status "$r") $(brief "$(body "$r")")"
# PKCE plain must not be offered or accepted.
URL7c="$(authorize_url "$CID_B" "$RP" "s7c$RUN" "n7c$RUN" "$V7b")"; URL7c="${URL7c%S256}plain"
authorize "$JAR_A" "$URL7c"
[[ "$LOCATION" != *code=* ]] && pass "code_challenge_method=plain: no code" || fail "plain PKCE accepted"

# ===========================================================================
step "8. A suspended person's refresh token"
JAR_C="$SCRATCH/hr.jar"
sign_in '+919999900002' "$JAR_C" || exit 1
pkce; V8=$VERIFIER; URL8=$(authorize_url "$CID_B" "$RP" "s8$RUN" "n8$RUN" "$CHALLENGE")
authorize "$JAR_C" "$URL8"; [[ "$LOCATION" == */oauth/consent?* ]] && authorize "$JAR_C" "$URL8" allow
CODE8=$(code_from "$LOCATION"); remember "$CODE8"
r=$(token -d grant_type=authorization_code -d "code=$CODE8" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$V8")
[ "$(status "$r")" = "200" ] && pass "HR signed in through application B" || fail "HR token: $(status "$r") $(brief "$(body "$r")")"
ACCESS8=$(jq_ "$(body "$r")" "d.get('access_token','')"); REFRESH8=$(jq_ "$(body "$r")" "d.get('refresh_token','')"); remember "$ACCESS8"; remember "$REFRESH8"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
r=$(token -d grant_type=refresh_token -d "refresh_token=$REFRESH8" -d "client_id=$CID_B" -d "client_secret=$SEC_B")
[ "$(status "$r")" = "200" ] && pass "refresh works while active" || fail "refresh while active: $(status "$r") $(brief "$(body "$r")")"
REFRESH8b=$(jq_ "$(body "$r")" "d.get('refresh_token','')"); remember "$REFRESH8b"; remember "$(jq_ "$(body "$r")" "d.get('access_token','')")"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
[ -n "$REFRESH8b" ] && [ "$REFRESH8b" != "$REFRESH8" ] && pass "refresh token rotated" || fail "refresh token not rotated"
r=$(token -d grant_type=refresh_token -d "refresh_token=$REFRESH8" -d "client_id=$CID_B" -d "client_secret=$SEC_B")
[ "$(jq_ "$(body "$r")" "d.get('error','')")" = "invalid_grant" ] && pass "the OLD refresh token, used again: invalid_grant" || fail "refresh reuse: $(status "$r") $(brief "$(body "$r")")"
# Reuse detection revoked HR's whole chain above, so the tokens that must
# outlive it are FRESH ones: a new authorization (the old one is revoked, so
# consent is asked again), a new code, new tokens. Then the suspension. This
# order is what gives the next two checks a failure mode — the first version
# of this step checked a token the reuse detection had already killed, and a
# build with no liveness check at userinfo still passed it (17 Sept 2026).
pkce; V8c=$VERIFIER; URL8c=$(authorize_url "$CID_B" "$RP" "s8c$RUN" "n8c$RUN" "$CHALLENGE")
authorize "$JAR_C" "$URL8c"; [[ "$LOCATION" == */oauth/consent?* ]] && authorize "$JAR_C" "$URL8c" allow
CODE8c=$(code_from "$LOCATION"); remember "$CODE8c"
r=$(token -d grant_type=authorization_code -d "code=$CODE8c" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$V8c")
[ "$(status "$r")" = "200" ] && pass "HR signed in again after the reuse detection (fresh authorization)" || fail "HR fresh token: $(status "$r") $(brief "$(body "$r")")"
ACCESS8c=$(jq_ "$(body "$r")" "d.get('access_token','')"); REFRESH8c=$(jq_ "$(body "$r")" "d.get('refresh_token','')"); remember "$ACCESS8c"; remember "$REFRESH8c"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
[ "$(userinfo "$ACCESS8c")" = "200" ] && pass "the fresh access token works while active" || fail "fresh access token: $(userinfo "$ACCESS8c")"
PG "UPDATE core.users SET status='suspended' WHERE id='$HR_ID'" >/dev/null
r=$(token -d grant_type=refresh_token -d "refresh_token=$REFRESH8c" -d "client_id=$CID_B" -d "client_secret=$SEC_B")
[ "$(jq_ "$(body "$r")" "d.get('error','')")" = "invalid_grant" ] && pass "suspended: refresh refused with invalid_grant" || fail "suspended refresh: $(status "$r") $(brief "$(body "$r")")"
[ "$(userinfo "$ACCESS8c")" = "401" ] && pass "suspended: the still-unexpired access token answers 401 at userinfo (the liveness check, nothing else, refuses it)" || fail "suspended userinfo: $(userinfo "$ACCESS8c")"
pkce; URL8b=$(authorize_url "$CID_B" "$RP" "s8b$RUN" "n8b$RUN" "$CHALLENGE")
authorize "$JAR_C" "$URL8b"
[[ "$LOCATION" != *code=* ]] && pass "suspended: authorize issues no code" || fail "suspended person got a code"
PG "UPDATE core.users SET status='active' WHERE id='$HR_ID'" >/dev/null

# The peek at authorize validates like sign-in does (CTO's question): an
# expired or revoked session cookie is "not signed in", never a code.
PG "UPDATE core.refresh_tokens SET expires_at=now()-interval '1 minute' WHERE user_id='$HR_ID' AND revoked_at IS NULL" >/dev/null
pkce; URL8d=$(authorize_url "$CID_B" "$RP" "s8d$RUN" "n8d$RUN" "$CHALLENGE")
authorize "$JAR_C" "$URL8d"
[[ "$LOCATION" != *code=* ]] && [[ "$LOCATION" == */login?next=* ]] && pass "an EXPIRED session cookie at authorize: sent to sign-in, no code" || fail "expired cookie: $HTTP_CODE → ${LOCATION%%\?*}"
[[ "$LOCATION" == *next=%2Foauth%2Fauthorize* ]] && pass "…and sign-in will return to the web authorize page" || fail "login next: ${LOCATION#*next=}"
PG "UPDATE core.refresh_tokens SET expires_at=now()+interval '1 day', revoked_at=now(), revoke_reason='test' WHERE user_id='$HR_ID' AND revoked_at IS NULL" >/dev/null
authorize "$JAR_C" "$URL8d"
[[ "$LOCATION" != *code=* ]] && [[ "$LOCATION" == */login?next=* ]] && pass "a REVOKED session cookie at authorize: sent to sign-in, no code" || fail "revoked cookie: $HTTP_CODE → ${LOCATION%%\?*}"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.revoked_session_at_authorize' AND target_id='$HR_ID' AND after_state::text LIKE '%"from"%'")
[ "${n:-0}" -ge 1 ] && pass "…and the attempt is in the audit log with the address it came from (audited, not escalated)" || fail "no audit row for the revoked cookie at authorize"

# ===========================================================================
step "9. Nothing secret in the API log"
leaks=0; checked=0
for s in "${SECRETS[@]}"; do
    [ ${#s} -ge 12 ] || continue
    checked=$((checked+1))
    n=$(grep -c -F -- "$s" "$LOG"); [ "$n" -eq 0 ] || { leaks=$((leaks+1)); printf '     a secret of %d characters appears %d time(s) in the log\n' "${#s}" "$n"; }
done
[ "$checked" -ge 20 ] && pass "$checked secret values checked (secrets, codes, verifiers, tokens, redirect Locations)" || fail "only $checked values to check — the run did not collect them"
[ "$leaks" -eq 0 ] && pass "none of them appears in the API log" || fail "$leaks value(s) leaked into the API log"
n=$(grep -c -F "rp.test/cb?code=" "$LOG"); [ "$n" -eq 0 ] && pass "no redirect Location with a code in the log" || fail "a redirect with a code is in the log $n time(s)"

# ===========================================================================
step "10. RLS: as ABC School, no Techvein provider row"
total=$(PG "SELECT (SELECT count(*) FROM core.oidc_applications WHERE tenant_id='$TECHVEIN') + (SELECT count(*) FROM core.oidc_authorizations WHERE tenant_id='$TECHVEIN') + (SELECT count(*) FROM core.oidc_tokens WHERE tenant_id='$TECHVEIN')")
[ "${total:-0}" -gt 0 ] && pass "the superuser sees $total Techvein rows across the three tables (so the next two checks can fail)" || fail "no rows to hide"
for t in oidc_applications oidc_authorizations oidc_tokens; do
    n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM core.$t WHERE tenant_id='$TECHVEIN'")
    [ "${n:-1}" -eq 0 ] && pass "school context: core.$t shows no Techvein row" || fail "LEAK: school sees ${n:-?} Techvein row(s) in core.$t"
    n=$(PGAPP "SELECT count(*) FROM core.$t")
    [ "${n:-1}" -eq 0 ] && pass "no context: core.$t shows nothing" || fail "DANGEROUS: ${n:-?} row(s) with no tenant in core.$t"
done

# ===========================================================================
step "11. The two public paths are rate-limited per address, before the client lookup"
# From a forwarded address of its own, so the flow above is not in the count.
# A nonsense client: the limiter answers 429 before OpenIddict ever looks it
# up; without the limiter every request would answer 400/401 and this fails.
first429=0; after=0
for i in $(seq 1 30); do
    h=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/oauth/token" -H 'X-Forwarded-For: 203.0.113.9' -d grant_type=authorization_code -d code=x -d client_id=tos_nonsense -d client_secret=toss_nonsense -d redirect_uri=https://rp.test/cb -d code_verifier=x)
    if [ "$h" = "429" ]; then [ "$first429" -eq 0 ] && first429=$i; after=$((after+1)); elif [ "$first429" -ne 0 ]; then fail "request $i answered $h after the limit was reached"; fi
done
[ "$first429" -eq 26 ] && pass "token: 25 allowed a minute per address, the 26th answers 429 (first 429 at request $first429)" || fail "token: first 429 at request ${first429:-none} (expected 26)"
[ "$after" -eq 5 ] && pass "token: every request after the limit answers 429" || fail "token: $after of 5 post-limit requests were 429"
r=$(curl -s -X POST "$API/api/oauth/token" -H 'X-Forwarded-For: 203.0.113.9' -d grant_type=authorization_code -d code=x -d client_id=tos_nonsense)
[ "$(jq_ "$r" "d.get('error','')")" = "temporarily_unavailable" ] && pass "token: the 429 body is a protocol error the client library understands" || fail "429 body: $(brief "$r")"
first429=0
for i in $(seq 1 45); do
    h=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 203.0.113.10' "$API/api/auth/oauth/authorize?response_type=code&client_id=tos_nonsense&redirect_uri=https%3A%2F%2Frp.test%2Fcb")
    [ "$h" = "429" ] && [ "$first429" -eq 0 ] && first429=$i
done
[ "$first429" -eq 41 ] && pass "authorize: 40 allowed a minute per address, the 41st answers 429" || fail "authorize: first 429 at request ${first429:-none} (expected 41)"
h=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/oauth/token" -H 'X-Forwarded-For: 203.0.113.11' -d grant_type=authorization_code -d code=x -d client_id=tos_nonsense)
[ "$h" != "429" ] && pass "another address is not affected ($h)" || fail "another address was limited too"

# ===========================================================================
step "12. The person's own consents: listed, removed, asked again (stage 4)"
pkce; V12=$VERIFIER; URL12=$(authorize_url "$CID_B" "$RP" "s12$RUN" "n12$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL12"; [[ "$LOCATION" == */oauth/consent?* ]] && authorize "$JAR_A" "$URL12" allow
CODE12=$(code_from "$LOCATION"); remember "$CODE12"
r=$(token -d grant_type=authorization_code -d "code=$CODE12" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$V12")
[ "$(status "$r")" = "200" ] && pass "owner signed in through application B again" || fail "step 12 token: $(status "$r") $(brief "$(body "$r")")"
ACCESS12=$(jq_ "$(body "$r")" "d.get('access_token','')"); REFRESH12=$(jq_ "$(body "$r")" "d.get('refresh_token','')"); remember "$ACCESS12"; remember "$REFRESH12"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
r=$(curl -s -w '\n%{http_code}' "$API/api/auth/oauth/consents" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "200" ] && pass "consents listed (200)" || fail "consents: $(status "$r") $(brief "$(body "$r")")"
CONSENT_ID=$(jq_ "$(body "$r")" "[c for c in d if c['clientId']=='$CID_B'][0]['id']")
[ -n "$CONSENT_ID" ] && [ "$CONSENT_ID" != "None" ] && pass "application B is in the owner's list" || fail "application B missing from the consents list"
[ "$(jq_ "$(body "$r")" "[c for c in d if c['clientId']=='$CID_A']")" = "[]" ] && pass "the REVOKED application A is not listed" || fail "revoked application still listed"
[ "$(jq_ "$(body "$r")" "', '.join([c for c in d if c['clientId']=='$CID_B'][0]['receives'])")" = "your name, your work email address, which organisation you belong to, access to your information when you are not using the application" ] && pass "each row says in words what the application receives" || fail "receives: $(brief "$(body "$r")")"
printf '%s' "$(body "$r")" | grep -q "$SEC_B" && fail "the consents list carries a client secret" || pass "no secret in the list"
# Another person cannot remove it: HR's token, the owner's consent id.
h=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/api/auth/oauth/consents/$CONSENT_ID" -H "Authorization: Bearer $TOKEN")
[ "$h" = "404" ] && pass "another person removing it: 404, not found rather than refused" || fail "cross-person remove answered $h"
r=$(curl -s -w '\n%{http_code}' -X DELETE "$API/api/auth/oauth/consents/$CONSENT_ID" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "200" ] && pass "the owner removes it (200)" || fail "remove: $(status "$r") $(brief "$(body "$r")")"
[ "$(jq_ "$(body "$r")" "d['revokedTokens']")" -ge 2 ] 2>/dev/null && pass "its tokens were revoked with it" || fail "revokedTokens: $(brief "$(body "$r")")"
r=$(token -d grant_type=refresh_token -d "refresh_token=$REFRESH12" -d "client_id=$CID_B" -d "client_secret=$SEC_B")
[ "$(jq_ "$(body "$r")" "d.get('error','')")" = "invalid_grant" ] && pass "the application's refresh token: invalid_grant" || fail "refresh after remove: $(status "$r") $(brief "$(body "$r")")"
[ "$(userinfo "$ACCESS12")" = "401" ] && pass "its still-unexpired access token: 401" || fail "userinfo after remove: $(userinfo "$ACCESS12")"
pkce; URL12b=$(authorize_url "$CID_B" "$RP" "s12b$RUN" "n12b$RUN" "$CHALLENGE")
authorize "$JAR_A" "$URL12b"
[ "$HTTP_CODE" = "302" ] && [[ "$LOCATION" == */oauth/consent?* ]] && pass "the next sign-in through B asks for consent again" || fail "after remove, authorize: $HTTP_CODE → ${LOCATION%%\?*}"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.consent_removed' AND target_id='$CONSENT_ID'")
[ "${n:-0}" -ge 1 ] && pass "the removal is in the audit log" || fail "no audit row for the removal"

# "Allowed for everyone" and a personal Remove (CTO's question, 17 Sept):
# the row says why instead of a button, and the endpoint refuses, because
# authorize would silently re-create the consent at the next sign-in.
authorize "$JAR_A" "$URL12b" allow; CODE12b=$(code_from "$LOCATION"); remember "$CODE12b"
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications/$APP_B/consent" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" -d '{"allowedForEveryone":true}')
[ "$(status "$r")" = "200" ] && pass "application B switched to allowed for everyone" || fail "consent switch: $(status "$r") $(brief "$(body "$r")")"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.application_consent_changed' AND target_id='$APP_B'")
[ "${n:-0}" -ge 1 ] && pass "…and the switch is in the audit log (0004)" || fail "no audit row for the consent switch"
r=$(curl -s "$API/api/auth/oauth/consents" -H "Authorization: Bearer $OWNER_TOKEN")
CONSENT_B=$(jq_ "$r" "[c for c in d if c['clientId']=='$CID_B'][0]['id']")
[ "$(jq_ "$r" "[c for c in d if c['clientId']=='$CID_B'][0]['allowedForEveryone']")" = "True" ] && pass "the person's list marks it as approved for everyone" || fail "allowedForEveryone flag missing: $(brief "$r")"
r=$(curl -s -w '\n%{http_code}' -X DELETE "$API/api/auth/oauth/consents/$CONSENT_B" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "409" ] && pass "a personal Remove is refused (409) with the reason, not granted and silently undone" || fail "remove under allowed-for-everyone: $(status "$r") $(brief "$(body "$r")")"
r=$(token -d grant_type=authorization_code -d "code=$CODE12b" -d "redirect_uri=$RP" -d "client_id=$CID_B" -d "client_secret=$SEC_B" -d "code_verifier=$VERIFIER")
[ "$(status "$r")" = "200" ] && pass "the consent still stands: the code from before the switch redeems" || fail "code after the switch: $(status "$r")"
remember "$(jq_ "$(body "$r")" "d.get('access_token','')")"; remember "$(jq_ "$(body "$r")" "d.get('refresh_token','')")"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
curl -s -o /dev/null -X POST "$API/api/org/applications/$APP_B/consent" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" -d '{"allowedForEveryone":false}'

# ===========================================================================
step "13. The scope ticks are real, and a new secret retires the old one"
# An application the administrator gave ONE thing: the name. No email, no
# offline_access. If the ticks were decorative every check below passes
# anyway, which is why this step exists (CTO, 18 Sept).
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" \
    -d "{\"name\":\"Least privilege $RUN\",\"redirectUris\":[\"$RP\"],\"confidential\":true,\"scopes\":[\"profile\"]}")
[ "$(status "$r")" = "201" ] && pass "registered with only 'profile' ticked" || fail "create: $(status "$r") $(brief "$(body "$r")")"
APP_C=$(jq_ "$(body "$r")" "d['id']"); CID_C=$(jq_ "$(body "$r")" "d['clientId']"); SEC_C=$(jq_ "$(body "$r")" "d['clientSecret']")
remember "$SEC_C"
[ "$(jq_ "$(body "$r")" "','.join(d['scopes'])")" = "profile" ] && pass "the response names just that one" || fail "scopes: $(brief "$(body "$r")")"

# An unknown scope name is refused, not quietly dropped.
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" \
    -d "{\"name\":\"Bad scope $RUN\",\"redirectUris\":[\"$RP\"],\"scopes\":[\"profile\",\"payroll\"]}")
[ "$(status "$r")" = "400" ] && pass "an unknown scope is refused with a sentence" || fail "unknown scope answered $(status "$r")"

# THE CHECK THE TICKS EXIST FOR: asking for an unticked scope is refused.
#
# WHICH ASSERTION CARRIES THE CLAIM, learned from calibrating this step
# (rule 6, 18 Sept 2026): with the ticks made decorative, ONLY this refusal
# goes red. The "ID token carries no email" and "no refresh token" checks
# below ask for `openid profile` and would pass either way, because claims
# follow the REQUESTED scope, not the granted permission. They are worth
# keeping - they prove the claims track the request - but they prove nothing
# about the tick. This refusal is the whole of that evidence.
pkce; URL13=$(authorize_url "$CID_C" "$RP" "s13$RUN" "n13$RUN" "$CHALLENGE" "openid profile email")
authorize "$JAR_A" "$URL13"
[[ "$LOCATION" != *code=* ]] && pass "asking for the UNTICKED email scope: no code" || fail "LEAK: an unticked scope was granted"
# HOW it refuses, measured rather than assumed: OpenIddict answers on our
# own page with 400 invalid_scope rather than redirecting the error to the
# application. That is the stricter of the two and matches step 6's
# treatment of a bad redirect URI - nothing is sent to the application at
# all. Asserted as it behaves, so a change of behaviour is a red here.
[ "$HTTP_CODE" = "400" ] && [ -z "$LOCATION" ] && pass "…refused on TatvaOS with 400, nothing sent to the application" || fail "unticked scope: $HTTP_CODE -> ${LOCATION%%\?*}"
pkce; URL13b=$(authorize_url "$CID_C" "$RP" "s13b$RUN" "n13b$RUN" "$CHALLENGE" "openid profile offline_access")
authorize "$JAR_A" "$URL13b"
[[ "$LOCATION" != *code=* ]] && pass "asking for UNTICKED offline_access: no code" || fail "LEAK: offline_access granted without the tick"

# What was ticked still works, and the ID token carries no email.
pkce; V13=$VERIFIER; URL13c=$(authorize_url "$CID_C" "$RP" "s13c$RUN" "n13c$RUN" "$CHALLENGE" "openid profile")
authorize "$JAR_A" "$URL13c"; [[ "$LOCATION" == */oauth/consent?* ]] && authorize "$JAR_A" "$URL13c" allow
CODE13=$(code_from "$LOCATION"); remember "$CODE13"
r=$(token -d grant_type=authorization_code -d "code=$CODE13" -d "redirect_uri=$RP" -d "client_id=$CID_C" -d "client_secret=$SEC_C" -d "code_verifier=$V13")
[ "$(status "$r")" = "200" ] && pass "the ticked scope works" || fail "ticked scope: $(status "$r") $(brief "$(body "$r")")"
ID13=$(jq_ "$(body "$r")" "d.get('id_token','')"); ACCESS13=$(jq_ "$(body "$r")" "d.get('access_token','')")
remember "$ID13"; remember "$ACCESS13"
[ "$(jq_ "$(body "$r")" "'refresh_token' in d")" = "False" ] && pass "no refresh token, because offline_access was not ticked" || fail "a refresh token was issued without the tick"
claim=$("$PY" -c "import sys,json,base64; p=sys.argv[1].split('.')[1]; p+='='*(-len(p)%4); d=json.loads(base64.urlsafe_b64decode(p)); print(d.get('email','(none)'), '|', d.get('name','(none)'))" "$ID13")
[ "${claim%% *}" = "(none)" ] && pass "the ID token carries NO email — the untick reached the claims" || fail "ID token email: $claim"
[ "${claim##*| }" = "Amit Dadhich" ] && pass "and it does carry the name, which was ticked" || fail "ID token name: $claim"
r=$(userinfo_body "$ACCESS13")
[ "$(jq_ "$r" "d.get('email','(none)')")" = "(none)" ] && pass "userinfo withholds the email too" || fail "userinfo leaked the email: $r"

# The consent screen offers the person the same words.
r=$(curl -s "$API/api/auth/oauth/consent?client_id=$CID_C&redirect_uri=$(urlenc "$RP")&scope=openid%20profile" -H "Authorization: Bearer $OWNER_TOKEN")
printf '%s' "$r" | grep -q "work email address" && fail "consent details mention the email this app cannot have" || pass "consent details name only what it may receive"

# A new secret retires the old one, at once.
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/org/applications/$APP_C/secret" -H "Authorization: Bearer $OWNER_TOKEN")
[ "$(status "$r")" = "200" ] && pass "a new secret is issued" || fail "regenerate: $(status "$r") $(brief "$(body "$r")")"
SEC_C2=$(jq_ "$(body "$r")" "d['clientSecret']"); remember "$SEC_C2"
[ -n "$SEC_C2" ] && [ "$SEC_C2" != "$SEC_C" ] && pass "…and it is a different secret" || fail "the secret did not change"
pkce; V13d=$VERIFIER; URL13d=$(authorize_url "$CID_C" "$RP" "s13d$RUN" "n13d$RUN" "$CHALLENGE" "openid profile")
authorize "$JAR_A" "$URL13d"; CODE13d=$(code_from "$LOCATION"); remember "$CODE13d"
r=$(token -d grant_type=authorization_code -d "code=$CODE13d" -d "redirect_uri=$RP" -d "client_id=$CID_C" -d "client_secret=$SEC_C" -d "code_verifier=$V13d")
[ "$(status "$r")" != "200" ] && pass "the OLD secret is refused from that moment" || fail "the old secret still works"
pkce; V13e=$VERIFIER; URL13e=$(authorize_url "$CID_C" "$RP" "s13e$RUN" "n13e$RUN" "$CHALLENGE" "openid profile")
authorize "$JAR_A" "$URL13e"; CODE13e=$(code_from "$LOCATION"); remember "$CODE13e"
r=$(token -d grant_type=authorization_code -d "code=$CODE13e" -d "redirect_uri=$RP" -d "client_id=$CID_C" -d "client_secret=$SEC_C2" -d "code_verifier=$V13e")
[ "$(status "$r")" = "200" ] && pass "the new secret works" || fail "new secret: $(status "$r") $(brief "$(body "$r")")"
remember "$(jq_ "$(body "$r")" "d.get('access_token','')")"; remember "$(jq_ "$(body "$r")" "d.get('id_token','')")"
n=$(PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.application_secret_regenerated' AND target_id='$APP_C'")
[ "${n:-0}" -ge 1 ] && pass "the regeneration is in the audit log" || fail "no audit row for the new secret"
r=$(curl -s "$API/api/org/applications" -H "Authorization: Bearer $OWNER_TOKEN")
printf '%s' "$r" | grep -q "$SEC_C2" && fail "the list carries the new secret" || pass "the list still never carries a secret"

printf '\n%s%s%s\n  %s%d passed%s, ' "$CYAN" "----------------------------------------" "$RST" "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n\n' "$GREEN" "$RST" || printf '%s%d failed%s\n\n' "$RED" "$FAILED" "$RST"
[ "$FAILED" -eq 0 ]
