#!/usr/bin/env bash
#
# TatvaOS — OpenID Connect provider, stage 2 (decision 0004): keys, discovery,
# the key set, and rotation exercised for real.
#
# Runs the API itself, three times, against an EMPTY key directory it makes
# under TMPDIR, so nothing in this script can touch a real key:
#
#   run 1  first start: a signing and an encryption key are generated;
#          discovery answers with the issuer and the jwks_uri; the key set
#          publishes exactly one RSA signing key with a 16-char kid and RS256;
#          the encryption key is NOT published
#   rotate `--oidc-rotate` against the same directory: a new active key file,
#          the old one renamed retired, nothing private printed
#   run 2  the key set publishes TWO keys, the new one first (it signs); the
#          old kid is still there so anything it signed still verifies
#   run 3  after the retired marker is moved two days into the past: the old
#          key is deleted on start and the key set is back to one
#
# Needs: dotnet, a built Release API, python. The database is not touched —
# but the API opens it on start, so local/ must be up.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_OIDC_TEST_PORT:-5077}"
API="http://localhost:$PORT"
ISSUER="https://core.tatvaos.com"
# On a Windows laptop the API is a Windows process: give it a path it can
# resolve (Git Bash's /tmp is not one). The scratch root is under the repo's
# ignored .tmp so it exists on every machine; wiped on exit.
SCRATCH="$ROOT/.tmp/oidc-stage2-$$"
mkdir -p "$SCRATCH"
if command -v cygpath >/dev/null 2>&1; then KEYDIR="$(cygpath -w "$SCRATCH")\keys"; else KEYDIR="$SCRATCH/keys"; fi
KEYDIR_BASH="$SCRATCH/keys"
LOG="$SCRATCH/api.log"

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

export JWT_SIGNING_KEY='dev-only-key-at-least-32-characters-long'
export ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export Oidc__KeyDirectory="$KEYDIR" Oidc__Issuer="$ISSUER"
export Smtp__Host=localhost Smtp__Port=5870

API_PID=""
start_api() {
    dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
    API_PID=$!
    for _ in $(seq 1 120); do
        curl -s -o /dev/null -w '%{http_code}' "$API/health" 2>/dev/null | grep -q 200 && return 0
        sleep 1
    done
    fail "the API did not answer on $API within 120s — tail of its log:"; tail -5 "$LOG"; return 1
}
stop_api() {
    [ -n "$API_PID" ] || return 0
    # dotnet run spawns the real process; kill by port so the child dies too.
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
    else
        fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    fi
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" 2>/dev/null || true
    API_PID=""
}
trap 'stop_api; rm -rf "$SCRATCH"' EXIT

# ---------------------------------------------------------------------------
step "Run 1 — first start against an empty key directory"
start_api || exit 1
sigs=$(ls "$KEYDIR_BASH" | grep -c '^sig-[0-9]*\.pem$'); encs=$(ls "$KEYDIR_BASH" | grep -c '^enc-[0-9]*\.pem$')
[ "$sigs" = "1" ] && pass "one signing key file generated" || fail "$sigs signing key files"
[ "$encs" = "1" ] && pass "one encryption key file generated" || fail "$encs encryption key files"
grep -q "BEGIN PRIVATE KEY" "$KEYDIR_BASH"/sig-*.pem && pass "signing key is a PKCS#8 PEM" || fail "signing key file is not a PEM"
grep -q "PRIVATE KEY" "$LOG" && fail "private key material reached the log" || pass "no private key material in the log"

disc=$(curl -s "$API/.well-known/openid-configuration")
[ "$(printf '%s' "$disc" | j "d['issuer']")" = "$ISSUER/" ] && pass "discovery: issuer $ISSUER/" || fail "discovery issuer: $(printf '%s' "$disc" | j "d.get('issuer')")"
# Every advertised URL is PINNED to the issuer: it must read
# https://core.tatvaos.com/… whatever host this request arrived on (here,
# localhost with no proxy at all), and whatever a forwarded header claims.
[ "$(printf '%s' "$disc" | j "d['jwks_uri']")" = "$ISSUER/api/oauth/jwks" ] && pass "discovery: jwks_uri pinned to the issuer" || fail "jwks_uri: $(printf '%s' "$disc" | j "d.get('jwks_uri')")"
[ "$(printf '%s' "$disc" | j "d['authorization_endpoint']")" = "$ISSUER/oauth/authorize" ] && pass "discovery: authorize pinned to the issuer, at the web page (stage 3)" || fail "authorization_endpoint: $(printf '%s' "$disc" | j "d.get('authorization_endpoint')")"
[ "$(printf '%s' "$disc" | j "d['token_endpoint']")" = "$ISSUER/api/oauth/token" ] && pass "discovery: token pinned to the issuer" || fail "token_endpoint: $(printf '%s' "$disc" | j "d.get('token_endpoint')")"
printf '%s' "$disc" | grep -q "localhost" && fail "the request's own host leaked into the document" || pass "discovery: nothing in the document names the request's host"
# As Caddy sends it (scheme and host forwarded): same document, byte for byte.
fwd=$(curl -s -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: core.tatvaos.com" "$API/.well-known/openid-configuration")
[ "$fwd" = "$disc" ] && pass "forwarded headers from Caddy: the document is unchanged" || fail "the document differs when Caddy's headers are present"
# ISSUER CONFUSION: a caller that could set the forwarded host must not be
# able to move the issuer or any endpoint. Red first: with the absolute URIs
# removed from Program.cs this check fails, because OpenIddict then builds
# the URLs from the (spoofed) request.
evil=$(curl -s -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: evil.example" "$API/.well-known/openid-configuration")
[ "$(printf '%s' "$evil" | j "d['issuer']")" = "$ISSUER/" ] && pass "spoofed host: issuer unchanged" || fail "spoofed host moved the issuer: $(printf '%s' "$evil" | j "d.get('issuer')")"
printf '%s' "$evil" | grep -q "evil.example" && fail "spoofed host appears in the document" || pass "spoofed host: no advertised URL follows it"
[ "$evil" = "$disc" ] && pass "spoofed host: the document is unchanged, byte for byte" || fail "the document differs under a spoofed host"
[ "$(printf '%s' "$disc" | j "'S256' in d.get('code_challenge_methods_supported',[]) and 'plain' not in d.get('code_challenge_methods_supported',[])")" = "True" ] && pass "discovery: PKCE S256 only" || fail "code_challenge_methods_supported: $(printf '%s' "$disc" | j "d.get('code_challenge_methods_supported')")"
[ "$(printf '%s' "$disc" | j "sorted(d.get('grant_types_supported',[]))")" = "['authorization_code', 'refresh_token']" ] && pass "discovery: code and refresh grants only" || fail "grant_types_supported: $(printf '%s' "$disc" | j "d.get('grant_types_supported')")"
[ "$(printf '%s' "$disc" | j "d.get('response_types_supported')")" = "['code']" ] && pass "discovery: response_type code only" || fail "response_types_supported: $(printf '%s' "$disc" | j "d.get('response_types_supported')")"
# The endpoints exist and answer honestly before stage 3 builds sign-in.
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/auth/oauth/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fa.b%2Fc")
[ "$h" = "501" ] || [ "$h" = "400" ] && pass "authorize answers $h, not a hang or a 500" || fail "authorize answered $h"
h=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/oauth/token" -d "grant_type=authorization_code&code=x&client_id=nobody")
[ "$h" = "400" ] || [ "$h" = "401" ] && pass "token endpoint refuses an unknown client ($h)" || fail "token endpoint answered $h"

jwks=$(curl -s "$API/api/oauth/jwks")
[ "$(printf '%s' "$jwks" | j "len(d['keys'])")" = "1" ] && pass "key set: exactly one key" || fail "key set: $(printf '%s' "$jwks" | j "len(d['keys'])") keys"
[ "$(printf '%s' "$jwks" | j "d['keys'][0]['kty']")" = "RSA" ] && pass "key set: RSA" || fail "kty: $(printf '%s' "$jwks" | j "d['keys'][0].get('kty')")"
[ "$(printf '%s' "$jwks" | j "d['keys'][0]['use']")" = "sig" ] && pass "key set: use=sig" || fail "use: $(printf '%s' "$jwks" | j "d['keys'][0].get('use')")"
[ "$(printf '%s' "$jwks" | j "d['keys'][0].get('alg')")" = "RS256" ] && pass "key set: alg RS256" || fail "alg: $(printf '%s' "$jwks" | j "d['keys'][0].get('alg')")"
KID1=$(printf '%s' "$jwks" | j "d['keys'][0]['kid']")
[ "${#KID1}" = "16" ] && pass "key set: 16-character kid" || fail "kid: '$KID1'"
printf '%s' "$jwks" | j "'d' in d['keys'][0] or 'p' in d['keys'][0]" | grep -q "False" && pass "key set: public parameters only" || fail "PRIVATE parameters in the published key set"
grep -qF -- "signing with $KID1" "$LOG" && pass "the API says it signs with $KID1" || fail "the API's startup line does not name $KID1"
stop_api

# ---------------------------------------------------------------------------
step "Rotate — the runbook's one step, against the same directory"
out=$(dotnet run --no-build -c Release --project "$PROJ" -- --oidc-rotate 2>&1)
printf '%s\n' "$out" | grep -q "new signing key" && pass "rotate reports a new active key" || fail "rotate output: $out"
# A kid is random base64url and CAN BEGIN WITH '-', and here it begins the
# pattern. "--" stops grep reading it as options; -F because it is a literal.
# Without them (CI run 35440205300, 19 Sept 2026, kid -aOPhKn-EgyXptRJ) grep
# died with "unknown option", which this line shape reports as a plain FAIL:
# "rotate did not retire <kid>", printed beside output saying it had. One run
# in 64, and a re-run passes, so it reads as flakiness rather than as a bug.
printf '%s\n' "$out" | grep -qF -- "$KID1 retired" && pass "rotate names $KID1 as retired" || fail "rotate did not retire $KID1: $out"
printf '%s\n' "$out" | grep -q "PRIVATE KEY" && fail "rotate printed private material" || pass "rotate printed nothing private"
[ "$(ls "$KEYDIR_BASH" | grep -c '^sig-[0-9]*\.pem$')" = "1" ] && pass "one active signing key file" || fail "active files: $(ls "$KEYDIR_BASH")"
[ "$(ls "$KEYDIR_BASH" | grep -c '^sig-[0-9]*\.retired-[0-9]*\.pem$')" = "1" ] && pass "one retired signing key file" || fail "retired files: $(ls "$KEYDIR_BASH")"

step "Run 2 — both keys published, the new one first"
start_api || exit 1
jwks=$(curl -s "$API/api/oauth/jwks")
[ "$(printf '%s' "$jwks" | j "len(d['keys'])")" = "2" ] && pass "key set: two keys" || fail "key set: $(printf '%s' "$jwks" | j "len(d['keys'])") keys"
KID2=$(printf '%s' "$jwks" | j "d['keys'][0]['kid']")
[ "$KID2" != "$KID1" ] && pass "first key is the new one ($KID2)" || fail "first key is still $KID1"
[ "$(printf '%s' "$jwks" | j "d['keys'][1]['kid']")" = "$KID1" ] && pass "retired $KID1 still published" || fail "retired key missing from the set"
grep -qF -- "signing with $KID2" "$LOG" && pass "the API signs with the new key" || fail "the API does not say it signs with $KID2"
stop_api

# ---------------------------------------------------------------------------
step "Run 3 — a retired key past its day is deleted on start"
old=$(ls "$KEYDIR_BASH" | grep '^sig-[0-9]*\.retired-[0-9]*\.pem$' | head -1)
created=$(printf '%s' "$old" | sed -E 's/^sig-([0-9]+)\.retired-.*/\1/')
twodaysago=$(( $(date +%s) - 2*24*3600 ))
mv "$KEYDIR_BASH/$old" "$KEYDIR_BASH/sig-$created.retired-$twodaysago.pem"
start_api || exit 1
[ "$(ls "$KEYDIR_BASH" | grep -c 'retired')" = "0" ] && pass "retired key file deleted" || fail "retired file survived: $(ls "$KEYDIR_BASH")"
jwks=$(curl -s "$API/api/oauth/jwks")
[ "$(printf '%s' "$jwks" | j "len(d['keys'])")" = "1" ] && [ "$(printf '%s' "$jwks" | j "d['keys'][0]['kid']")" = "$KID2" ] && pass "key set back to one key, $KID2" || fail "key set after retirement: $jwks"
grep -q "retired signing key file .* deleted" "$LOG" && pass "the deletion was logged, by file name only" || fail "no deletion line in the log"
stop_api

printf '\n%s%s%s\n  %s%d passed%s, ' "$CYAN" "----------------------------------------" "$RST" "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n\n' "$GREEN" "$RST" || printf '%s%d failed%s\n\n' "$RED" "$FAILED" "$RST"
[ "$FAILED" -eq 0 ]
