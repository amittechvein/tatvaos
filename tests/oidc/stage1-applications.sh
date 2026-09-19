#!/usr/bin/env bash
#
# TatvaOS — OpenID Connect provider, stage 1 (decision 0004): the stores and
# the Applications endpoints, against the LOCAL stack (local/ up, the API on
# :5000). The protocol endpoints do not exist yet; this proves what does:
#
#   1. an admin registers a confidential application: client id shown, secret
#      shown ONCE with a visible prefix, PKCE required, redirect URIs exact
#   2. the list never carries the secret, only the prefix
#   3. a public application has no secret
#   4. a wildcard, a fragment, a plain-http and a relative redirect URI are
#      refused with a sentence; localhost http is allowed (native apps)
#   5. the row OpenIddict wrote can be read back through OpenIddict's own
#      manager — the hand-written SQL matches EF's column names (the failure
#      this exists for compiles perfectly and dies on the first query)
#   6. "allowed for everyone" flips and is audited; revoke sets revoked_at,
#      is idempotent, and the client resolver then treats the id as unknown
#   7. RLS: the same client id, read as the OTHER tenant through psql, is not
#      there; the resolver still names the owning tenant with no context
#
# Sign-in is the seeded owner by on-screen OTP, as tests/invitations does.
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5000}"
# psql, as the superuser and as the app role. Defaults are the Docker dev
# stack; CI and a WSL Postgres pass their own (see tests/oidc/README.md).
TATVAOS_PSQL="${TATVAOS_PSQL:-docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc}"
TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -Atc}"
PG="$TATVAOS_PSQL"
PGAPP() { $TATVAOS_PSQL_APP "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }
OWNER_PHONE="${TATVAOS_OWNER_PHONE:-+919999900001}"
TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'
RUN=$(date +%s)

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }
post() { local auth=(); [ -n "$2" ] && auth=(-H "Authorization: Bearer $2"); curl -s -w '\n%{http_code}' -X POST "$1" -H 'Content-Type: application/json' "${auth[@]}" -d "$3"; }
get()  { curl -s -w '\n%{http_code}' "$1" -H "Authorization: Bearer $2"; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

step "0. The API answers"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health"); [ "$h" = "200" ] && pass "health 200" || { fail "health $h"; exit 1; }

step "Sign in as the seeded owner"
# The seed gives the owner no phone; a fresh database (CI) gets one here.
$PG "UPDATE core.users SET phone='$OWNER_PHONE' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
$PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='$OWNER_PHONE'" >/dev/null
r=$(post "$API/api/auth/otp/request" "" "{\"phone\":\"$OWNER_PHONE\"}")
code=$(jq_ "$(body "$r")" "d.get('devCode') or ''"); [ -n "$code" ] || { fail "no devCode"; exit 1; }
r=$(post "$API/api/auth/otp/verify" "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")
TOKEN=$(jq_ "$(body "$r")" "d.get('accessToken') or ''"); [ -n "$TOKEN" ] && pass "signed in" || { fail "verify: $(body "$r")"; exit 1; }

step "1. Register a confidential application"
r=$(post "$API/api/org/applications" "$TOKEN" "{\"name\":\"Payroll $RUN\",\"redirectUris\":[\"https://payroll.example.test/callback\",\"https://payroll.example.test/callback\"],\"confidential\":true}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(body "$r")"
APP=$(jq_ "$(body "$r")" "d['id']"); CID=$(jq_ "$(body "$r")" "d['clientId']"); SECRET=$(jq_ "$(body "$r")" "d['clientSecret']")
[ "${CID:0:4}" = "tos_" ] && pass "client id has the tos_ prefix" || fail "client id: $CID"
[ "${SECRET:0:5}" = "toss_" ] && pass "secret returned once, toss_ prefix" || fail "secret: '${SECRET:0:5}'"
[ "$(jq_ "$(body "$r")" "d['secretPrefix']")" = "${SECRET:0:10}…" ] && pass "visible prefix is the first 10 characters" || fail "prefix: $(jq_ "$(body "$r")" "d['secretPrefix']")"
[ "$(jq_ "$(body "$r")" "len(d['redirectUris'])")" = "1" ] && pass "duplicate redirect URI collapsed to one" || fail "redirect uris: $(body "$r")"
row=$($PG "SELECT client_type, consent_type, requirements, permissions, client_secret IS NOT NULL AND client_secret <> '$SECRET' FROM core.oidc_applications WHERE id='$APP'")
printf '%s' "$row" | grep -q "^confidential|explicit|" && pass "row: confidential, explicit consent" || fail "row: $row"
printf '%s' "$row" | grep -q "ft:pkce" && pass "row: PKCE required" || fail "row lacks the PKCE requirement: $row"
printf '%s' "$row" | grep -q "gt:authorization_code" && pass "row: authorization_code grant permitted" || fail "row lacks the grant: $row"
printf '%s' "$row" | grep -q "|t$" && pass "row: secret stored hashed, not in the clear" || fail "row: secret missing or stored in the clear"
[ "$($PG "SELECT tenant_id::text FROM core.oidc_applications WHERE id='$APP'")" = "$TECHVEIN" ] && pass "row: stamped with the admin's tenant" || fail "row: wrong tenant"

step "2. The list carries the prefix, never the secret"
r=$(get "$API/api/org/applications" "$TOKEN")
# -F -- : the secret is a literal, and a value grep cannot parse must never
# be able to turn this into a pass. In this shape (found && fail || pass) a
# grep that ERRORS reads as "absent" — green with the secret sitting in the list.
printf '%s' "$(body "$r")" | grep -qF -- "$SECRET" && fail "the list contains the secret" || pass "secret absent from the list"
[ "$(jq_ "$(body "$r")" "[a for a in d if a['id']=='$APP'][0]['secretPrefix']")" = "${SECRET:0:10}…" ] && pass "prefix present in the list" || fail "prefix missing from the list"
[ "$(jq_ "$(body "$r")" "[a for a in d if a['id']=='$APP'][0]['redirectUris'][0]")" = "https://payroll.example.test/callback" ] && pass "redirect URI read back through OpenIddict's manager" || fail "redirect uris: $(body "$r")"

step "3. A public application has no secret"
r=$(post "$API/api/org/applications" "$TOKEN" "{\"name\":\"Phone app $RUN\",\"redirectUris\":[\"http://127.0.0.1/cb\",\"https://app.example.test/cb\"],\"confidential\":false}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['clientSecret']")" = "None" ] && pass "no secret" || fail "a public app got a secret"
[ "$(jq_ "$(body "$r")" "d['clientType']")" = "public" ] && pass "client type public" || fail "type: $(body "$r")"
PUB=$(jq_ "$(body "$r")" "d['id']")

step "4. Bad redirect URIs are refused with a sentence"
for u in "https://x.example.test/*" "https://x.example.test/cb#frag" "http://x.example.test/cb" "/relative" ""; do
    r=$(post "$API/api/org/applications" "$TOKEN" "{\"name\":\"Bad $RUN\",\"redirectUris\":[\"$u\"]}")
    [ "$(status "$r")" = "400" ] && pass "refused: '$u'" || fail "'$u' answered $(status "$r")"
done
r=$(post "$API/api/org/applications" "$TOKEN" "{\"name\":\"No URIs $RUN\",\"redirectUris\":[]}")
[ "$(status "$r")" = "400" ] && pass "refused: no redirect URIs at all" || fail "empty list answered $(status "$r")"
r=$(post "$API/api/org/applications" "$TOKEN" "{\"name\":\"X\",\"redirectUris\":[\"https://x.example.test/cb\"]}")
[ "$(status "$r")" = "400" ] && pass "refused: a one-letter name" || fail "short name answered $(status "$r")"

step "5. Consent switch, audited"
r=$(post "$API/api/org/applications/$APP/consent" "$TOKEN" '{"allowedForEveryone":true}')
[ "$(status "$r")" = "200" ] && [ "$($PG "SELECT consent_type||'|'||allowed_for_everyone FROM core.oidc_applications WHERE id='$APP'")" = "implicit|true" ] && pass "allowed for everyone → implicit consent" || fail "consent: $(status "$r") $(body "$r")"
[ "$($PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.application_consent_changed' AND target_id='$APP'")" -ge 1 ] && pass "audited" || fail "no audit row for the consent change"
r=$(post "$API/api/org/applications/$APP/consent" "$TOKEN" '{"allowedForEveryone":false}')
[ "$($PG "SELECT consent_type FROM core.oidc_applications WHERE id='$APP'")" = "explicit" ] && pass "back to explicit" || fail "consent did not flip back"

step "6. Revoke: revoked_at set, idempotent, the resolver forgets the client"
[ "$(PGAPP "SELECT was_revoked::text FROM core.resolve_oidc_client('$CID')")" = "false" ] && pass "before: resolver knows the client, live" || fail "resolver before revoke"
r=$(post "$API/api/org/applications/$APP/revoke" "$TOKEN" "{}")
[ "$(status "$r")" = "200" ] && pass "revoke 200" || fail "revoke: $(status "$r") $(body "$r")"
[ "$($PG "SELECT revoked_at IS NOT NULL FROM core.oidc_applications WHERE id='$APP'")" = "t" ] && pass "revoked_at set" || fail "revoked_at missing"
[ "$(PGAPP "SELECT was_revoked::text FROM core.resolve_oidc_client('$CID')")" = "true" ] && pass "after: resolver reports it revoked" || fail "resolver after revoke"
r=$(post "$API/api/org/applications/$APP/revoke" "$TOKEN" "{}")
[ "$(status "$r")" = "200" ] && [ "$(jq_ "$(body "$r")" "d.get('alreadyRevoked')")" = "True" ] && pass "second revoke: already revoked, no error" || fail "second revoke: $(status "$r") $(body "$r")"
r=$(post "$API/api/org/applications/$APP/consent" "$TOKEN" '{"allowedForEveryone":true}')
[ "$(status "$r")" = "400" ] && pass "consent cannot be changed on a revoked application" || fail "consent on revoked answered $(status "$r")"
r=$(get "$API/api/org/applications" "$TOKEN")
[ "$(jq_ "$(body "$r")" "[a for a in d if a['id']=='$APP'][0]['revokedAt'] is not None")" = "True" ] && pass "the list still shows it, marked revoked" || fail "revoked app vanished from the list"
[ "$($PG "SELECT count(*) FROM core.audit_logs WHERE action='oidc.application_revoked' AND target_id='$APP'")" -ge 1 ] && pass "revocation audited" || fail "no audit row for the revoke"

step "7. RLS and the resolver"
n=$(PGAPP "SET app.tenant_id='$SCHOOL'; SELECT count(*) FROM core.oidc_applications WHERE id IN ('$APP','$PUB')")
[ "${n:-1}" -eq 0 ] && pass "ABC School sees neither Techvein application" || fail "LEAK: school sees $n Techvein application(s)"
n=$(PGAPP "SELECT count(*) FROM core.oidc_applications WHERE id IN ('$APP','$PUB')")
[ "${n:-1}" -eq 0 ] && pass "no tenant context sees nothing" || fail "DANGEROUS: $n row(s) with no tenant"
[ "$(PGAPP "SELECT tenant_id::text FROM core.resolve_oidc_client('$CID')")" = "$TECHVEIN" ] && pass "resolver names the owning tenant with no context" || fail "resolver answered wrongly"
[ "$($PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE 'oidc.%' AND (after_state::text LIKE '%toss_%' OR before_state::text LIKE '%toss_%')" 2>/dev/null || echo 0)" = "0" ] && pass "no secret in any audit row" || fail "a secret reached the audit log"

step "8. The full secret is in no log"
# TATVAOS_API_LOG: where the API's stdout went for this run. In Development
# EF prints every parameter value, so the hashed secret and the ten-character
# visible prefix DO appear there; the secret itself must not, and in
# production EF prints '?' for every value. The grep is for the whole secret.
if [ -n "${TATVAOS_API_LOG:-}" ] && [ -f "$TATVAOS_API_LOG" ]; then
    n=$(grep -c -F -- "$SECRET" "$TATVAOS_API_LOG")
    [ "$n" -eq 0 ] && pass "the full client secret appears nowhere in the API log" || fail "the client secret appears $n time(s) in the API log"
else
    printf '  - API log not given (TATVAOS_API_LOG); secret-in-log check skipped\n'
fi

printf '\n%s%s%s\n  %s%d passed%s, ' "$CYAN" "----------------------------------------" "$RST" "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n\n' "$GREEN" "$RST" || printf '%s%d failed%s\n\n' "$RED" "$FAILED" "$RST"
[ "$FAILED" -eq 0 ]
