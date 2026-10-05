#!/usr/bin/env bash
#
# TatvaOS — personal signup at /join (build plan personal-plans-build-plan.md,
# part B, §3 and §11).
#
# Proves, against a LOCAL API and database (no Docker; see "Needs" below):
#
#   0. closed while personal.signup_open is off — status says so, start 404s
#   1. the address rules: length, first letter, runs of dots, reserved names
#      (exact, "contains", and dotted look-alikes), all refused with the SAME
#      sentence as a taken name, never "reserved"
#   2. bots: honeypot filled, form sent too fast, forged form token
#   3. under 18 refused with the plan's sentence; no date of birth stored
#   4. the whole path: code, wrong code, right code, terms and password
#      refusals, account created — user, mailbox, personal_accounts row,
#      sign-in with the new password works, plain-text number gone from the
#      signup row
#   5. a taken address: unavailable, with free suggestions
#   6. a second personal account on the same phone, typed another way: 409
#   7. the SMS limits: 3 an hour per number, 10 per address, the platform
#      ceiling — each calibrated against the one below it
#   8. a removed reserved name stays removed after the migration re-runs
#   9. NO PHONE NUMBER IN THE API'S LOG, any spelling — and the log is proven
#      to be the right one (it holds this run's signup ids)
#  10. (Mr. Singh, PR 311) a work account's number: a personal signup with it
#      never removes or reassigns the work account's phone, whose SMS sign-in
#      still works; the personal account gets no phone, and the page is told
#      (after the code). RED FIRST: the number copied onto the personal
#      account makes the work account's SMS sign-in fail.
#  11. (Mr. Singh, PR 311) the phone-hash key: a fixed number's fingerprint is
#      HMAC-SHA256(key, "phone:"+number), computed independently; a FRESH
#      Production process without the key refuses to start, and with it gives
#      the same fingerprint (stable across restarts)
#
# RED FIRST, recorded in the PR: 9 was run once with a temporary
# LogInformation of the number in StartAsync and failed on exactly that line.
#
# Needs: bash, curl, python; the API on $TATVAOS_API with
# Personal__PhoneHashKey set, writing stdout to $TATVAOS_API_LOG; the database
# built from local/postgres/init (the b-...-seed file makes the house on
# personal.local); psql reachable as $TATVAOS_PSQL.
#   bash tests/personal-join/test-join.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5141}"
LOG="${TATVAOS_API_LOG:-.tmp/api.log}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
MIGRATION="local/postgres/init/20260926-a-personal-join.sql"
DOMAIN="personal.local"
RUN=$(date +%s)

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
# same/has/hasnt, never a bare [ "$a" = "$b" ] on values that can both be
# empty — empty = empty is the false green this repository keeps meeting.
same()  { [ -n "$2" ] && [ "$2" = "$3" ] && pass "$1" || fail "$1 — wanted '$3', got '$2'"; }
# A here-string, NOT printf | grep -q: under pipefail, grep -q exits at the
# first match, printf dies of SIGPIPE writing the rest, and the pipeline is
# "false". On a long text with an early match that made has() FAIL with the
# line present and hasnt() PASS with it present (3 Oct 2026, PR 386).
has()   { grep -qF -- "$3" <<< "$2" && pass "$1" || fail "$1 — '$3' not in: $2"; }

PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_() { printf '%s' "$1" | j "$2"; }

# The route-level limiter (30 a minute per address) is ALSO under test
# elsewhere; here it would only interrupt. A 429 with an empty body is that
# limiter, not the SMS limits (which always explain themselves): wait it out.
call() { # method url [body] -> "body\nstatus"
    local out s
    for _ in 1 2; do
        if [ -n "${3:-}" ]; then
            out=$(curl -s -w '\n%{http_code}' -X "$1" "$2" -H 'Content-Type: application/json' -d "$3")
        else
            out=$(curl -s -w '\n%{http_code}' -X "$1" "$2")
        fi
        s=$(printf '%s' "$out" | tail -n1)
        if [ "$s" = "429" ] && [ -z "$(printf '%s' "$out" | sed '$d')" ]; then sleep 61; continue; fi
        break
    done
    printf '%s' "$out"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }

# Numbers for this run. 7xxxxxxxxx: valid Indian mobile shape, unique per run.
num() { printf '7%09d' $(( (RUN * 7 + $1 * 1000003) % 1000000000 )); }
P1=$(num 1); P2=$(num 2); P3=$(num 3); P4=$(num 4); P5=$(num 5)
ALL_NUMBERS="$P1 $P2 $P3 $P4 $P5"
ADULT_DOB=$(date -d '-30 years' +%F)
MINOR_DOB=$(date -d '-17 years' +%F)

start_body() { # local name phone dob adult website token
    printf '{"localPart":"%s","displayName":"%s","phone":"%s","dateOfBirth":"%s","declaredAdult":%s,"website":"%s","formToken":"%s"}' \
        "$1" "$2" "$3" "$4" "$5" "$6" "$7"
}
# Local database: forget this machine's recent codes so each limit is tested
# from a clean slate (the per-address limit would otherwise fire on step 4).
reset_attempts() { PG "DELETE FROM core.personal_signup_attempts" >/dev/null; }

# ---------------------------------------------------------------------------
step "0. Closed while the switch is off"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$h" = "200" ] && pass "API health 200" || { fail "API health $h — is the API on $API?"; exit 1; }
[ -f "$LOG" ] || { fail "no API log at $LOG"; exit 1; }
PG "DELETE FROM core.platform_settings WHERE key IN ('personal.signup_open','personal.signup_codes_per_hour')" >/dev/null
r=$(call GET "$API/api/join/status")
same "status says closed" "$(jq_ "$(body "$r")" "d['open']")" "False"
r=$(call POST "$API/api/join/start" "$(start_body abcd Test "+91$P1" "$ADULT_DOB" true '' x)")
same "start answers 404 while closed" "$(status "$r")" "404"
PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_open','true')" >/dev/null
r=$(call GET "$API/api/join/status")
same "status says open once switched on" "$(jq_ "$(body "$r")" "d['open']")" "True"
same "on the house's domain" "$(jq_ "$(body "$r")" "d['domain']")" "$DOMAIN"
TOKEN=$(jq_ "$(body "$r")" "d['formToken']")
[ -n "$TOKEN" ] && pass "a form token is issued" || fail "no form token"
reset_attempts

# ---------------------------------------------------------------------------
step "1. Address rules and reserved names"
addr() { call GET "$API/api/join/address?name=$1"; }
same "'abc' is too short"         "$(jq_ "$(body "$(addr abc)")" "d['problem']")"   "Use at least 4 characters."
same "'1abcd' must start with a letter" "$(jq_ "$(body "$(addr 1abcd)")" "d['problem']")" "Start with a letter."
same "'ab..cd' refused"           "$(jq_ "$(body "$(addr ab..cd)")" "d['problem']")" "Dots and hyphens can't sit next to each other."
same "'abcd.' refused (trailing dot)" "$(jq_ "$(body "$(addr abcd.)")" "d['available']")" "False"
U="That address isn't available."
same "'admin' (exact) — the neutral sentence" "$(jq_ "$(body "$(addr admin)")" "d['problem']")" "$U"
same "'mytatvaos' (contains)"     "$(jq_ "$(body "$(addr mytatvaos)")" "d['problem']")" "$U"
same "'hdfc-care' (contains)"     "$(jq_ "$(body "$(addr hdfc-care)")" "d['problem']")" "$U"
same "no suggestions built on a reserved name (never 'admin26')" \
     "$(jq_ "$(body "$(addr admin)")" "len(d['suggestions'])")" "0"
same "'mytatvaos': no suggestions either" "$(jq_ "$(body "$(addr mytatvaos)")" "len(d['suggestions'])")" "0"
same "'harbir.$RUN' (holds 'rbi', a 3-letter entry) is free" "$(jq_ "$(body "$(addr "harbir.$RUN")")" "d['available']")" "True"
same "'a.d.m.i.n' (dotted exact)" "$(jq_ "$(body "$(addr a.d.m.i.n)")" "d['problem']")" "$U"
same "'Free.Name' is free (case folded)" "$(jq_ "$(body "$(addr Free.Name$RUN)")" "d['available']")" "True"
# Calibration: the reserved check is what refuses 'admin'. Remove it and
# the same request must pass; put it back.
PG "UPDATE core.reserved_usernames SET removed_at=now() WHERE name='admin'" >/dev/null
same "calibration: 'admin' is free once un-reserved" "$(jq_ "$(body "$(addr admin)")" "d['available']")" "True"
PG "UPDATE core.reserved_usernames SET removed_at=NULL WHERE name='admin'" >/dev/null
same "and refused again once re-reserved" "$(jq_ "$(body "$(addr admin)")" "d['available']")" "False"

# ---------------------------------------------------------------------------
step "2. Bots"
sleep 5   # the form token must be older than a person's fastest fill
B="Something went wrong. Reload the page and try again."
r=$(call POST "$API/api/join/start" "$(start_body "bot$RUN" Bot "+91$P1" "$ADULT_DOB" true 'http://spam' "$TOKEN")")
same "honeypot filled: refused"   "$(jq_ "$(body "$r")" "d['error']")" "$B"
FRESH=$(jq_ "$(body "$(call GET "$API/api/join/status")")" "d['formToken']")
r=$(call POST "$API/api/join/start" "$(start_body "bot$RUN" Bot "+91$P1" "$ADULT_DOB" true '' "$FRESH")")
same "form sent at once: refused" "$(jq_ "$(body "$r")" "d['error']")" "$B"
FORGED="${TOKEN%%.*}.0000000000000000000000000000000000000000000000000000000000000000"
r=$(call POST "$API/api/join/start" "$(start_body "bot$RUN" Bot "+91$P1" "$ADULT_DOB" true '' "$FORGED")")
same "forged token: refused"      "$(jq_ "$(body "$r")" "d['error']")" "$B"
same "no signup was started by any of them" "$(PG "SELECT count(*) FROM core.personal_signups WHERE local_part='bot$RUN'")" "0"

# ---------------------------------------------------------------------------
step "3. Under 18"
r=$(call POST "$API/api/join/start" "$(start_body "young$RUN" Young "+91$P1" "$MINOR_DOB" true '' "$TOKEN")")
same "refused (400)" "$(status "$r")" "400"
same "with the plan's sentence" "$(jq_ "$(body "$r")" "d['error']")" \
     "TatvaOS personal accounts are for adults. If your school uses TatvaOS, ask it for a school account."
same "recorded as refused_minor" "$(PG "SELECT count(*) FROM core.personal_signup_attempts WHERE outcome='refused_minor'")" "1"
r=$(call POST "$API/api/join/start" "$(start_body "young$RUN" Young "+91$P1" "$ADULT_DOB" false '' "$TOKEN")")
same "an adult date with the box unticked: refused" "$(status "$r")" "400"
same "no table has a date-of-birth column" \
     "$(PG "SELECT count(*) FROM information_schema.columns WHERE table_schema='core' AND column_name ILIKE '%birth%'")" "0"

# ---------------------------------------------------------------------------
step "4. The whole path"
NAME="asha.$RUN"; ADDR="$NAME@$DOMAIN"; PW="correct horse battery"
r=$(call POST "$API/api/join/start" "$(start_body "$NAME" 'Asha Test' "+91 ${P1:0:5} ${P1:5}" "$ADULT_DOB" true '' "$TOKEN")")
same "start: 200" "$(status "$r")" "200"
SID=$(jq_ "$(body "$r")" "d['signupId']")
CODE=$(jq_ "$(body "$r")" "d.get('devCode') or ''")
[ -n "$CODE" ] && pass "code shown on screen (no SMS provider locally)" || { fail "no devCode: $(body "$r")"; exit 1; }
same "number masked in the answer" "$(jq_ "$(body "$r")" "d['phoneMasked']")" "•••••••••${P1:6}"
same "stored as a 64-char keyed hash" "$(PG "SELECT length(phone_hash) FROM core.personal_signups WHERE id='$SID'")" "64"
WRONG=$(printf '%06d' $(( (10#$CODE + 1) % 1000000 )))
r=$(call POST "$API/api/join/$SID/verify" "{\"code\":\"$WRONG\"}")
same "wrong code: 400, 4 left" "$(status "$r") $(jq_ "$(body "$r")" "d['attemptsLeft']")" "400 4"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"$PW\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "complete before verifying: refused" "$(status "$r")" "400"
r=$(call POST "$API/api/join/$SID/verify" "{\"code\":\"$CODE\"}")
same "right code: verified" "$(jq_ "$(body "$r")" "d['verified']")" "True"
same "…a number on no other account: no work-account notice" "$(jq_ "$(body "$r")" "d.get('numberOnWorkAccount')")" "False"
r=$(call POST "$API/api/join/$SID/verify" "{\"code\":\"$CODE\"}")
same "verifying again is harmless" "$(jq_ "$(body "$r")" "d['verified']")" "True"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"$PW\",\"acceptTerms\":true,\"acceptPrivacy\":false}")
same "privacy unticked: refused" "$(jq_ "$(body "$r")" "d['field']")" "terms"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"short-pw-11\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "11-character password: refused" "$(jq_ "$(body "$r")" "d['field']")" "password"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"$PW\",\"recoveryEmail\":\"$ADDR\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "recovery email = the new address: refused" "$(jq_ "$(body "$r")" "d['field']")" "recovery"
same "nothing created by the refusals" "$(PG "SELECT count(*) FROM core.users WHERE email='$ADDR'")" "0"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"$PW\",\"recoveryEmail\":\"asha.$RUN@example.test\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "complete: 200" "$(status "$r")" "200"
same "the address comes back" "$(jq_ "$(body "$r")" "d['address']")" "$ADDR"
UID_=$(PG "SELECT id FROM core.users WHERE email='$ADDR'")
same "user: active employee in the house" \
     "$(PG "SELECT u.status||' '||u.role||' '||t.kind FROM core.users u JOIN core.tenants t ON t.id=u.tenant_id WHERE u.id='$UID_'")" \
     "active employee personal_house"
same "mailbox exists, 1 GB" "$(PG "SELECT quota_bytes FROM mail.mailboxes WHERE address='$ADDR'")" "1073741824"
same "personal_accounts: terms version, adult time" \
     "$(PG "SELECT terms_version||' '||(adult_declared_at IS NOT NULL) FROM core.personal_accounts WHERE user_id='$UID_'")" \
     "draft-2026-09-26 true"
same "the number is on the account, canonical" "$(PG "SELECT phone FROM core.users WHERE id='$UID_'")" "+91$P1"
same "plain-text number gone from the signup row" "$(PG "SELECT coalesce(phone,'<null>') FROM core.personal_signups WHERE id='$SID'")" "<null>"
same "recovery email waiting for its link" "$(PG "SELECT (recovery_email_token_hash IS NOT NULL) AND recovery_email_verified_at IS NULL FROM core.users WHERE id='$UID_'")" "t"
r=$(call POST "$API/api/auth/login" "{\"email\":\"$ADDR\",\"password\":\"$PW\"}")
same "signs in with the new password" "$(status "$r")" "200"
r=$(call POST "$API/api/join/$SID/complete" "{\"password\":\"$PW\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "the same signup cannot complete twice" "$(status "$r")" "404"

# ---------------------------------------------------------------------------
step "5. A taken address"
r=$(addr "$NAME")
same "unavailable, same sentence as reserved" "$(jq_ "$(body "$r")" "d['problem']")" "$U"
same "with 3 free suggestions" "$(jq_ "$(body "$r")" "len(d['suggestions'])")" "3"
S1=$(jq_ "$(body "$r")" "d['suggestions'][0]")
same "a suggestion really is free" "$(jq_ "$(body "$(addr "$S1")")" "d['available']")" "True"
r=$(call POST "$API/api/join/start" "$(start_body "$NAME" 'Someone Else' "+91$P2" "$ADULT_DOB" true '' "$TOKEN")")
same "start on it: refused" "$(jq_ "$(body "$r")" "d['field']")" "address"

# ---------------------------------------------------------------------------
step "6. One personal account per phone"
r=$(call POST "$API/api/join/start" "$(start_body "second.$RUN" 'Asha Again' "0$P1" "$ADULT_DOB" true '' "$TOKEN")")
same "same number spelled 0XXXXXXXXXX: 409" "$(status "$r")" "409"
same "told to sign in" "$(jq_ "$(body "$r")" "d.get('signIn')")" "True"

# ---------------------------------------------------------------------------
step "7. SMS limits"
reset_attempts
for i in 1 2 3; do
    r=$(call POST "$API/api/join/start" "$(start_body "lim.$RUN" 'Limit Test' "+91$P3" "$ADULT_DOB" true '' "$TOKEN")")
    same "code $i to one number: 200" "$(status "$r")" "200"
done
r=$(call POST "$API/api/join/start" "$(start_body "lim.$RUN" 'Limit Test' "+91$P3" "$ADULT_DOB" true '' "$TOKEN")")
same "the 4th in an hour: 429" "$(status "$r")" "429"
has "naming the number, not the network" "$(jq_ "$(body "$r")" "d['error']")" "sent to this number"
r=$(call POST "$API/api/join/start" "$(start_body "lim2.$RUN" 'Limit Test' "+91$P4" "$ADULT_DOB" true '' "$TOKEN")")
same "calibration: a different number still gets one" "$(status "$r")" "200"

# code_send_failed counts too (and is all there is locally, with no SMS provider).
IP=$(PG "SELECT ip FROM core.personal_signup_attempts WHERE outcome LIKE 'code_%' AND ip IS NOT NULL LIMIT 1")
[ -n "$IP" ] && pass "attempts record the caller's address ($IP)" || fail "no ip recorded"
PG "INSERT INTO core.personal_signup_attempts(phone_hash, ip, outcome) SELECT 'x'||g, '$IP', 'code_sent' FROM generate_series(1,5) g" >/dev/null
same "9 codes from this address this hour" "$(PG "SELECT count(*) FROM core.personal_signup_attempts WHERE ip='$IP' AND outcome LIKE 'code_%'")" "9"
r=$(call POST "$API/api/join/start" "$(start_body "lim3.$RUN" 'Limit Test' "+91$P5" "$ADULT_DOB" true '' "$TOKEN")")
same "calibration: the 10th from one address still goes" "$(status "$r")" "200"
r=$(call POST "$API/api/join/start" "$(start_body "lim4.$RUN" 'Limit Test' "+91$(num 6)" "$ADULT_DOB" true '' "$TOKEN")")
same "the 11th from one address: 429" "$(status "$r")" "429"
has "naming the network" "$(jq_ "$(body "$r")" "d['error']")" "from your network"

reset_attempts
PG "INSERT INTO core.personal_signup_attempts(phone_hash, ip, outcome) SELECT 'x'||g, '203.0.113.'||g, 'code_sent' FROM generate_series(1,4) g" >/dev/null
PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_codes_per_hour','5')" >/dev/null
r=$(call POST "$API/api/join/start" "$(start_body "lim5.$RUN" 'Limit Test' "+91$(num 7)" "$ADULT_DOB" true '' "$TOKEN")")
same "calibration: the 5th on the platform still goes" "$(status "$r")" "200"
r=$(call POST "$API/api/join/start" "$(start_body "lim6.$RUN" 'Limit Test' "+91$(num 8)" "$ADULT_DOB" true '' "$TOKEN")")
same "the 6th over a ceiling of 5: 429" "$(status "$r")" "429"
has "a busy message" "$(jq_ "$(body "$r")" "d['error']")" "very busy"
PG "DELETE FROM core.platform_settings WHERE key='personal.signup_codes_per_hour'" >/dev/null
reset_attempts

# ---------------------------------------------------------------------------
step "8. A removed reserved name survives the migration re-running"
PG "UPDATE core.reserved_usernames SET removed_at=now() WHERE name='hello'" >/dev/null
out=$(wsl -e bash -c "cd /mnt/c/Users/amitd/Downloads/tatvaos-one/tatvaos-personal && PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -v ON_ERROR_STOP=1 -q -f $MIGRATION" 2>&1; echo "exit=$?")
has "the migration re-runs cleanly" "$out" "exit=0"
same "'hello' is still removed" "$(PG "SELECT removed_at IS NOT NULL FROM core.reserved_usernames WHERE name='hello'")" "t"
PG "UPDATE core.reserved_usernames SET removed_at=NULL WHERE name='hello'" >/dev/null
r=$(call GET "$API/api/admin/reserved-usernames")
same "the operator list needs a sign-in (401)" "$(status "$r")" "401"

# ---------------------------------------------------------------------------
step "10. A work account's number: its phone and SMS sign-in are never touched (Mr. Singh, PR 311)"
# SMS sign-in codes are shown on screen only by a Development API, so the
# work account's sign-in runs there; both APIs share this database.
DEV_API="${TATVAOS_DEV_API:-http://localhost:5297}"
WORK_ID="d1111111-1111-1111-1111-111111111111"; WORK_PHONE="+919999900001"
PG "UPDATE core.users SET phone='$WORK_PHONE', status='active' WHERE id='$WORK_ID'; UPDATE core.users SET phone=NULL WHERE phone='$WORK_PHONE' AND id<>'$WORK_ID'" >/dev/null
work_sms_signin() { # -> the signed-in account's id, or empty
    PG "UPDATE core.users SET login_otp_sent_at=NULL WHERE id='$WORK_ID'" >/dev/null
    local c t
    c=$(jq_ "$(curl -s -X POST "$DEV_API/api/auth/otp/request" -H 'Content-Type: application/json' -d "{\"phone\":\"$WORK_PHONE\"}")" "d.get('devCode') or ''")
    [ -n "$c" ] || return 0
    t=$(jq_ "$(curl -s -X POST "$DEV_API/api/auth/otp/verify" -H 'Content-Type: application/json' -d "{\"phone\":\"$WORK_PHONE\",\"code\":\"$c\"}")" "d.get('accessToken') or ''")
    [ -n "$t" ] || return 0
    printf '%s' "$t" | cut -d. -f2 | "$PY" -c "import sys,base64,json; s=sys.stdin.read().strip(); s+='='*(-len(s)%4); print(json.loads(base64.urlsafe_b64decode(s)).get('sub',''))" 2>/dev/null | tr -d '\r'
}
same "before: the work account signs in by SMS" "$(work_sms_signin)" "$WORK_ID"
reset_attempts
# Re-runnable: an earlier run's personal account on this number would (rightly)
# refuse a second one — "one personal account per number". Forget its row.
PG "DELETE FROM core.personal_accounts WHERE user_id IN (SELECT id FROM core.users WHERE email LIKE 'work.%@$DOMAIN')" >/dev/null
WNAME="work.$RUN"; WADDR="$WNAME@$DOMAIN"
r=$(call POST "$API/api/join/start" "$(start_body "$WNAME" 'Work Number' "${WORK_PHONE:3:5} ${WORK_PHONE:8}" "$ADULT_DOB" true '' "$TOKEN")")
same "a personal signup with the SAME number (typed another way) may start" "$(status "$r")" "200"
WSID=$(jq_ "$(body "$r")" "d['signupId']"); WCODE=$(jq_ "$(body "$r")" "d.get('devCode') or ''")
r=$(call POST "$API/api/join/$WSID/verify" "{\"code\":\"$WCODE\"}")
same "after the code: the page is told the number is on a work account" "$(jq_ "$(body "$r")" "d.get('numberOnWorkAccount')")" "True"
r=$(call POST "$API/api/join/$WSID/complete" "{\"password\":\"$PW\",\"recoveryEmail\":\"work.$RUN@example.test\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "the personal account is created" "$(status "$r")" "200"
WUID=$(PG "SELECT id FROM core.users WHERE email='$WADDR'")
same "…WITHOUT the number (no SMS recovery for it)" "$(PG "SELECT coalesce(phone,'<null>') FROM core.users WHERE id='$WUID'")" "<null>"
same "the WORK account still has its phone, unchanged" "$(PG "SELECT phone FROM core.users WHERE id='$WORK_ID'")" "$WORK_PHONE"
same "…and still signs in by SMS" "$(work_sms_signin)" "$WORK_ID"
# RED FIRST: the check above goes red if signup ever gave the number away.
PG "UPDATE core.users SET phone='$WORK_PHONE' WHERE id='$WUID'" >/dev/null
r=$(work_sms_signin)
if [ "$r" != "$WORK_ID" ]; then pass "RED FIRST: with the number copied onto the personal account, the work account's SMS sign-in FAILS (got [${r:-nothing}])"
else fail "calibration: the work account still signed in with its number on two accounts — the check could not see the harm"; fi
PG "UPDATE core.users SET phone=NULL WHERE id='$WUID'" >/dev/null
same "…restored, it works again" "$(work_sms_signin)" "$WORK_ID"
# And the plain number of the signup row is gone, as for any signup.
same "the signup row keeps no plain number" "$(PG "SELECT coalesce(phone,'<null>') FROM core.personal_signups WHERE id='$WSID'")" "<null>"

# ---------------------------------------------------------------------------
step "11. The phone-hash key: required outside Development, and the fingerprint is stable"
# A fixed number's fingerprint must equal HMAC-SHA256(key, "phone:" + canonical)
# — a pure function of the key and the number, nothing per-process. Computed
# here independently; the key is read from the launcher and never printed.
KEYFILE="${TATVAOS_PROD_LAUNCHER:-.tmp/run-api-prod.sh}"
FIXED="+917000000001"
reset_attempts
PG "DELETE FROM core.personal_signups WHERE phone_hash IS NOT NULL AND local_part LIKE 'fixed.%'" >/dev/null
r=$(call POST "$API/api/join/start" "$(start_body "fixed.$RUN" 'Fixed Number' "$FIXED" "$ADULT_DOB" true '' "$TOKEN")")
H1=$(PG "SELECT phone_hash FROM core.personal_signups WHERE id='$(jq_ "$(body "$r")" "d['signupId']")'")
EXPECT=$("$PY" - "$KEYFILE" "$FIXED" <<'PYEOF'
import sys, re, hmac, hashlib
m = re.search(r"Personal__PhoneHashKey='([^']+)'", open(sys.argv[1], encoding='utf-8').read())
print(hmac.new(m.group(1).strip().encode(), ("phone:" + sys.argv[2]).encode(), hashlib.sha256).hexdigest() if m else '')
PYEOF
)
same "the stored fingerprint = HMAC-SHA256(key, 'phone:+91…'), computed independently" "$H1" "$EXPECT"

# A second, FRESH API process (Production) on its own port: once without the
# key — it must refuse to start — and once with it — same fingerprint.
sed -e "s/5298/5299/g" -e "s/10326/10327/g" "$KEYFILE" > .tmp/run-api-5299.sh
grep -v "Personal__PhoneHashKey" .tmp/run-api-5299.sh > .tmp/run-api-5299-nokey.sh
timeout 90 bash .tmp/run-api-5299-nokey.sh > .tmp/api-5299-nokey.log 2>&1; rc=$?
if [ "$rc" != "0" ] && [ "$rc" != "124" ]; then pass "without the key, a Production API EXITS (code $rc)"; else fail "without the key the API did not exit (rc $rc)"; fi
has "…saying why" "$(cat .tmp/api-5299-nokey.log)" "Refusing to start: Personal:PhoneHashKey is missing"
bash .tmp/run-api-5299.sh > .tmp/api-5299.log 2>&1 &
for _ in $(seq 1 45); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5299/health)" = "200" ] && break; sleep 2; done
same "with the key, the fresh process starts" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5299/health)" "200"
reset_attempts
# The run's own form token, issued by the OTHER process minutes ago: a fresh
# token would be refused as "filled too fast", and accepting this one shows
# the same key signs across processes too.
r=$(call POST "http://localhost:5299/api/join/start" "$(start_body "fixed.$RUN" 'Fixed Number' "0${FIXED:3}" "$ADULT_DOB" true '' "$TOKEN")")
[ "$(status "$r")" = "200" ] || printf '     start on the fresh process: %s %s
' "$(status "$r")" "$(body "$r" | head -c 200)"
H2=$(PG "SELECT phone_hash FROM core.personal_signups WHERE id='$(jq_ "$(body "$r")" "d.get('signupId') or ''")'")
same "the fresh process gives the SAME fingerprint (restart-stable)" "$H2" "$H1"
# Stop the fresh process. The port is listed more than once (IPv4, IPv6), so
# take ONE id — and check it is gone, rather than leave it holding the
# build's exe (the next build then fails, MSB3027).
pid=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 5299 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess" 2>/dev/null | tr -d '\r' | head -1)
[ -n "$pid" ] && powershell -NoProfile -Command "Stop-Process -Id $pid -Force" >/dev/null 2>&1
sleep 2
same "the fresh process is stopped again" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5299/health)" "000"
rm -f .tmp/run-api-5299.sh .tmp/run-api-5299-nokey.sh

# ---------------------------------------------------------------------------
step "9. No phone number in the API's log"
# MUST be an API running as Production. In Development, EF's sensitive-data
# logging prints every saved value — numbers included — by design, and the
# API refuses to start as Production with it on (Program.cs). So a
# Development log proves nothing either way; this step says which it read.
if grep -qF -- "Hosting environment: Development" "$LOG"; then
    fail "the log is a DEVELOPMENT API's — run the API with ASPNETCORE_ENVIRONMENT=Production for this step"
fi
sleep 1
grep -qF -- "$SID" "$LOG" && pass "the log is this API's (holds signup $SID)" || fail "signup $SID not in $LOG — wrong log?"
leaks=0
for n in $ALL_NUMBERS $(num 6) $(num 7) $(num 8) 9999900001 7000000001; do
    for s in "$n" "91$n" "+91$n" "${n:0:5} ${n:5}"; do
        if grep -qF -- "$s" "$LOG"; then leaks=$((leaks+1)); fail "'$s' appears in the log"; fi
    done
done
[ "$leaks" = "0" ] && pass "none of this run's numbers, in any spelling"

# ---------------------------------------------------------------------------
PG "DELETE FROM core.platform_settings WHERE key='personal.signup_open'" >/dev/null
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
