#!/usr/bin/env bash
#
# TatvaOS - "Send to pending" on the People page (Amit, 28 Sept 2026): the two
# per-person buttons, Send sign-in link and Send invitation, pressed for
# everybody who has never signed in.
#
#   1. a dry run says who WOULD be sent to, and sends and changes nothing
#   2. a request with no body is a dry run
#   3. the real press sends ONE mail to each person it counted, to their
#      recovery address, of the right kind (sign-in link / invitation)
#   4. somebody holding a link that still works is left alone: same token after
#   5. somebody with no recovery email is left out, and nothing is written
#   6. somebody who is not pending is never touched
#   7. an admin's press leaves a pending OWNER out; an owner's press does not
#   8. a second press straight after sends nothing (everyone holds a live link)
#   9. a link that could not be delivered is not left live (mail server down)
#  10. audited: one row for the press, one per mail
#
# A mail sink (smtp-sink.py) stands in for the mail server so the mails that
# leave can be COUNTED and READ. Asserting only on the rows would pass with
# nothing sent at all.
#
# Everybody else in the organisation who is pending is parked as 'active' for
# the length of the run and put back in cleanup, so the counts are of this
# run's people and nobody else's local row is sent to.
#
# TWO MODES, for red-first evidence (house rule 6):
#   EXPECT=new (default)  asserts the feature.
#   EXPECT=old            asserts what main did before: no such route.
#
# WSL Postgres as tests/orgapi. Build first:  dotnet build apps/api -c Release
# ---------------------------------------------------------------------------
set -uo pipefail
PY="${TATVAOS_PYTHON:-python}"
ROOT="${TATVAOS_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$ROOT/apps/api/TatvaOS.Api.csproj"
PORT="${TATVAOS_SENDPENDING_TEST_PORT:-5093}"
SMTP_PORT="${TATVAOS_SENDPENDING_SMTP_PORT:-5873}"
API="http://localhost:$PORT"
EXPECT="${EXPECT:-new}"
RUN=$(date +%s)
DOMAIN_ID="${TATVAOS_DOMAIN_ID:-a1111111-1111-1111-1111-111111111111}"   # techvein.local, verified
SCRATCH="$ROOT/.tmp/send-to-pending-$$"; mkdir -p "$SCRATCH/mail"; LOG="$SCRATCH/api.log"

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
xff() { printf "10.5.%d.%d" $((RANDOM % 250 + 1)) $((RANDOM % 250 + 1)); }
post() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "Content-Type: application/json" -H "X-Forwarded-For: $(xff)" ${3:+-H "Authorization: Bearer $3"} -d "$2"; }
post_nobody() { curl -s -w "\n%{http_code}" -X POST "$API$1" -H "X-Forwarded-For: $(xff)" -H "Authorization: Bearer $2"; }
sha() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$1"; }
col() { PG "SELECT coalesce($2::text,'none') FROM core.users WHERE id='$1'"; }
mails() { ls "$SCRATCH/mail" 2>/dev/null | grep -c '\.eml$'; }
# How many kept mails were for this address. -F and -- because an address is
# data, not a pattern (tests/README has the leading-dash incident).
mails_to() { grep -lF -- "X-Sink-Rcpt: $1" "$SCRATCH/mail"/*.eml 2>/dev/null | grep -c .; }
# The body arrives base64 or quoted-printable; decode before reading it.
mail_text() { "$PY" - "$SCRATCH/mail" "$1" <<'PYEOF'
import email, glob, os, sys
for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.eml"))):
    raw = open(p, "rb").read()
    if ("X-Sink-Rcpt: " + sys.argv[2]).encode() not in raw.split(b"\r\n", 1)[0]:
        continue
    m = email.message_from_bytes(raw)
    print("SUBJECT " + str(email.header.make_header(email.header.decode_header(m.get("Subject", "")))))
    for part in m.walk():
        if part.get_content_maintype() == "text":
            print((part.get_payload(decode=True) or b"").decode("utf-8", "replace"))
PYEOF
}
wait_mails() { # wait_mails N SECONDS - until N are kept, or time runs out
    for _ in $(seq 1 "$2"); do [ "$(mails)" -ge "$1" ] && return 0; sleep 1; done; return 1
}
kill_port() {
    if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "\$c = Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$c) { Stop-Process -Id \$c.OwningProcess -Force }" >/dev/null 2>&1
    else fuser -k "$1/tcp" >/dev/null 2>&1 || true; fi
}

API_PID=""; SINK_PID=""; PARKED="$SCRATCH/parked.txt"; MADE=""
cleanup() {
    # Put back everybody who was parked, and close this run's people.
    if [ -s "$PARKED" ]; then
        PG "UPDATE core.users SET status='pending' WHERE id IN ($(sed "s/.*/'&'/" "$PARKED" | paste -sd, -))" >/dev/null
    fi
    [ -n "$MADE" ] && PG "UPDATE core.users SET status='deleted' WHERE id IN ($MADE)" >/dev/null
    PG "UPDATE core.users SET role='employee' WHERE email='hr@techvein.local' AND role='org_admin'" >/dev/null
    [ -n "$API_PID" ] && { kill_port "$PORT"; kill "$API_PID" >/dev/null 2>&1 || true; }
    [ -n "$SINK_PID" ] && { kill_port "$SMTP_PORT"; kill "$SINK_PID" >/dev/null 2>&1 || true; }
    [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1
    if [ "$FAILED" -eq 0 ]; then rm -rf "$SCRATCH"; else printf "  kept for reading: %s\n" "$SCRATCH"; fi
}
trap cleanup EXIT

printf "\n  Send to pending - asserting the %s behaviour\n  tree under test: %s\n" "$(printf '%s' "$EXPECT" | tr a-z A-Z)" "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

step "0. Start the mail sink and the API, sign in the owner"
for _ in $(seq 1 30); do [ -n "$(PG "SELECT 1")" ] && break; sleep 1; done
"$PY" "$HERE/smtp-sink.py" "$SMTP_PORT" "$SCRATCH/mail" > "$SCRATCH/sink.log" 2>&1 &
SINK_PID=$!
export JWT_SIGNING_KEY="dev-only-key-at-least-32-characters-long" ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS="$API"
export ConnectionStrings__Postgres="Host=$TATVAOS_PG_HOST;Port=5432;Database=tatvaos_mail;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
export Smtp__Host=127.0.0.1 Smtp__Port="$SMTP_PORT"
if command -v cygpath >/dev/null 2>&1; then export Oidc__KeyDirectory="$(cygpath -w "$SCRATCH")\\keys"; else export Oidc__KeyDirectory="$SCRATCH/keys"; fi
dotnet run --no-build -c Release --project "$PROJ" > "$LOG" 2>&1 &
API_PID=$!
for _ in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null | grep -q 200 && break; sleep 1; done
curl -s -o /dev/null -w "%{http_code}" "$API/health" | grep -q 200 && pass "API up" || { fail "API did not start"; tail -5 "$LOG"; exit 1; }

PG "UPDATE core.users SET role='org_owner' WHERE email='amit@techvein.local' AND role='owner'" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL, login_otp_attempts=0 WHERE phone='+919999900001'" >/dev/null
code=$(curl -s -X POST "$API/api/auth/otp/request" -H "Content-Type: application/json" -d '{"phone":"+919999900001"}' | j "d.get('devCode') or ''")
OWNER=$(curl -s -X POST "$API/api/auth/otp/verify" -H "Content-Type: application/json" -d "{\"phone\":\"+919999900001\",\"code\":\"$code\"}" | j "d.get('accessToken') or ''")
[ -n "$OWNER" ] && pass "owner signed in" || { fail "owner sign-in failed"; exit 1; }
TENANT=$(PG "SELECT tenant_id FROM core.users WHERE email='amit@techvein.local'")

# Park everybody who is pending already, remembering exactly who.
$TATVAOS_PSQL "SELECT id FROM core.users WHERE tenant_id='$TENANT' AND status='pending'" 2>/dev/null | grep -v "^wsl:" | tr -d "\r" | grep -E '^[0-9a-f-]{36}$' > "$PARKED"
if [ -s "$PARKED" ]; then
    PG "UPDATE core.users SET status='active' WHERE id IN ($(sed "s/.*/'&'/" "$PARKED" | paste -sd, -))" >/dev/null
fi
same "nobody else is pending for the length of this run" "$(PG "SELECT count(*) FROM core.users WHERE tenant_id='$TENANT' AND status='pending'")" "0"

step "0b. This run's people"
T0=$(PG "SELECT now()")
make() { # make LOCALPART NAME EXTRA_JSON -> id
    local r; r=$(post "/api/org/users" "{\"localPart\":\"$1\",\"displayName\":\"$2\",\"domainId\":\"$DOMAIN_ID\"$3}" "$OWNER")
    local id; id=$(PG "SELECT id FROM core.users WHERE email='$1@techvein.local'")
    [ -n "$id" ] || { fail "could not create $1: $(body "$r" | head -c 200)"; exit 1; }
    MADE="${MADE:+$MADE,}'$id'"
    printf "%s" "$id"
}
PW="Typed-by-admin-$RUN!"
R_LINK="stp-link-$RUN@example.test";   R_INV="stp-inv-$RUN@example.test"
R_LIVE="stp-live-$RUN@example.test";   R_IN="stp-in-$RUN@example.test"
R_OWN="stp-own-$RUN@example.test"
# make() runs in a subshell ($(...)), so MADE is rebuilt here from the ids.
A=$(make "stp-link-$RUN"  "Has Password"   ",\"password\":\"$PW\",\"recoveryEmail\":\"$R_LINK\"")
B=$(make "stp-inv-$RUN"   "No Password"    ",\"recoveryEmail\":\"$R_INV\"")
C=$(make "stp-live-$RUN"  "Holds A Link"   ",\"password\":\"$PW\",\"recoveryEmail\":\"$R_LIVE\"")
D=$(make "stp-none-$RUN"  "No Recovery"    ",\"password\":\"$PW\"")
E=$(make "stp-in-$RUN"    "Already In"     ",\"password\":\"$PW\",\"recoveryEmail\":\"$R_IN\"")
F=$(make "stp-own-$RUN"   "Pending Owner"  ",\"password\":\"$PW\",\"recoveryEmail\":\"$R_OWN\",\"role\":\"org_owner\"")
MADE="'$A','$B','$C','$D','$E','$F'"
same "six people made" "$(PG "SELECT count(*) FROM core.users WHERE id IN ($MADE)")" "6"
same "...all of them pending" "$(PG "SELECT count(*) FROM core.users WHERE id IN ($MADE) AND status='pending'")" "6"
same "...and the owner among them IS an owner" "$(col "$F" role)" "org_owner"
PG "UPDATE core.users SET status='active' WHERE id='$E'" >/dev/null
# B was invited when made; that mail is not this test's subject. Expire B's
# link so the press has something to do for B, and arm C with one that works.
PG "UPDATE core.users SET invite_sent_at=now() - interval '80 hours', invite_delivered=true WHERE id='$B'" >/dev/null
TC="live-link-$RUN-abcdefghijklmnop"
PG "UPDATE core.users SET invite_token_hash='$(sha "$TC")', invite_channel='email-signin', invite_sent_at=now() - interval '2 hours', invite_accepted_at=NULL, invite_delivered=true WHERE id='$C'" >/dev/null
wait_mails 1 10; rm -f "$SCRATCH/mail"/*.eml   # B's creation mail, set aside
B_BEFORE=$(col "$B" invite_token_hash)

if [ "$EXPECT" = "old" ]; then
    step "OLD: there is no such route"
    r=$(post "/api/org/users/pending/send-links" '{"dryRun":false}' "$OWNER")
    # 404, or 405 if the path is read as /{id}/... by another verb's route.
    case "$(status "$r")" in 404|405) pass "no route  [got $(status "$r")]";; *) fail "expected 404/405, got [$(status "$r")]";; esac
    same "...and nothing was sent" "$(mails)" "0"
    printf "\n  -----------------------------------------------\n"
    if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (old)\n\n" "$PASSED"; exit 0
    else printf "  FAIL  %d of %d checks (old)\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
fi

step "1. A dry run counts, and sends and changes nothing"
r=$(post "/api/org/users/pending/send-links" '{"dryRun":true}' "$OWNER")
same "answered" "$(status "$r")" "200"
same "says it was a dry run" "$(body "$r" | j "d['dryRun']")" "True"
same "pending: A B C D F" "$(body "$r" | j "d['counts']['pending']")" "5"
same "to send: A B F (the owner is pressing)" "$(body "$r" | j "d['counts']['toSend']")" "3"
same "...two sign-in links" "$(body "$r" | j "d['counts']['signInLinks']")" "2"
same "...one invitation" "$(body "$r" | j "d['counts']['invitations']")" "1"
same "C is left alone" "$(body "$r" | j "d['counts']['skipped']['linkStillWorks']")" "1"
same "D is left out" "$(body "$r" | j "d['counts']['skipped']['noRecoveryEmail']")" "1"
same "no address is in the answer" "$(body "$r" | grep -cF "example.test")" "0"
sleep 3
same "no mail left" "$(mails)" "0"
same "A has no link" "$(col "$A" invite_token_hash)" "none"
same "B's old link is untouched" "$(col "$B" invite_token_hash)" "$B_BEFORE"
same "nothing audited" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.pending_links_sent' AND occurred_at >= '$T0'")" "0"

step "2. No body at all is a dry run"
r=$(post_nobody "/api/org/users/pending/send-links" "$OWNER")
same "answered as a dry run" "$(status "$r")/$(body "$r" | j "d['dryRun']")" "200/True"
sleep 2
same "no mail left" "$(mails)" "0"

step "7a. An admin's press leaves the pending owner out"
HR="hr@techvein.local"; HR_ID=$(PG "SELECT id FROM core.users WHERE email='$HR'")
PG "UPDATE core.users SET role='org_admin', status='active', mfa_enabled=false, locked_until=NULL, failed_login_count=0 WHERE id='$HR_ID'" >/dev/null
r=$(post "/api/org/users/$HR_ID/reset-password" "{}" "$OWNER")
HRPW=$(body "$r" | j "d.get('temporaryPassword') or ''")
ADMIN=$(post "/api/auth/login" "{\"email\":\"$HR\",\"password\":\"$HRPW\"}" | sed "\$d" | j "d.get('accessToken') or ''")
[ -n "$ADMIN" ] && pass "an org_admin signed in" || fail "the admin could not sign in"
same "...and is an admin, not an owner" "$(col "$HR_ID" role)" "org_admin"
r=$(post "/api/org/users/pending/send-links" '{"dryRun":true}' "$ADMIN")
same "for the admin, to send: A B only" "$(body "$r" | j "d['counts']['toSend']")" "2"
same "...the owner is counted as not theirs" "$(body "$r" | j "d['counts']['skipped']['notYours']")" "1"
same "...and for the owner that count was nought" "$(post "/api/org/users/pending/send-links" '{"dryRun":true}' "$OWNER" | sed "\$d" | j "d['counts']['skipped']['notYours']")" "0"

step "3. The admin presses"
T_PRESS=$(PG "SELECT now()")   # B was invited once already, when made; count from here
r=$(post "/api/org/users/pending/send-links" '{"dryRun":false}' "$ADMIN")
same "answered" "$(status "$r")/$(body "$r" | j "d['dryRun']")" "200/False"
same "said it is sending to two" "$(body "$r" | j "d['counts']['toSend']")" "2"
wait_mails 2 20; sleep 3   # and a little longer, to catch a mail too many
same "exactly two mails left" "$(mails)" "2"
same "one to A's recovery address" "$(mails_to "$R_LINK")" "1"
same "one to B's recovery address" "$(mails_to "$R_INV")" "1"
same "A's mail carries a link" "$(mail_text "$R_LINK" | grep -c "/welcome#t=" | grep -c '^[1-9]')" "1"
same "A's link is a SIGN-IN link on the row" "$(col "$A" invite_channel)" "email-signin"
same "B's is an invitation on the row" "$(col "$B" invite_channel)" "email"
same "A's and B's mails have different subjects" "$([ "$(mail_text "$R_LINK" | grep -m1 '^SUBJECT')" != "$(mail_text "$R_INV" | grep -m1 '^SUBJECT')" ] && echo differ || echo same)" "differ"
same "A is recorded as delivered" "$(col "$A" invite_delivered)" "true"
same "B is recorded as delivered" "$(col "$B" invite_delivered)" "true"
[ "$(col "$B" invite_token_hash)" != "$B_BEFORE" ] && pass "B's link is a new one" || fail "B's link did not change"
# The link in A's mail is the one on A's row: hash what was mailed. The token
# is matched by its own alphabet: the plain-text part writes the link inside
# brackets, and a looser pattern took the ")" with it and hashed to nonsense.
A_TOKEN=$(mail_text "$R_LINK" | "$PY" -c "import re,sys,urllib.parse; m=re.search(r'/welcome#t=([A-Za-z0-9_%.~-]+)', sys.stdin.read()); print(urllib.parse.unquote(m.group(1)) if m else '')")
same "the link A was mailed is the link on A's row" "$(sha "$A_TOKEN")" "$(col "$A" invite_token_hash)"
same "A's password still signs in" "$(status "$(post "/api/auth/login" "{\"email\":\"stp-link-$RUN@techvein.local\",\"password\":\"$PW\"}")")" "200"
# That sign-in made A active; A is no longer pending from here on.

step "4. C, holding a link that works, was left alone"
same "same token as before" "$(col "$C" invite_token_hash)" "$(sha "$TC")"
same "no mail to C" "$(mails_to "$R_LIVE")" "0"

step "5. D, with no recovery email, was left out"
same "no link written" "$(col "$D" invite_token_hash)" "none"

step "6. E, who is not pending, was never touched"
same "no link written" "$(col "$E" invite_token_hash)" "none"
same "no mail to E" "$(mails_to "$R_IN")" "0"

step "7b. The owner was left out of the admin's press"
same "no link written" "$(col "$F" invite_token_hash)" "none"
same "no mail to the owner" "$(mails_to "$R_OWN")" "0"

step "10. Audited"
same "one row for the press" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.pending_links_sent' AND occurred_at >= '$T0'")" "1"
same "...by the admin" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.pending_links_sent' AND occurred_at >= '$T0' AND actor_user_id='$HR_ID'")" "1"
same "one row for A's sign-in link" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.signin_link_sent' AND target_id='$A' AND occurred_at >= '$T0'")" "1"
same "one row for B's invitation" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action='user.invitation_sent' AND target_id='$B' AND occurred_at >= '$T_PRESS'")" "1"
same "the audit rows carry no whole address" "$(PG "SELECT count(*) FROM core.audit_logs WHERE occurred_at >= '$T0' AND action IN ('user.pending_links_sent','user.signin_link_sent','user.invitation_sent') AND after_state::text LIKE '%stp-%-$RUN@example.test%'")" "0"

step "8. A second press straight after sends nothing to those who hold a link"
rm -f "$SCRATCH/mail"/*.eml
B_NOW=$(col "$B" invite_token_hash)
r=$(post "/api/org/users/pending/send-links" '{"dryRun":false}' "$ADMIN")
same "nobody to send to" "$(body "$r" | j "d['counts']['toSend']")" "0"
same "B and C both hold a working link" "$(body "$r" | j "d['counts']['skipped']['linkStillWorks']")" "2"
sleep 4
same "no mail left" "$(mails)" "0"
same "B's link is still the one they were mailed" "$(col "$B" invite_token_hash)" "$B_NOW"

step "7c. The owner's press reaches the pending owner"
r=$(post "/api/org/users/pending/send-links" '{"dryRun":false}' "$OWNER")
same "to send: the owner only" "$(body "$r" | j "d['counts']['toSend']")" "1"
wait_mails 1 15; sleep 2
same "one mail, to the owner's recovery address" "$(mails)/$(mails_to "$R_OWN")" "1/1"

step "9. With the mail server down, no sign-in link is left live"
kill_port "$SMTP_PORT"; kill "$SINK_PID" >/dev/null 2>&1; SINK_PID=""
G=$(make "stp-down-$RUN" "Mail Is Down" ",\"password\":\"$PW\",\"recoveryEmail\":\"stp-down-$RUN@example.test\"")
MADE="$MADE,'$G'"
r=$(post "/api/org/users/pending/send-links" '{"dryRun":false}' "$OWNER")
same "it set out to send to one" "$(body "$r" | j "d['counts']['toSend']")" "1"
for _ in $(seq 1 20); do [ "$(col "$G" invite_delivered)" = "false" ] && break; sleep 1; done
same "recorded as NOT delivered" "$(col "$G" invite_delivered)" "false"
same "...and no live link is left on the row" "$(col "$G" invite_token_hash)" "none"
same "...and the next dry run offers them again" "$(post "/api/org/users/pending/send-links" '{"dryRun":true}' "$OWNER" | sed "\$d" | j "d['counts']['toSend']")" "1"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks (%s)\n\n" "$PASSED" "$EXPECT"; exit 0
else printf "  FAIL  %d of %d checks (%s)\n\n" "$FAILED" $((PASSED+FAILED)) "$EXPECT"; exit 1; fi
