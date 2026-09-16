#!/usr/bin/env bash
#
# TatvaOS — invitations (decision 0005): new people set their own password.
#
# Proves, against the LOCAL stack (docker compose in local/, the API on
# :5000, Mailpit on :8025 catching every outbound message):
#
#   1. recovery email + blank password → no usable password, sign-in refused,
#      ONE invitation in Mailpit with the token in the URL fragment
#   2. accepting sets the password, sign-in works, the recovery email is now
#      verified, and the same token answers 401 the second time
#   3. a link older than 72 hours answers 401 with the expired sentence
#   4. resend: the previous link dies, the new one works
#   5. no recovery info + blank password → refused by the API, single and bulk,
#      with the sentence the design fixes
#   6. typed password → created, must change at first sign-in, no invitation
#   7. the mail edge down → "not delivered", on the create response AND in
#      the people list
#   8. (browser) location.href holds no token after /welcome loads — not here;
#      it is a page behaviour and is checked by hand with a dev server
#
# RED FIRST. Step 2's single-use check is calibrated: the spent token is
# re-armed through psql and must be accepted again, which is exactly what a
# missing single-use clause would look like. If that calibration ever stops
# going green, the assertion is no longer looking at the thing it claims to.
#
# Needs: bash, curl, python3 (for JSON), docker (psql via tv-postgres). Run
# from anywhere:   bash tests/invitations/test-invitations.sh
# ---------------------------------------------------------------------------
set -uo pipefail

# python3 on a Windows laptop is often the Store stub; python is the real one.
PY="${TATVAOS_PYTHON:-python}"

API="${TATVAOS_API:-http://localhost:5000}"
MAILPIT="${TATVAOS_MAILPIT:-http://localhost:8025}"
PG="docker exec tv-postgres psql -U postgres -d tatvaos_mail -Atc"
DOMAIN_ID="${TATVAOS_DOMAIN_ID:-a1111111-1111-1111-1111-111111111111}"   # techvein.local, verified
OWNER_PHONE="${TATVAOS_OWNER_PHONE:-+919999900001}"                     # amit@techvein.local, local seed
RUN=$(date +%s)

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }

# JSON helpers — python, because jq is not on every laptop this runs on.
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }

post() { # url token body -> "status\nbody"
    local auth=()
    [ -n "$2" ] && auth=(-H "Authorization: Bearer $2")
    curl -s -w '\n%{http_code}' -X POST "$1" -H 'Content-Type: application/json' "${auth[@]}" -d "$3"
}
get() { curl -s -w '\n%{http_code}' "$1" -H "Authorization: Bearer $2"; }
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

mailpit_for() { # recipient -> the newest message to it, DECODED to text, or empty
    local id
    id=$(curl -s "$MAILPIT/api/v1/search?query=to:$1" | j "d['messages'][0]['ID'] if d['messages'] else ''")
    # .NET's SmtpClient base64-encodes a body with any non-ASCII character in
    # it (this template has an em dash), and quoted-printable otherwise. The
    # email module undoes whichever it was; grepping the raw source would
    # miss the link in the base64 case — which is exactly what happened on
    # the first run of this script.
    [ -n "$id" ] && curl -s "$MAILPIT/api/v1/message/$id/raw" | "$PY" -c "
import sys,email
msg=email.message_from_bytes(sys.stdin.buffer.read())
parts=[msg] if not msg.is_multipart() else msg.walk()
for p in parts:
    if p.get_content_type().startswith('text/'):
        print(p.get_payload(decode=True).decode(p.get_content_charset() or 'utf-8','replace'))"
}
mailpit_count() { curl -s "$MAILPIT/api/v1/search?query=to:$1" | j "d['messages_count']"; }
token_from() { "$PY" -c "
import sys,re,urllib.parse
m=re.search(r'/welcome#t=([A-Za-z0-9._~%\-]+)', sys.stdin.read())
print(urllib.parse.unquote(m.group(1)) if m else '')"; }

# ---------------------------------------------------------------------------
step "0. The stack answers"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$h" = "200" ] && pass "API health 200" || { fail "API health $h — is the API running on $API?"; exit 1; }
h=$(curl -s -o /dev/null -w '%{http_code}' "$MAILPIT/api/v1/messages")
[ "$h" = "200" ] && pass "Mailpit answers" || { fail "Mailpit $h"; exit 1; }

# ---------------------------------------------------------------------------
step "Sign in as the seeded owner (OTP shown on screen — a local setting)"
# The 60-second resend throttle would hide the code on a second run within a
# minute. Local seed row, local database: clear it.
$PG "UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
r=$(post "$API/api/auth/otp/request" "" "{\"phone\":\"$OWNER_PHONE\"}")
code=$(jq_ "$(body "$r")" "d.get('devCode') or ''")
[ -n "$code" ] || { fail "no devCode — set core.platform_settings sms.show_otp_on_screen=true and a phone on the owner"; exit 1; }
r=$(post "$API/api/auth/otp/verify" "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")
TOKEN=$(jq_ "$(body "$r")" "d.get('accessToken') or ''")
[ -n "$TOKEN" ] && pass "signed in" || { fail "OTP verify: $(body "$r")"; exit 1; }

# ---------------------------------------------------------------------------
step "1. Recovery email + blank password → invitation, no usable password"
P1="inv1-$RUN"; R1="inv1-$RUN@example.test"
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"$P1\",\"displayName\":\"Invite One\",\"domainId\":\"$DOMAIN_ID\",\"recoveryEmail\":\"$R1\"}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(body "$r")"
U1=$(jq_ "$(body "$r")" "d['id']")
[ "$(jq_ "$(body "$r")" "d['invitation']['delivered']")" = "True" ] && pass "response says invitation delivered" || fail "response: $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['invitation']['sentTo']")" = "i•••@example.test" ] && pass "address masked in the response" || fail "sentTo: $(body "$r")"
[ "$(jq_ "$(body "$r")" "'temporaryPassword' in d")" = "False" ] && pass "no temporaryPassword key at all" || fail "a password came back"
[ "$($PG "SELECT password_hash IS NULL FROM core.users WHERE id='$U1'")" = "t" ] && pass "password_hash is NULL" || fail "a password hash exists"
[ "$($PG "SELECT invite_delivered FROM core.users WHERE id='$U1'")" = "t" ] && pass "invite_delivered recorded true" || fail "invite_delivered not true"
r=$(post "$API/api/auth/login" "" "{\"email\":\"$P1@techvein.local\",\"password\":\"anything-at-all-12\"}")
[ "$(status "$r")" = "401" ] && pass "sign-in with any password refused (401)" || fail "sign-in answered $(status "$r")"
sleep 2
n=$(mailpit_count "$R1")
[ "$n" = "1" ] && pass "exactly one message to the recovery address" || fail "Mailpit holds $n messages for $R1"
raw=$(mailpit_for "$R1")
T1=$(printf '%s' "$raw" | token_from)
[ -n "$T1" ] && pass "link carries the token in the fragment (/welcome#t=)" || fail "no /welcome#t= link in the mail"
printf '%s' "$raw" | grep -qi 'welcome?t=' && fail "token also in a query string" || pass "token is NOT in a query string"
printf '%s' "$raw" | grep -qi 'temporary password' && fail "mail mentions a temporary password" || pass "no temporary password in the mail"
printf '%s' "$raw" | grep -q "$P1@techvein.local" && pass "mail names the new sign-in address" || fail "sign-in address missing from the mail"

# the people list
r=$(get "$API/api/org/users" "$TOKEN")
st=$(jq_ "$(body "$r")" "[u for u in d if u['id']=='$U1'][0]['invitation']['state']")
[ "$st" = "pending" ] && pass "people list: invitation pending" || fail "people list state: $st"

# ---------------------------------------------------------------------------
step "2. Accept the link: password set, sign-in works, recovery verified, token spent"
NEWPW="chosen-by-them-$RUN"
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T1\",\"newPassword\":\"$NEWPW\"}")
[ "$(status "$r")" = "200" ] && pass "accept 200" || fail "accept: $(status "$r") $(body "$r")"
r=$(post "$API/api/auth/login" "" "{\"email\":\"$P1@techvein.local\",\"password\":\"$NEWPW\"}")
[ "$(status "$r")" = "200" ] && pass "sign-in with the chosen password 200" || fail "sign-in after accept: $(status "$r")"
[ "$(jq_ "$(body "$r")" "d['mustChangePassword']")" = "False" ] && pass "not forced to change it (their own choice)" || fail "mustChangePassword set"
[ "$($PG "SELECT recovery_email_verified_at IS NOT NULL FROM core.users WHERE id='$U1'")" = "t" ] && pass "recovery email now verified" || fail "recovery email still unverified"
[ "$($PG "SELECT invite_token_hash IS NULL AND invite_accepted_at IS NOT NULL FROM core.users WHERE id='$U1'")" = "t" ] && pass "token hash cleared, acceptance timestamped" || fail "invite columns not cleared"
[ "$($PG "SELECT imap_password_hash IS NOT NULL FROM mail.mailboxes WHERE user_id='$U1'")" = "t" ] && pass "mailbox got the same password" || fail "mailbox still has no password"
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T1\",\"newPassword\":\"$NEWPW-again\"}")
[ "$(status "$r")" = "401" ] && pass "second accept with the same token: 401" || fail "second accept answered $(status "$r")"
r=$(get "$API/api/org/users" "$TOKEN")
[ "$(jq_ "$(body "$r")" "[u for u in d if u['id']=='$U1'][0]['invitation']")" = "None" ] && pass "people list: nothing more to say" || fail "people list still shows an invitation"

step "2b. RED FIRST — re-arm the spent token and watch the check notice"
H1=$("$PY" -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$T1")
$PG "UPDATE core.users SET invite_token_hash='$H1', invite_accepted_at=NULL, invite_sent_at=now() WHERE id='$U1'" >/dev/null
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T1\",\"newPassword\":\"$NEWPW-rearmed\"}")
if [ "$(status "$r")" = "200" ]; then
    pass "calibration: a re-armed token IS accepted, so the 401 above was the single-use rule and not an accident"
else
    fail "calibration: re-armed token answered $(status "$r") — the token hashing or lookup changed; the single-use assertion is no longer proving anything ($(body "$r"))"
fi
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T1\",\"newPassword\":\"$NEWPW-third\"}")
[ "$(status "$r")" = "401" ] && pass "and it is spent again" || fail "third accept answered $(status "$r")"

# ---------------------------------------------------------------------------
step "3. A link older than 72 hours"
P2="inv2-$RUN"; R2="inv2-$RUN@example.test"
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"$P2\",\"displayName\":\"Invite Two\",\"domainId\":\"$DOMAIN_ID\",\"recoveryEmail\":\"$R2\"}")
U2=$(jq_ "$(body "$r")" "d['id']")
sleep 2
T2=$(mailpit_for "$R2" | token_from)
[ -n "$T2" ] && pass "second invitation mailed" || fail "no token for $R2"
$PG "UPDATE core.users SET invite_sent_at = now() - interval '73 hours' WHERE id='$U2'" >/dev/null
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T2\",\"newPassword\":\"late-arrival-$RUN\"}")
[ "$(status "$r")" = "401" ] && pass "accept after 73h: 401" || fail "accept after 73h answered $(status "$r")"
printf '%s' "$(body "$r")" | grep -q "This invitation has expired. Ask your administrator to send a new one." \
    && pass "with the expired sentence" || fail "wrong message: $(body "$r")"
r=$(get "$API/api/org/users" "$TOKEN")
st=$(jq_ "$(body "$r")" "[u for u in d if u['id']=='$U2'][0]['invitation']['state']")
[ "$st" = "expired" ] && pass "people list: invitation expired" || fail "people list state: $st"

# ---------------------------------------------------------------------------
step "4. Resend: the old link dies, the new one works"
r=$(post "$API/api/org/users/$U2/invitation/resend" "$TOKEN" "{}")
[ "$(status "$r")" = "200" ] && [ "$(jq_ "$(body "$r")" "d['sent']")" = "True" ] && pass "resend 200, sent" || fail "resend: $(status "$r") $(body "$r")"
sleep 2
n=$(mailpit_count "$R2")
[ "$n" = "2" ] && pass "a second message to the recovery address" || fail "Mailpit holds $n messages for $R2"
T2B=$(mailpit_for "$R2" | token_from)
[ -n "$T2B" ] && [ "$T2B" != "$T2" ] && pass "new token differs from the old" || fail "resend did not mint a new token"
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T2\",\"newPassword\":\"old-link-$RUN\"}")
[ "$(status "$r")" = "401" ] && pass "old link: 401" || fail "old link answered $(status "$r")"
r=$(post "$API/api/auth/invite/accept" "" "{\"token\":\"$T2B\",\"newPassword\":\"new-link-$RUN\"}")
[ "$(status "$r")" = "200" ] && pass "new link: 200" || fail "new link answered $(status "$r") $(body "$r")"
r=$(post "$API/api/org/users/$U2/invitation/resend" "$TOKEN" "{}")
[ "$(status "$r")" = "400" ] && pass "resend for someone who now has a password: refused" || fail "resend after accept answered $(status "$r")"

# ---------------------------------------------------------------------------
step "5. No recovery info + blank password → refused, single and bulk"
MSG="No recovery email or phone for this person — type a password to hand to them."
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"inv3-$RUN\",\"displayName\":\"Invite Three\",\"domainId\":\"$DOMAIN_ID\"}")
[ "$(status "$r")" = "400" ] && pass "single: 400" || fail "single answered $(status "$r")"
printf '%s' "$(body "$r")" | grep -qF "$MSG" && pass "single: the fixed sentence" || fail "single message: $(body "$r")"
[ "$($PG "SELECT count(*) FROM core.users WHERE email='inv3-$RUN@techvein.local'")" = "0" ] && pass "single: nothing was created" || fail "single: a row exists"
# phone only counts as nothing until the SMS template exists (launch rule)
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"inv3p-$RUN\",\"displayName\":\"Invite Phone\",\"domainId\":\"$DOMAIN_ID\",\"recoveryPhone\":\"+919876543210\"}")
[ "$(status "$r")" = "400" ] && pass "phone-only: refused too (launch rule)" || fail "phone-only answered $(status "$r")"
# bulk, posted directly (no preview), one row of each kind
B="{\"domainId\":null,\"departmentId\":null,\"dryRun\":false,\"users\":[
 {\"localPart\":\"bulk-a-$RUN\",\"displayName\":\"Bulk Invited\",\"domain\":\"techvein.local\",\"recoveryEmail\":\"bulk-a-$RUN@example.test\"},
 {\"localPart\":\"bulk-b-$RUN\",\"displayName\":\"Bulk Typed\",\"domain\":\"techvein.local\",\"password\":\"typed-by-admin-$RUN\"},
 {\"localPart\":\"bulk-c-$RUN\",\"displayName\":\"Bulk Nothing\",\"domain\":\"techvein.local\"}]}"
r=$(post "$API/api/org/users/bulk" "$TOKEN" "$B")
[ "$(status "$r")" = "200" ] && pass "bulk 200" || fail "bulk: $(status "$r") $(body "$r")"
[ "$(jq_ "$(body "$r")" "len(d['created'])")" = "2" ] && pass "bulk: two created" || fail "bulk created: $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['skipped'][0]['reason']")" = "$MSG" ] && pass "bulk: the third skipped with the fixed sentence" || fail "bulk skipped: $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['created'][0]['invitation']['sentTo']")" = "b•••@example.test" ] && pass "bulk: first row invited, address masked" || fail "bulk row 1: $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['created'][1]['invitation']")" = "None" ] && [ "$(jq_ "$(body "$r")" "d['created'][1]['passwordTyped']")" = "True" ] && pass "bulk: second row uses the typed password, no invitation" || fail "bulk row 2: $(body "$r")"
[ "$(jq_ "$(body "$r")" "any('temporaryPassword' in c for c in d['created'])")" = "False" ] && pass "bulk: no password echoed anywhere" || fail "bulk echoed a password"
# the bulk send happens after the response; give it a moment and check the row
for i in 1 2 3 4 5 6 7 8 9 10; do
    d=$($PG "SELECT invite_delivered FROM core.users WHERE email='bulk-a-$RUN@techvein.local'"); [ "$d" = "t" ] && break; sleep 1
done
[ "$d" = "t" ] && pass "bulk: invite_delivered written by the background send" || fail "bulk: invite_delivered is '$d' after 10s"
[ "$(mailpit_count "bulk-a-$RUN@example.test")" = "1" ] && pass "bulk: one invitation in Mailpit" || fail "bulk: Mailpit count $(mailpit_count "bulk-a-$RUN@example.test")"
[ "$($PG "SELECT password_hash IS NULL FROM core.users WHERE email='bulk-a-$RUN@techvein.local'")" = "t" ] && pass "bulk: invited row has no password" || fail "bulk: invited row has a password"

# ---------------------------------------------------------------------------
step "6. Typed password: created, forced change, no invitation"
P4="inv4-$RUN"; TYPED="typed-for-them-$RUN"
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"$P4\",\"displayName\":\"Typed Four\",\"domainId\":\"$DOMAIN_ID\",\"password\":\"$TYPED\",\"recoveryEmail\":\"inv4-$RUN@example.test\"}")
[ "$(status "$r")" = "201" ] && pass "created (201)" || fail "create: $(status "$r") $(body "$r")"
[ "$(jq_ "$(body "$r")" "d['invitation']")" = "None" ] && pass "typed wins: no invitation even with a recovery email" || fail "an invitation was sent: $(body "$r")"
r=$(post "$API/api/auth/login" "" "{\"email\":\"$P4@techvein.local\",\"password\":\"$TYPED\"}")
[ "$(status "$r")" = "200" ] && [ "$(jq_ "$(body "$r")" "d['mustChangePassword']")" = "True" ] && pass "signs in with it and must change it" || fail "typed sign-in: $(status "$r") $(body "$r")"
sleep 2
[ "$(mailpit_count "inv4-$RUN@example.test")" = "0" ] && pass "no invitation to the recovery address" || fail "Mailpit has a message for the typed person"
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"inv4s-$RUN\",\"displayName\":\"Short\",\"domainId\":\"$DOMAIN_ID\",\"password\":\"short\"}")
[ "$(status "$r")" = "400" ] && pass "a short typed password is refused" || fail "short password answered $(status "$r")"

# ---------------------------------------------------------------------------
step "7. Mail edge down → not delivered, visibly"
docker stop tv-postfix >/dev/null
P5="inv5-$RUN"; R5="inv5-$RUN@example.test"
r=$(post "$API/api/org/users" "$TOKEN" "{\"localPart\":\"$P5\",\"displayName\":\"Invite Five\",\"domainId\":\"$DOMAIN_ID\",\"recoveryEmail\":\"$R5\"}")
docker start tv-postfix >/dev/null
[ "$(status "$r")" = "201" ] && pass "person still created (201)" || fail "create with mail down: $(status "$r")"
U5=$(jq_ "$(body "$r")" "d['id']")
[ "$(jq_ "$(body "$r")" "d['invitation']['delivered']")" = "False" ] && pass "response says NOT delivered" || fail "response: $(body "$r")"
printf '%s' "$(body "$r")" | grep -q "could not be sent" && pass "note says so in words" || fail "note: $(body "$r")"
r=$(get "$API/api/org/users" "$TOKEN")
st=$(jq_ "$(body "$r")" "[u for u in d if u['id']=='$U5'][0]['invitation']['state']")
[ "$st" = "undelivered" ] && pass "people list: invitation not delivered" || fail "people list state: $st"
# and "set a password instead" replaces the dead invitation
r=$(post "$API/api/org/users/$U5/reset-password" "$TOKEN" "{}")
[ "$(status "$r")" = "200" ] && [ -n "$(jq_ "$(body "$r")" "d.get('temporaryPassword') or ''")" ] && pass "set a password instead: a one-time password comes back" || fail "reset: $(status "$r")"
[ "$($PG "SELECT invite_token_hash IS NULL FROM core.users WHERE id='$U5'")" = "t" ] && pass "the invitation is gone" || fail "invitation survived the reset"
[ "$($PG "SELECT imap_password_hash IS NOT NULL FROM mail.mailboxes WHERE user_id='$U5'")" = "t" ] && pass "mailbox got that password too" || fail "mailbox still password-less"
sleep 4   # postfix back before anything else needs it

# ---------------------------------------------------------------------------
printf '\n%s%s%s\n' "$CYAN" "----------------------------------------" "$RST"
printf '  %s%d passed%s, ' "$GREEN" "$PASSED" "$RST"
[ "$FAILED" -eq 0 ] && printf '%s0 failed%s\n' "$GREEN" "$RST" || printf '%s%d failed%s\n' "$RED" "$FAILED" "$RST"
printf '  Local rows created this run carry the suffix %s; they are test data in the local database only.\n\n' "$RUN"
[ "$FAILED" -eq 0 ]
