#!/usr/bin/env bash
#
# TatvaOS - decision 0009: an administrator sets a person's recovery email.
#
# The table in docs/decisions/0009 ("What would prove it"), with Mr. Singh's
# rulings of 24 and 27 Sept 2026, run against the API:
#
#   A. who may: not for an owner (only that owner), not for yourself
#   B. replacing a CONFIRMED address: confirmation link to the new address;
#      notices to the sign-in mailbox and the old address, naming the
#      administrator, the full new address in NO message but its own; after
#      confirming, the HOLD: recovery_email is still the old one, a sign-in
#      link goes to the OLD address, Forgot password -> the NEW address sends
#      nothing; the People list shows the hold and no full address
#   C. the hold ends (the real RecoveryHoldWorker, a hold made due): the new
#      address becomes the recovery address; links now go there
#   D. "this was not me": reverts to the old address, issues no session,
#      suspends the administrator (their next change is refused), tells the
#      owner; single use; only an owner clears the suspension
#   E. no CONFIRMED old address: a sign-in link to an unconfirmed address is
#      refused (27 Sept); during a hold with only an unconfirmed old address,
#      sign-in link AND invitation are refused, naming when the hold ends
#   F. empty -> value is not held: confirmed means applied, and the invitation
#      goes at once
#   G. an owner's own address: MFA where enabled, and every other owner and
#      administrator is told
#   H. the person's own change overtakes an administrator's change in flight
#   I. audit rows carry masked addresses only
#
# Mail is read from the local SMTP sink's raw log and DECODED (MIME,
# base64 / quoted-printable) before any address is searched for: a search of
# the encoded text could miss an address and pass falsely. The decoder is
# calibrated first - it must find the MASKED address where it should be.
#
# Needs: the SMTP sink (tatvaos-ai-metering/.tmp/fake-ai-and-mail.mjs, SMTP
# :5871, log at TATVAOS_MAIL_SINK_LOG). WSL Postgres as tests/orgapi.
# Build first:  dotnet build apps/api -c Release
# TATVAOS_ROOT=<another checkout> runs it against that build (the red run).
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${TATVAOS_ROOT:-$HERE}"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_RECOVERY_ADMIN_TEST_PORT:-5093}"
API="http://localhost:$PORT"
SINK_LOG="${TATVAOS_MAIL_SINK_LOG:-$HERE/../tatvaos-ai-metering/.tmp/mail-sink.log}"
RUN=$(date +%s)
SCRATCH="$HERE/.tmp/recovery-admin-$$"; mkdir -p "$SCRATCH"; LOG="$SCRATCH/api.log"
TV="11111111-1111-1111-1111-111111111111"; TV_DOMAIN="a1111111-1111-1111-1111-111111111111"

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
# An empty operand is refused, not compared: [ "" = "" ] is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}
has() {
    if [ -z "$3" ]; then fail "$1 - nothing to look for"
    elif printf "%s" "$2" | grep -qiF -- "$3"; then pass "$1"
    else fail "$1 - [$3] not in: $(printf '%s' "$2" | head -c 200 | tr '\n' ' ')"; fi
}
xff() { printf "10.8.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
call() { # call METHOD PATH TOKEN [JSON]
    curl -s -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" -H "X-Forwarded-For: $(xff)" \
        ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}
}
login() { call POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
sha() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"; }
totp() { SECRET="$1" "$PY" -c '
import os, time, hmac, hashlib, base64, struct
s = os.environ["SECRET"].upper(); s += "=" * (-len(s) % 8)
h = hmac.new(base64.b32decode(s), struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
o = h[-1] & 15
print("%06d" % ((struct.unpack(">I", h[o:o + 4])[0] & 0x7fffffff) % 1000000))' | tr -d "\r"; }

# ---- mail, decoded ---------------------------------------------------------
# mail MODE ARG... over messages logged since MARK (a byte offset in the log):
#   count TO SUBJECT_PART          messages to TO whose subject contains it
#   mentions NEEDLE EXCEPT_TO      messages NOT to EXCEPT_TO whose decoded text contains NEEDLE
#   text TO SUBJECT_PART           the decoded text of the first such message
MARK=0
mark() { MARK=$(stat -c %s "$SINK_LOG" 2>/dev/null || echo 0); }
mail() { LOGF="$SINK_LOG" FROM="$MARK" "$PY" - "$@" <<'PYEOF' | tr -d "\r"
import os, sys, re, email
from email import policy
sys.stdout.reconfigure(encoding="utf-8")   # the masked address carries a bullet; the Windows default mangles it
raw = open(os.environ["LOGF"], "rb").read()[int(os.environ["FROM"]):].decode("utf-8", "replace")
msgs = []
for chunk in re.split(r"^----- \S+ to ", raw, flags=re.M)[1:]:
    head, _, data = chunk.partition("\n")
    m = email.message_from_string(data, policy=policy.default)
    text = []
    for part in m.walk():
        if part.get_content_maintype() == "text":
            try: text.append(part.get_content())
            except Exception: text.append(str(part.get_payload()))
    msgs.append((head.strip().lower().split(","), str(m.get("Subject", "")), "\n".join(text)))
mode, a, b = sys.argv[1], sys.argv[2].lower(), sys.argv[3]
if mode == "count":
    print(sum(1 for to, subj, _ in msgs if a in to and b.lower() in subj.lower()))
elif mode == "mentions":
    print(sum(1 for to, _, t in msgs if b.lower() not in to and a in t.lower()))
elif mode == "text":
    print(next((t for to, subj, t in msgs if a in to and b.lower() in subj.lower()), ""))
PYEOF
}

# ---- people ----------------------------------------------------------------
ADMIN_MAIL="rec-admin-$RUN@techvein.local"; OWNER2_MAIL="rec-owner2-$RUN@techvein.local"
PW_MAIL="rec-pw-$RUN@techvein.local"; UNCONF_MAIL="rec-unconf-$RUN@techvein.local"
NP1_MAIL="rec-np1-$RUN@techvein.local"; NP2_MAIL="rec-np2-$RUN@techvein.local"
OLD="old-$RUN@example.test"; NEW="new-$RUN@example.test"
UNCONF_OLD="unconf-old-$RUN@example.test"; NEW2="new2-$RUN@example.test"
NP1_NEW="np1-new-$RUN@example.test"; NP2_OLD="np2-old-$RUN@example.test"; NP2_NEW="np2-new-$RUN@example.test"
OWN_NEW="owner2-new-$RUN@example.test"; SELF_NEW="self-$RUN@example.test"
mkuser() { # mkuser EMAIL ROLE -> id
    PG "WITH x AS (INSERT INTO core.users (tenant_id, domain_id, email, display_name, role, status) VALUES ('$TV', '$TV_DOMAIN', '$1', 'Rec $2 $RUN', '$2', 'active') RETURNING id) SELECT id FROM x"
}

API_PID=""
cleanup() {
    PG "DELETE FROM core.users WHERE email LIKE 'rec-%-$RUN@techvein.local'" >/dev/null
    PG "DELETE FROM core.recovery_email_changes WHERE user_id='$HR_ID_SAFE'" >/dev/null
    if [ -n "$API_PID" ]; then
        if command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
        else fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
        kill "$API_PID" >/dev/null 2>&1 || true
    fi
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
HR_ID_SAFE="00000000-0000-0000-0000-000000000000"
trap cleanup EXIT

printf "\n  Decision 0009 - an administrator sets a recovery email\n  tree under test: %s\n" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. The sink, the API, and the people"
[ -f "$SINK_LOG" ] && pass "the mail sink's log exists ($SINK_LOG)" || { fail "no mail sink log at $SINK_LOG - start fake-ai-and-mail.mjs"; exit 1; }
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=localhost Smtp__Port=5871
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET phone='+919999900001' WHERE email='amit@techvein.local' AND phone IS NULL" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
OWNER=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
OWNER_ID=$(PG "SELECT id FROM core.users WHERE email='amit@techvein.local'")
[ -n "$OWNER" ] && pass "the owner (amit) signed in" || { fail "owner sign-in failed"; exit 1; }

ADMIN_ID=$(mkuser "$ADMIN_MAIL" org_admin); OWNER2_ID=$(mkuser "$OWNER2_MAIL" org_owner)
PW_ID=$(mkuser "$PW_MAIL" employee); UNCONF_ID=$(mkuser "$UNCONF_MAIL" employee)
NP1_ID=$(mkuser "$NP1_MAIL" employee); NP2_ID=$(mkuser "$NP2_MAIL" employee)
temp_pw() { body "$(call POST "/api/org/users/$1/reset-password" "$OWNER" "{}")" | j "d.get('temporaryPassword') or ''"; }
ADMIN_PW=$(temp_pw "$ADMIN_ID"); OWNER2_PW=$(temp_pw "$OWNER2_ID"); PW_PW=$(temp_pw "$PW_ID"); UNCONF_PW=$(temp_pw "$UNCONF_ID")
ADMIN=$(body "$(login "$ADMIN_MAIL" "$ADMIN_PW")" | j "d.get('accessToken') or ''")
[ -n "$ADMIN" ] && pass "an org_admin signed in" || { fail "admin sign-in failed"; exit 1; }
PG "UPDATE core.users SET recovery_email='$OLD', recovery_email_verified_at=now() WHERE id='$PW_ID'" >/dev/null
PG "UPDATE core.users SET recovery_email='$UNCONF_OLD', recovery_email_verified_at=NULL WHERE id='$UNCONF_ID'" >/dev/null
PG "UPDATE core.users SET recovery_email='$NP2_OLD', recovery_email_verified_at=NULL WHERE id='$NP2_ID'" >/dev/null
pass "people: a person with a password and a CONFIRMED recovery email, one with an UNconfirmed one, two never signed in"

step "A. Who may"
r=$(call PUT "/api/org/users/$OWNER2_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW\"}")
same "an administrator, for an owner: 403" "$(status "$r")" "403"
r=$(call PUT "/api/org/users/$OWNER2_ID/recovery-email" "$OWNER" "{\"email\":\"$NEW\"}")
same "another owner, for an owner: 403 (only that owner)" "$(status "$r")" "403"
r=$(call PUT "/api/org/users/$ADMIN_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW\"}")
same "for yourself: 400" "$(status "$r")" "400"
has "...pointing to the account page" "$(body "$r")" "account page"

step "B. Replacing a confirmed address: confirmation, notices, the hold"
mark
r=$(call PUT "/api/org/users/$PW_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW\"}")
same "the administrator sets it" "$(status "$r")/$(body "$r" | j "d.get('status')")/$(body "$r" | j "d.get('held')")" "200/pending/True"
same "the confirmation link goes to the new address" "$(mail count "$NEW" "Confirm your TatvaOS recovery email")" "1"
same "a notice goes to their sign-in mailbox" "$(mail count "$PW_MAIL" "recovery details were changed")" "1"
same "a notice goes to the OLD address" "$(mail count "$OLD" "recovery details were changed")" "1"
NOTICE=$(mail text "$PW_MAIL" "recovery details were changed")
has "(decoder calibration: the notice shows the new address MASKED)" "$NOTICE" "n•••@example.test"
has "the notice names the administrator" "$NOTICE" "Rec org_admin $RUN"
has "the notice carries \"This was not me\"" "$NOTICE" "This was not me"
same "the full new address appears in NO message but its own" "$(mail mentions "$NEW" "$NEW")" "0"
same "recovery_email is still the old address" "$(PG "SELECT recovery_email FROM core.users WHERE id='$PW_ID'")" "$OLD"
CONFIRM_TOKEN="confirm-$RUN-token"
PG "UPDATE core.recovery_email_changes SET confirm_token_hash='$(sha "$CONFIRM_TOKEN")' WHERE user_id='$PW_ID' AND status='pending'" >/dev/null
r=$(call POST /api/auth/recovery-email/verify "" "{\"token\":\"$CONFIRM_TOKEN\"}")
same "the new address confirms, and the change is HELD" "$(status "$r")/$(body "$r" | j "d.get('held')")" "200/True"
same "recovery_email is STILL the old address during the hold" "$(PG "SELECT recovery_email FROM core.users WHERE id='$PW_ID'")" "$OLD"
same "the hold ends in 48 hours" "$(PG "SELECT round(extract(epoch FROM hold_until - confirmed_at) / 3600) FROM core.recovery_email_changes WHERE user_id='$PW_ID' AND status='held'")" "48"
mark
r=$(call POST "/api/org/users/$PW_ID/signin-link" "$ADMIN" "{}")
same "Send sign-in link during the hold: sent" "$(status "$r")" "200"
same "...to the OLD address" "$(mail count "$OLD" "")" "1"
same "...and nothing to the new one" "$(mail count "$NEW" "")" "0"
mark
call POST /api/auth/password/forgot-recovery "" "{\"recoveryEmail\":\"$NEW\"}" >/dev/null
same "Forgot password with the NEW address during the hold sends nothing" "$(mail count "$NEW" "")" "0"
LIST=$(body "$(call GET "/api/org/users" "$OWNER")")
same "the People list shows the hold" "$(printf '%s' "$LIST" | ID="$PW_ID" "$PY" -c "import sys,json,os; d=json.load(sys.stdin); r=[x for x in d if x['id']==os.environ['ID']][0]; print((r.get('recoveryChange') or {}).get('status'))" | tr -d '\r')" "held"
same "the People list carries neither full address" "$(printf '%s' "$LIST" | grep -ciF -e "$OLD" -e "$NEW")" "0"

step "C. The hold ends (the real worker, with a hold made due)"
PG "UPDATE core.recovery_email_changes SET hold_until = now() - interval '1 minute' WHERE user_id='$PW_ID' AND status='held'" >/dev/null
for _ in $(seq 1 120); do [ "$(PG "SELECT status FROM core.recovery_email_changes WHERE user_id='$PW_ID' ORDER BY created_at DESC LIMIT 1")" = "applied" ] && break; sleep 1; done
same "the worker applied it" "$(PG "SELECT status FROM core.recovery_email_changes WHERE user_id='$PW_ID' ORDER BY created_at DESC LIMIT 1")" "applied"
same "the new address is now the confirmed recovery email" "$(PG "SELECT recovery_email || '/' || (recovery_email_verified_at IS NOT NULL) FROM core.users WHERE id='$PW_ID'")" "$NEW/true"
has "...and the worker said so in the log" "$(cat "$LOG")" "Recovery email holds ended"
mark
r=$(call POST "/api/org/users/$PW_ID/signin-link" "$ADMIN" "{}")
same "a sign-in link now goes to the new address" "$(status "$r")/$(mail count "$NEW" "")" "200/1"

step "D. \"This was not me\""
NOTME_TOKEN="notme-$RUN-token"
PG "UPDATE core.recovery_email_changes SET not_me_token_hash='$(sha "$NOTME_TOKEN")' WHERE user_id='$PW_ID' AND status='applied'" >/dev/null
mark
r=$(call POST /api/auth/recovery-email/not-me "" "{\"token\":\"$NOTME_TOKEN\"}")
same "the person reverts it" "$(status "$r")/$(body "$r" | j "d.get('reverted')")" "200/True"
same "...and no session is issued" "$(body "$r" | j "'accessToken' in d or 'refreshToken' in d")" "False"
same "the OLD address is back, confirmed as before" "$(PG "SELECT recovery_email || '/' || (recovery_email_verified_at IS NOT NULL) FROM core.users WHERE id='$PW_ID'")" "$OLD/true"
same "the owner is told" "$(mail count "amit@techvein.local" "reversed")" "1"
r=$(call POST /api/auth/recovery-email/not-me "" "{\"token\":\"$NOTME_TOKEN\"}")
same "the link works once" "$(status "$r")" "400"
r=$(call PUT "/api/org/users/$UNCONF_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW2\"}")
same "that administrator is suspended from changing recovery emails" "$(status "$r")" "403"
r=$(call POST "/api/org/users/$ADMIN_ID/recovery-suspension/clear" "$ADMIN" "{}")
same "an administrator cannot clear it" "$(status "$r")" "403"
r=$(call POST "/api/org/users/$ADMIN_ID/recovery-suspension/clear" "$OWNER" "{}")
same "an owner clears it" "$(status "$r")" "200"

step "E. No confirmed address: refused, with the reason"
r=$(call POST "/api/org/users/$UNCONF_ID/signin-link" "$ADMIN" "{}")
same "Send sign-in link to an UNconfirmed address: refused (27 Sept)" "$(status "$r")" "400"
has "...saying it is not confirmed" "$(body "$r")" "not been confirmed"
call PUT "/api/org/users/$UNCONF_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW2\"}" >/dev/null
PG "UPDATE core.recovery_email_changes SET confirm_token_hash='$(sha "c2-$RUN")' WHERE user_id='$UNCONF_ID' AND status='pending'" >/dev/null
same "the change confirms and is held" "$(body "$(call POST /api/auth/recovery-email/verify "" "{\"token\":\"c2-$RUN\"}")" | j "d.get('held')")" "True"
r=$(call POST "/api/org/users/$UNCONF_ID/signin-link" "$ADMIN" "{}")
same "during the hold, with no confirmed old address: sign-in link refused" "$(status "$r")" "400"
has "...naming when the hold ends" "$(body "$r")" "on hold until"
call PUT "/api/org/users/$NP2_ID/recovery-email" "$ADMIN" "{\"email\":\"$NP2_NEW\"}" >/dev/null
PG "UPDATE core.recovery_email_changes SET confirm_token_hash='$(sha "c3-$RUN")' WHERE user_id='$NP2_ID' AND status='pending'" >/dev/null
same "a never-signed-in person's REPLACED address is held too" "$(body "$(call POST /api/auth/recovery-email/verify "" "{\"token\":\"c3-$RUN\"}")" | j "d.get('held')")" "True"
r=$(call POST "/api/org/users/$NP2_ID/invitation/resend" "$ADMIN" "{}")
same "...and its invitation is refused during the hold" "$(status "$r")" "400"
has "...naming when the hold ends" "$(body "$r")" "on hold until"

step "F. Empty -> value is not held"
call PUT "/api/org/users/$NP1_ID/recovery-email" "$ADMIN" "{\"email\":\"$NP1_NEW\"}" >/dev/null
PG "UPDATE core.recovery_email_changes SET confirm_token_hash='$(sha "c4-$RUN")' WHERE user_id='$NP1_ID' AND status='pending'" >/dev/null
same "confirmed means applied at once" "$(body "$(call POST /api/auth/recovery-email/verify "" "{\"token\":\"c4-$RUN\"}")" | j "d.get('held')")" "False"
same "...it is the confirmed recovery email" "$(PG "SELECT recovery_email || '/' || (recovery_email_verified_at IS NOT NULL) FROM core.users WHERE id='$NP1_ID'")" "$NP1_NEW/true"
mark
r=$(call POST "/api/org/users/$NP1_ID/invitation/resend" "$ADMIN" "{}")
same "the invitation goes at once, to it" "$(status "$r")/$(mail count "$NP1_NEW" "")" "200/1"

step "G. An owner's own address: MFA where enabled; every other owner and administrator told"
OWNER2=$(body "$(login "$OWNER2_MAIL" "$OWNER2_PW")" | j "d.get('accessToken') or ''")
SECRET=$(body "$(call POST /api/auth/mfa/begin "$OWNER2" "{}")" | j "d.get('secret') or ''")
same "the second owner turns MFA on" "$(status "$(call POST /api/auth/mfa/confirm "$OWNER2" "{\"code\":\"$(totp "$SECRET")\"}")")" "200"
r=$(call POST /api/auth/recovery-email "$OWNER2" "{\"email\":\"$OWN_NEW\",\"currentPassword\":\"$OWNER2_PW\"}")
same "without the authenticator code: refused" "$(status "$r")/$(body "$r" | j "d.get('mfaRequired')")" "400/True"
sleep $(( 31 - $(date +%s) % 30 ))   # a fresh 30-second step: a used code cannot be replayed
mark
r=$(call POST /api/auth/recovery-email "$OWNER2" "{\"email\":\"$OWN_NEW\",\"currentPassword\":\"$OWNER2_PW\",\"mfaCode\":\"$(totp "$SECRET")\"}")
same "with it: accepted" "$(status "$r")" "200"
# The owner/admin notices go out one by one in the background: wait for them.
# They go one message at a time (about 2 s each on the local sink), so wait for BOTH.
for _ in $(seq 1 45); do
    [ "$(mail count "$ADMIN_MAIL" "An owner changed their recovery email")" = "1" ]         && [ "$(mail count "amit@techvein.local" "An owner changed their recovery email")" = "1" ] && break
    sleep 1
done
same "the other owner is told" "$(mail count "amit@techvein.local" "An owner changed their recovery email")" "1"
same "an administrator is told" "$(mail count "$ADMIN_MAIL" "An owner changed their recovery email")" "1"

step "H. The person's own change overtakes an administrator's"
call PUT "/api/org/users/$PW_ID/recovery-email" "$ADMIN" "{\"email\":\"$NEW\"}" >/dev/null
PWTOKEN=$(body "$(login "$PW_MAIL" "$PW_PW")" | j "d.get('accessToken') or ''")
call POST /api/auth/recovery-email "$PWTOKEN" "{\"email\":\"$SELF_NEW\",\"currentPassword\":\"$PW_PW\"}" >/dev/null
same "the administrator's pending change is superseded" "$(PG "SELECT status FROM core.recovery_email_changes WHERE user_id='$PW_ID' ORDER BY created_at DESC LIMIT 1")" "superseded"

step "I. Audit rows: masked only"
same "recovery audit rows were written" "$(PG "SELECT (count(*) > 0)::text FROM core.audit_logs WHERE target_id IN ('$PW_ID','$UNCONF_ID','$NP1_ID','$NP2_ID') AND action LIKE 'user.recovery%'")" "true"
same "no audit row holds a full address" "$(PG "SELECT count(*) FROM core.audit_logs WHERE target_id IN ('$PW_ID','$UNCONF_ID','$NP1_ID','$NP2_ID') AND (coalesce(before_state::text,'') || coalesce(after_state::text,'')) ~* '(old|new|new2|np1-new|np2-new)-$RUN@example'")" "0"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
