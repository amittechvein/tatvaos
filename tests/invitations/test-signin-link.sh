#!/usr/bin/env bash
#
# TatvaOS - "Send sign-in link" for somebody who already has a password, and a
# link that ends SIGNED IN (Amit, 19 Sept 2026: "send invitation of login with one
# use there they just add new password and get it login").
#
#   1. who may send one: not to yourself; not to somebody with no password yet
#      (that is Resend invitation); not without a recovery email
#   2. a link that could not be delivered is not left live
#   3. the OLD password keeps working until the link is used
#   4. using the link: sets the password AND signs in (a session comes back)
#   5. the old password then fails and the new one works
#   6. every session the person had before is ended; the new one is not
#   7. single use
#   8. a sign-in link lives 24 hours; a new-person invitation still lives 72
#   9. an account with an authenticator gets a CHALLENGE, not a session
#  10. a new person's invitation also ends signed in now
#  11. audited
#
# No mail server runs locally, so a link cannot be read from a mailbox. Where a
# link has to be USED, the test arms a known token straight into the row, exactly
# as tests/invitations re-arms one: the server stores only SHA-256 of the token
# (TokenIssuer.HashRefreshToken), so writing that hash is writing a real link.
#
# TWO MODES, for red-first evidence (house rule 6):
#   EXPECT=new (default)  asserts the feature.
#   EXPECT=old            the same requests, asserting what the code did BEFORE:
#                         no /signin-link route, and a link that only sets the
#                         password. Run on main before the change, it must pass;
#                         EXPECT=new on that same tree must go red.
#
# WSL Postgres as tests/orgapi. Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_SIGNINLINK_TEST_PORT:-5091}"
API="http://localhost:$PORT"
EXPECT="${EXPECT:-new}"
RUN=$(date +%s)
SCRATCH="$ROOT/.tmp/signin-link-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 1800 >/dev/null 2>&1 & WSL_KEEPALIVE=$!
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
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d "\r"; }
status() { printf "%s" "$1" | tail -n1; }
body() { printf "%s" "$1" | sed "\$d"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
xff() { printf "10.4.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" -H "X-Forwarded-For: $(xff)" ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
sha() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"; }
login() { post "/api/auth/login" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
active_sessions() { PG "SELECT count(*) FROM core.refresh_tokens WHERE user_id='$1' AND revoked_at IS NULL"; }
arm() { # arm USER_ID TOKEN CHANNEL HOURS_AGO
    PG "UPDATE core.users SET invite_token_hash='$(sha "$2")', invite_channel='$3', invite_sent_at=now() - interval '$4 hours', invite_accepted_at=NULL, invite_delivered=true WHERE id='$1'" >/dev/null
}
accept() { post "/api/auth/invite/accept" "{\"token\":\"$1\",\"newPassword\":\"$2\"}"; }

API_PID=""
cleanup() {
    PG "UPDATE core.users SET mfa_enabled=false, mfa_secret_ref=NULL WHERE email='hr@techvein.local'" >/dev/null
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Sign-in link - asserting the %s behaviour\n  tree under test: %s\n" "$(printf '%s' "$EXPECT" | tr a-z A-Z)" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. Start the API, sign in the owner, give the colleague a password and a session"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5870
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
OWNER=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
OWNER_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "owner sign-in failed"; exit 1; }

HR="hr@techvein.local"; HR_ID=$(PG "SELECT id FROM core.users WHERE email='$HR'")
T0=$(PG "SELECT now()")   # every count below is of THIS run only
PG "UPDATE core.users SET recovery_email=NULL, mfa_enabled=false, mfa_secret_ref=NULL, locked_until=NULL, failed_login_count=0, status='active' WHERE id='$HR_ID'" >/dev/null
r=$(post "/api/org/users/$HR_ID/reset-password" "{}" "$OWNER")
OLDPW=$(body "$r" | j "d.get('temporaryPassword') or ''")
[ -n "$OLDPW" ] && pass "the colleague has a password (from Reset password)" || { fail "no password: $(body "$r" | head -c 160)"; exit 1; }
r=$(login "$HR" "$OLDPW")
same "the colleague signs in with it and holds a session" "$(status "$r")" "200"
BEFORE=$(active_sessions "$HR_ID")

step "1. Who may be sent a sign-in link"
if [ "$EXPECT" = "old" ]; then
    r=$(post "/api/org/users/$HR_ID/signin-link" "{}" "$OWNER")
    same "OLD: there is no such route" "$(status "$r")" "404"
else
    r=$(post "/api/org/users/$HR_ID/signin-link" "{}" "$OWNER")
    same "no recovery email: refused" "$(status "$r")" "400"
    same "...and says why" "$(body "$r" | j "'no recovery email' in d.get('error','')")" "True"
    r=$(post "/api/org/users/$OWNER_ID/signin-link" "{}" "$OWNER")
    same "to yourself: refused" "$(status "$r")" "400"
    PG "UPDATE core.users SET recovery_email='hr.personal-$RUN@example.com' WHERE id='$HR_ID'" >/dev/null

    step "2. A link that could not be delivered is not left live"
    r=$(post "/api/org/users/$HR_ID/signin-link" "{}" "$OWNER")
    same "sent (no mail server here, so the answer says it was not delivered)" "$(status "$r")/$(body "$r" | j "d.get('sent')")" "200/False"
    same "...and no live link is left on the row" "$(PG "SELECT coalesce(invite_token_hash,'none') FROM core.users WHERE id='$HR_ID'")" "none"
    same "...and it is audited" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.signin_link_sent' AND target_id='$HR_ID' AND occurred_at >= '$T0'")" "1"
fi

step "3. The old password keeps working until the link is used"
T1="link-one-$RUN-abcdefghijklmnop"
arm "$HR_ID" "$T1" "email-signin" 0
r=$(login "$HR" "$OLDPW")
same "the old password still signs in while a link is out" "$(status "$r")" "200"
BEFORE=$(active_sessions "$HR_ID")
[ "${BEFORE:-0}" -ge 2 ] && pass "the colleague now holds $BEFORE live sessions" || fail "expected at least 2 live sessions, got [$BEFORE]"

step "4. Using the link"
NEWPW="Chosen-by-them-$RUN!"
# The database clock just before the link is used: step 6 counts only what THIS
# acceptance ended. Counting every revocation with that reason ever made, the
# first version of this file passed once and failed on its second run.
T_ACCEPT=$(PG "SELECT now()")
r=$(accept "$T1" "$NEWPW")
same "the link is accepted" "$(status "$r")" "200"
if [ "$EXPECT" = "old" ]; then
    same "OLD: no session comes back, only 'sign in with it'" "$(body "$r" | j "'accessToken' in d")" "False"
else
    same "a SESSION comes back: they are signed in" "$(body "$r" | j "bool(d.get('accessToken'))")" "True"
    same "...as the right person" "$(body "$r" | j "d['user']['email']")" "$HR"
fi

step "5. Old password out, new password in"
same "the old password is refused" "$(status "$(login "$HR" "$OLDPW")")" "401"
same "the new password signs in" "$(status "$(login "$HR" "$NEWPW")")" "200"

step "6. Sessions from before the link are ended"
ENDED=$(PG "SELECT count(*) FROM core.refresh_tokens WHERE user_id='$HR_ID' AND revoke_reason='password chosen through a sign-in link' AND revoked_at >= '$T_ACCEPT'")
if [ "$EXPECT" = "old" ]; then
    same "OLD: nothing was ended" "$ENDED" "0"
else
    same "every session that existed before is ended, and says why" "$ENDED" "$BEFORE"
    same "...and two remain live: the link's own, and the sign-in in step 5" "$(active_sessions "$HR_ID")" "2"
fi

step "7. Single use"
same "the same link again" "$(status "$(accept "$T1" "Another-one-$RUN!")")" "401"

step "8. How long a link lives"
T2="link-two-$RUN-abcdefghijklmnop"; arm "$HR_ID" "$T2" "email-signin" 25
if [ "$EXPECT" = "old" ]; then
    same "OLD: a 25-hour-old link of any kind still works (one lifetime, 72h)" "$(status "$(accept "$T2" "Late-$RUN-pass!")")" "200"
else
    same "a sign-in link 25 hours old is dead" "$(status "$(accept "$T2" "Late-$RUN-pass!")")" "401"
    T3="link-three-$RUN-abcdefghijklm"; arm "$HR_ID" "$T3" "email" 25
    same "...while a new-person invitation 25 hours old still works (72h)" "$(status "$(accept "$T3" "Late-$RUN-pass!")")" "200"
fi

step "9. An authenticator is never bypassed"
PG "UPDATE core.users SET mfa_enabled=true, mfa_secret_ref='test-ref-$RUN' WHERE id='$HR_ID'" >/dev/null
T4="link-four-$RUN-abcdefghijklmn"; arm "$HR_ID" "$T4" "email-signin" 0
r=$(accept "$T4" "Mfa-account-$RUN!")
same "the password is set" "$(status "$r")" "200"
same "...but NO session comes back" "$(body "$r" | j "bool(d.get('accessToken'))")" "False"
if [ "$EXPECT" = "new" ]; then
    same "...a challenge does instead" "$(body "$r" | j "bool(d.get('mfaRequired'))")" "True"
fi
PG "UPDATE core.users SET mfa_enabled=false, mfa_secret_ref=NULL WHERE id='$HR_ID'" >/dev/null

step "10. A new person's invitation"
T5="link-five-$RUN-abcdefghijklmn"
PG "UPDATE core.users SET password_hash=NULL WHERE id='$HR_ID'" >/dev/null
arm "$HR_ID" "$T5" "email" 0
r=$(accept "$T5" "First-ever-$RUN!")
same "accepted" "$(status "$r")" "200"
if [ "$EXPECT" = "new" ]; then
    same "...and they are signed in too" "$(body "$r" | j "bool(d.get('accessToken'))")" "True"
    same "...their first password ended nothing (there was nothing to end)" \
        "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.invitation_accepted' AND target_id='$HR_ID' AND occurred_at >= '$T0' AND after_state::text LIKE '%\"sessionsEnded\": false%'" | grep -c '^[1-9]')" "1"
else
    same "OLD: not signed in" "$(body "$r" | j "bool(d.get('accessToken'))")" "False"
fi

step "11. Audited"
if [ "$EXPECT" = "new" ]; then
    same "using a sign-in link is recorded as such" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.signin_link_used' AND target_id='$HR_ID' AND occurred_at >= '$T0'" | grep -c '^[1-9]')" "1"
fi

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (%s)\n\n" "$PASSED" "$EXPECT"; exit 0
else printf "  FAIL  %d of %d checks (%s)\n\n" "$FAILED" $((PASSED+FAILED)) "$EXPECT"; exit 1; fi
