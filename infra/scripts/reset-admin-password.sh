#!/usr/bin/env bash
# ============================================================================
#  Break-glass password reset for an account that cannot receive its own
#  reset email — typically the platform administrator on a fresh box.
#
#      bash infra/scripts/reset-admin-password.sh
#
#  Run with NO arguments. It asks for the address and the new password.
#
#  ─────────────────────────────────────────────────────────────────────────
#   A PASSWORD CANNOT BE RETRIEVED. There is nothing to look up.
#
#   core.users.password_hash is Argon2id — a one-way derivation, by design,
#   so that a database dump is not a list of everybody's passwords. The only
#   move available is to replace it.
#  ─────────────────────────────────────────────────────────────────────────
#
#  WHAT THIS DOES NOT DO: write an Argon2id hash by hand. The parameters are
#  m=65536,t=3,p=2, 32 bytes out, and the salt and digest are PADDED standard
#  base64 — not the unpadded form every argon2 CLI emits. A hash that is
#  subtly wrong does not error; it just never verifies, and it looks exactly
#  like a forgotten password.
#
#  So this drives the product's OWN reset path instead:
#
#    1. mint a reset token the same way TokenIssuer.GenerateRefreshToken does
#    2. store its SHA-256 (the only thing the app ever stores — see
#       local/postgres/init/14-password-reset.sql)
#    3. spend it at POST /api/auth/password/reset
#
#  Step 3 is ordinary application code. It hashes the new password with the
#  real hasher, revokes every refresh token, clears the lockout, and audits
#  the reset — none of which a hand-written UPDATE would do.
#
#  It grants nobody anything new: it needs psql as postgres on this box, and
#  whoever has that already owns every row in the database.
#
#  The window is closed on the way out. If any step fails, the trap clears the
#  reset columns, so a live token is never left behind for the hour it would
#  otherwise stay valid.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/docker/.env
COMPOSE=(docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file "$ENV_FILE")
SITE=$(grep -E '^SITE_DOMAIN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' ")
API="https://${SITE:-core.tatvaos.com}/api"

psqlc() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>/dev/null | tail -n1; }
# Single quotes doubled, so an address containing one cannot end the literal.
sqlq()  { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

EMAIL=""
cleanup() {
    [ -n "$EMAIL" ] || return 0
    psqlc "UPDATE core.users SET password_reset_hash = NULL,
                                 password_reset_sent_at = NULL,
                                 password_reset_channel = NULL
            WHERE email = $(sqlq "$EMAIL") AND password_reset_hash IS NOT NULL" >/dev/null
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
printf 'Address to reset: '
read -r EMAIL
EMAIL=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
case "$EMAIL" in
    *@*.*) : ;;
    *) echo "  '$EMAIL' does not look like an email address."; exit 2 ;;
esac

# Show the row FIRST. A reset silently does nothing for a suspended or deleted
# account — the endpoint excludes both — and that is a confusing half hour.
row=$(psqlc "SELECT role || ' | ' || status || ' | locked_until=' || coalesce(locked_until::text,'none')
               FROM core.users WHERE email = $(sqlq "$EMAIL")")
if [ -z "$row" ]; then
    echo "  No account with that address. Nothing to reset."
    echo "  Existing administrators:"
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -d tatvaos_mail \
        -c "SELECT email, role, status FROM core.users WHERE role IN ('super_admin','admin') ORDER BY role, email" 2>/dev/null
    exit 1
fi
echo "  Found: $EMAIL"
echo "         $row"
case "$row" in
    *deleted*|*suspended*)
        echo "  That account is deleted or suspended. The reset endpoint ignores both."
        echo "  Fix the status first, deliberately, then run this again."
        exit 1 ;;
esac

# A live lockout is usually the whole story: sign-in answers 429, not 401, and
# the screen shows a failure that looks exactly like a wrong password. Say so
# plainly — the reset below clears it, so this is information, not a blocker.
if [ "$(psqlc "SELECT locked_until > now() FROM core.users WHERE email = $(sqlq "$EMAIL")")" = "t" ]; then
    echo
    echo "  NOTE  This account is LOCKED OUT right now. Sign-in has been answering"
    echo "        429 'too many failed attempts', which on the screen is hard to"
    echo "        tell from a wrong password — so the password you were typing may"
    echo "        well have been correct. Completing this reset clears the lockout"
    echo "        and the failed-attempt counter along with it."
fi

# ---------------------------------------------------------------------------
printf 'New password (12+ chars, not echoed): '
stty -echo 2>/dev/null; read -r P1; stty echo 2>/dev/null; echo
printf 'Again: '
stty -echo 2>/dev/null; read -r P2; stty echo 2>/dev/null; echo

[ "$P1" = "$P2" ]     || { echo "  They do not match."; exit 2; }
[ ${#P1} -ge 12 ]     || { echo "  The API requires 12 characters or more; it would refuse this."; exit 2; }
unset P2

# ---------------------------------------------------------------------------
# Same shape as TokenIssuer.GenerateRefreshToken: 32 random bytes, base64url,
# padding stripped. The app never compares the token itself, only its digest,
# so any high-entropy string would do — matching the real one keeps this
# honest if anyone ever reads the column while it is set.
TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
# Convert.ToHexString(SHA256.HashData(...)).ToLowerInvariant()
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)

# Wrapped in a CTE so the whole statement is a SELECT, and psql prints ONE
# line. A bare `UPDATE ... RETURNING 1` under -tA prints the returned row and
# THEN the command tag:
#     1
#     UPDATE 1
# so tail -n1 reads "UPDATE 1" and the update looks like it failed when it
# succeeded. Note the tag lands AFTER the rows here but BEFORE them for a
# leading SET — which is why neither head nor tail is a general fix, and
# making the statement a SELECT is.
n=$(psqlc "WITH upd AS (
             UPDATE core.users
                SET password_reset_hash = $(sqlq "$HASH"),
                    password_reset_sent_at = now(),
                    password_reset_attempts = 0,
                    password_reset_channel = 'email'
              WHERE email = $(sqlq "$EMAIL")
          RETURNING 1)
           SELECT count(*) FROM upd")
[ "$n" = "1" ] || { echo "  Could not stage the reset token (matched '${n:-nothing}') — is postgres up?"; exit 1; }

# ---------------------------------------------------------------------------
# Spend it. The password goes to curl on stdin, never in argv where `ps`
# on a shared box could read it.
r=$(printf '{"token":"%s","newPassword":"%s"}' "$TOKEN" "$P1" |
    curl -s -w '\n%{http_code}' --max-time 20 -X POST \
         -H 'Content-Type: application/json' --data-binary @- \
         "$API/auth/password/reset")
code=$(printf '%s' "$r" | tail -n1)
payload=$(printf '%s' "$r" | sed '$d')

if [ "$code" != "200" ]; then
    echo "  FAIL  reset returned $code"
    echo "        $payload"
    echo "        The token has been cleared; nothing was changed."
    exit 1
fi
echo "  OK    password reset, all sessions signed out"

# ---------------------------------------------------------------------------
# Prove it rather than assume it. A 200 above means the endpoint ran; only a
# successful sign-in means the new password actually works.
r=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$P1" |
    curl -s -w '\n%{http_code}' --max-time 20 -X POST \
         -H 'Content-Type: application/json' --data-binary @- "$API/auth/login")
unset P1
code=$(printf '%s' "$r" | tail -n1)
payload=$(printf '%s' "$r" | sed '$d')

# 200 alone is NOT proof of a sign-in. An account with MFA answers 200 with
# {"mfaRequired":true} and no session at all, so checking only the status code
# reports success for a login that did not happen.
if [ "$code" = "200" ] && printf '%s' "$payload" | grep -q '"accessToken"'; then
    echo "  OK    signed in with the new password"
    echo
    echo "Done. https://${SITE}"
elif [ "$code" = "200" ] && printf '%s' "$payload" | grep -q 'mfaRequired'; then
    echo "  OK    the password is correct — and MFA is on, so this is a challenge,"
    echo "        not a session. That is right: a password reset must never strip"
    echo "        a second factor. Finish at https://${SITE} with your"
    echo "        authenticator code."
else
    echo "  NOTE  the reset succeeded, but signing in returned $code."
    printf '        %s\n' "$(printf '%s' "$payload" | head -c 300)"
    echo "        Run: bash infra/scripts/diagnose-login.sh"
fi
