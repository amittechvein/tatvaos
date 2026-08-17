#!/usr/bin/env bash
# ============================================================================
#  Why can this one account not sign in?
#
#      bash infra/scripts/diagnose-login.sh
#
#  READ-ONLY against the database. It changes nothing.
#
#  Written because "the password does not work" has at least five distinct
#  causes that the sign-in screen deliberately cannot tell apart — a generic
#  failure message is a security property (see LoginAsync: an unknown address
#  is even hashed against a dummy so it takes the same time as a wrong
#  password). That is right for a stranger and useless for the operator, so
#  this reads the row directly and says which one it actually is.
#
#  The optional live test at the end prints the API's real response, which is
#  the only thing that distinguishes 401 (wrong password) from 429 (locked
#  out) from a 200 that is really an MFA challenge and not a session at all.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
SITE=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
API="https://${SITE:-core.tatvaos.com}/api"

q()    { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1; }
sqlq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

printf 'Address to diagnose: '
read -r EMAIL
EMAIL=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
E=$(sqlq "$EMAIL")

exists=$(q "SELECT count(*) FROM core.users WHERE email = $E")
if [ "${exists:-0}" = "0" ]; then
    echo
    echo "  No row with that address at all — so every attempt is a 401 no matter"
    echo "  what is typed. core.users.email is citext UNIQUE, so this is not a"
    echo "  case-sensitivity or duplicate-row problem."
    echo
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail \
        -c "SELECT email, role, status FROM core.users ORDER BY role, email LIMIT 30" 2>/dev/null
    exit 1
fi

echo
echo "== the account =="
# stderr is NOT swallowed here. If a column is missing because a migration
# never ran, that message is the answer — hiding it would print an empty box
# and look like the account has no attributes.
"${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail <<SQL
\pset border 2
SELECT u.email,
       u.role,
       u.status                              AS user_status,
       t.status                              AS org_status,
       u.phone,
       u.mfa_enabled,
       (u.mfa_secret_ref IS NOT NULL)        AS has_mfa_secret,
       u.must_change_password,
       u.failed_login_count,
       u.locked_until,
       u.password_changed_at,
       u.last_login_at,
       left(coalesce(u.password_hash,'(none)'), 32) AS hash_prefix,
       length(coalesce(u.password_hash,''))         AS hash_len
  FROM core.users u
  LEFT JOIN core.tenants t ON t.id = u.tenant_id
 WHERE u.email = $E \gx
SQL

echo "== what that means =="
locked=$(q "SELECT coalesce(locked_until > now(), false) FROM core.users WHERE email = $E")
mins=$(q  "SELECT greatest(1, ceil(extract(epoch FROM (locked_until - now()))/60))::int FROM core.users WHERE email = $E AND locked_until > now()")
mfa=$(q   "SELECT mfa_enabled AND mfa_secret_ref IS NOT NULL FROM core.users WHERE email = $E")
ustat=$(q "SELECT status FROM core.users WHERE email = $E")
ostat=$(q "SELECT t.status FROM core.users u JOIN core.tenants t ON t.id=u.tenant_id WHERE u.email = $E")
algo=$(q  "SELECT split_part(password_hash, '\$', 2) FROM core.users WHERE email = $E")
changed=$(q "SELECT coalesce(to_char(password_changed_at,'YYYY-MM-DD HH24:MI'),'never') FROM core.users WHERE email = $E")

hits=0
if [ "$locked" = "t" ]; then
    hits=$((hits+1))
    echo "  ✗ LOCKED OUT for about ${mins:-?} more minute(s)."
    echo "    Sign-in answers 429, not 401 — every failed attempt after the reset"
    echo "    counted again, and enough of them re-locked the account. Waiting it"
    echo "    out works; so does clearing locked_until (command at the end)."
fi
if [ "$mfa" = "t" ]; then
    hits=$((hits+1))
    echo "  ✗ MFA IS ON for this account."
    echo "    A correct password returns 200 with {\"mfaRequired\":true} and a"
    echo "    challenge — NOT a session. The password is fine; the authenticator"
    echo "    code is the missing half. Nothing about a password reset clears MFA,"
    echo "    deliberately: a reset must not be a way to strip a second factor."
fi
case "$ustat" in
    suspended|deleted) hits=$((hits+1)); echo "  ✗ The USER is '$ustat' — login answers 401 even with the right password." ;;
esac
case "$ostat" in
    suspended|deleted) hits=$((hits+1)); echo "  ✗ The ORGANISATION is '$ostat' — same 401, whatever the user's own status." ;;
esac
if [ "$algo" != "argon2id" ]; then
    hits=$((hits+1))
    echo "  ✗ The stored hash is not argon2id (it starts '$algo')."
    echo "    Verify() refuses anything else outright, so no password can ever match."
fi
[ "$hits" -eq 0 ] && {
    echo "  Nothing on the row would block a sign-in. Not locked, no MFA, active,"
    echo "  argon2id hash, last changed $changed."
    echo
    echo "  Which leaves the password itself differing from what you think it is."
    echo "  The usual cause is a character the JSON body mangles on the way in:"
    echo "  a double quote or a backslash means the API stores something other"
    echo "  than what you typed, and it fails identically forever after. Reset"
    echo "  again with letters, digits and simple punctuation only, and confirm"
    echo "  below."
}

# ---------------------------------------------------------------------------
echo
printf 'Test a sign-in now and print the real answer? [y/N] '
read -r yn
case "$yn" in [Yy]*) ;; *) exit 0 ;; esac

printf 'Password (not echoed, one attempt — this DOES count toward the lockout): '
stty -echo 2>/dev/null; read -r P; stty echo 2>/dev/null; echo

r=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$P" |
    curl -s -w '\n%{http_code}' --max-time 20 -X POST \
         -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
unset P
code=$(printf '%s' "$r" | tail -n1); payload=$(printf '%s' "$r" | sed '$d')

echo
echo "  HTTP $code"
echo "  $payload"
echo
case "$code" in
    200) if printf '%s' "$payload" | grep -q 'mfaRequired'; then
             echo "  → The PASSWORD IS CORRECT. This is an MFA challenge, not a session."
             echo "    Finish at https://${SITE} with your authenticator code."
         else
             echo "  → Signed in. The password works against the API, so if the browser"
             echo "    still refuses, the difference is in the browser: a saved old"
             echo "    password, or a stale session. Try a private window."
         fi ;;
    401) echo "  → Wrong password, or the account/org is suspended. The message is"
         echo "    identical for both on purpose; the table above tells them apart." ;;
    429) echo "  → Locked out. Wait, or clear it with the command below." ;;
    *)   echo "  → Unexpected. Check: docker compose ... logs --tail 40 api" ;;
esac

echo
echo "To clear a lockout without touching anything else:"
echo "  docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env exec -T postgres psql -U postgres -d tatvaos_mail -c \"UPDATE core.users SET locked_until=NULL, failed_login_count=0 WHERE email='${EMAIL}'\""
