#!/usr/bin/env bash
#
# TatvaOS — a personal account's life after signup (build plan
# personal-plans-build-plan.md §8, §9, §4.2 — part F).
#
# The clock is fast-forwarded by moving the account's own dates back (last
# sign-in, warning dates, delete_after) and asking the operator's "run one
# lifecycle pass now" — the same code the hourly worker runs.
#
#   1. Download my data: one zip with account.json, every message (.eml), every
#      Space file (the same bytes), contacts.vcf, calendars (.ics)
#   2. Self-delete: the password is required; cancellable in the 7 days;
#      nothing happens before day 7; on day 7 EVERYTHING goes — the person,
#      mailbox and messages, Space files AND their blobs on disk, the maildir
#      on disk, contacts, meetings they hosted — while the AI trial record
#      stays (one per phone, ever) and the audit row is written
#   3. The address is held 90 days, then free; and held BEYOND that while a
#      maildir leftover exists (calibrated: a file the purge could not delete)
#   4. Inactive: 12 months → warning, +30 days → second warning, +90 days from
#      the first → deleted; signing in after a warning clears it (calibrated)
#   5. Suspension: a reason is required; the person can still sign in and
#      download, cannot send; resumed, the suspension is no longer the reason
#   6. The operator's list: search, filters, statuses, NO phone field; the
#      numbers; the operator's delete needs the address typed back
#   7. Organisations untouched: the purge refuses an organisation's person,
#      and the operator routes answer "not a personal account"
#
# Needs: the Development API ($TATVAOS_API) from .tmp/run-api.sh with
# Mail__VmailRoot=$VMAIL, Space__BlobRoot=$BLOBS and Smtp__Port pointing at a
# local mail catcher (warnings count only when the mail edge takes them);
# DevOperatorSignIn on; the database from local/postgres/init.
#   bash tests/personal-lifecycle/test-lifecycle.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
VMAIL="${TATVAOS_VMAIL:-.tmp/vmail}"
BLOBS="${TATVAOS_BLOBS:-.tmp/blobs}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
TECHVEIN_OWNER="d1111111-1111-1111-1111-111111111111"
RUN=$(date +%s)
PW="a long enough passphrase"

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 200)]"; fi; }
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
PGX() { local out; out=$($PSQL "$1" 2>&1 | tr -d '\r'); if printf '%s' "$out" | grep -q "ERROR"; then fail "setup SQL: $out"; fi; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d '\r'; }
jq_() { printf '%s' "$1" | j "$2"; }
req() {
    local a=(-s -w '\n%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
    [ -n "$3" ] && a+=(-H "Authorization: Bearer $3")
    [ -n "${4:-}" ] && a+=(-d "$4")
    curl "${a[@]}"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
run_pass() { req POST /api/admin/personal-lifecycle/run "$OP" >/dev/null; }
login() { jq_ "$(body "$(req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PW\"}")")" "d.get('accessToken') or ''"; }
available() { jq_ "$(body "$(req GET "/api/join/address?name=$1" "")")" "d['available']"; }

# ---------------------------------------------------------------------------
step "0. Three personal accounts; an operator"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ] && pass "API health 200" || { fail "API down"; exit 1; }
OP=$(jq_ "$(body "$(req POST /api/dev/operator-session "")")" "d['accessToken']")
[ -n "$OP" ] && pass "operator session" || { fail "no operator"; exit 1; }
PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_open','true') ON CONFLICT (key) DO UPDATE SET value='true'; DELETE FROM core.personal_signup_attempts" >/dev/null
join_one() {
    local tok sid code r
    tok=$(jq_ "$(body "$(req GET /api/join/status "")")" "d['formToken']"); sleep 5
    r=$(req POST /api/join/start "" "{\"localPart\":\"$1\",\"displayName\":\"$2\",\"phone\":\"$3\",\"dateOfBirth\":\"1990-01-01\",\"declaredAdult\":true,\"website\":\"\",\"formToken\":\"$tok\"}")
    sid=$(jq_ "$(body "$r")" "d['signupId']"); code=$(jq_ "$(body "$r")" "d['devCode']")
    req POST "/api/join/$sid/verify" "" "{\"code\":\"$code\"}" >/dev/null
    req POST "/api/join/$sid/complete" "" "{\"password\":\"$PW\",\"acceptTerms\":true,\"acceptPrivacy\":true}" >/dev/null
}
A_NAME="lifea.$RUN"; B_NAME="lifeb.$RUN"; C_NAME="lifec.$RUN"
A_ADDR="$A_NAME@personal.local"; B_ADDR="$B_NAME@personal.local"; C_ADDR="$C_NAME@personal.local"
join_one "$A_NAME" "Life Alpha" "7$(printf '%09d' $((RUN % 1000000000)))"
join_one "$B_NAME" "Life Beta"  "6$(printf '%09d' $(((RUN + 41) % 1000000000)))"
join_one "$C_NAME" "Life Gamma" "8$(printf '%09d' $(((RUN + 83) % 1000000000)))"
A=$(login "$A_ADDR"); B=$(login "$B_ADDR"); C=$(login "$C_ADDR")
[ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] && pass "A, B and C signed in" || { fail "accounts"; exit 1; }
A_ID=$(PG "SELECT id FROM core.users WHERE email='$A_ADDR'")
B_ID=$(PG "SELECT id FROM core.users WHERE email='$B_ADDR'")
C_ID=$(PG "SELECT id FROM core.users WHERE email='$C_ADDR'")

# A's things: a contact, a file, a meeting, an event, a message, the AI trial, a maildir.
req POST /api/family/contacts "$A" "{\"displayName\":\"Alpha Friend $RUN\",\"email\":\"friend.$RUN@example.test\"}" >/dev/null
printf 'the exact bytes of alpha %s' "$RUN" > ".tmp/alpha-$RUN.txt"
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/space/files" -H "Authorization: Bearer $A" \
      -F "sizeBytes=$(wc -c < ".tmp/alpha-$RUN.txt")" -F "scope=personal" -F "file=@.tmp/alpha-$RUN.txt;filename=alpha.txt;type=text/plain")
A_FILE=$(jq_ "$(body "$r")" "d.get('id')")
A_BLOB=$(PG "SELECT blob_key FROM space.files WHERE id='$A_FILE'")
req POST /api/connect/meetings "$A" "{\"title\":\"Alpha meeting $RUN\"}" >/dev/null
req POST /api/calendar/events "$A" "{\"title\":\"Alpha event $RUN\",\"startsAt\":\"2026-12-01T10:00:00Z\",\"endsAt\":\"2026-12-01T11:00:00Z\",\"isAllDay\":false}" >/dev/null
A_BOX=$(PG "SELECT id FROM mail.mailboxes WHERE address='$A_ADDR'")
A_INBOX=$(PG "SELECT id FROM mail.folders WHERE mailbox_id='$A_BOX' AND name='INBOX' LIMIT 1")
PGX "INSERT INTO mail.messages(tenant_id, mailbox_id, folder_id, imap_uid, subject, received_at, size_bytes, raw_body)
     SELECT tenant_id, id, '$A_INBOX', 1, 'Alpha letter $RUN', now(), 60, 'Subject: Alpha letter $RUN'||E'\r\n\r\n'||'hello alpha' FROM mail.mailboxes WHERE id='$A_BOX'"
req PUT /api/me/ai "$A" '{"on":true,"confirm":true}' >/dev/null
A_HASH=$(PG "SELECT phone_hash FROM core.personal_accounts WHERE user_id='$A_ID'")
mkdir -p "$VMAIL/personal.local/$A_NAME/cur" && printf 'Subject: on disk\r\n\r\nold mail' > "$VMAIL/personal.local/$A_NAME/cur/1.eml"
[ -n "$A_BLOB" ] && [ -f "$BLOBS/$A_BLOB" -o -n "$(find "$BLOBS" -name "$(basename "$A_BLOB")" 2>/dev/null)" ] && pass "A's file is on disk" || fail "A's blob not found under $BLOBS ($A_BLOB)"
same "A's trial started" "$(PG "SELECT count(*) FROM core.ai_trials WHERE phone_hash='$A_HASH'")" "1"

# ---------------------------------------------------------------------------
step "1. Download my data (§4.2)"
curl -s -o ".tmp/export-$RUN.zip" -w '%{http_code}' "$API/api/me/export" -H "Authorization: Bearer $A" > ".tmp/export-$RUN.status"
same "the export answers 200" "$(cat ".tmp/export-$RUN.status")" "200"
listing=$("$PY" -c "import zipfile,sys; print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))" ".tmp/export-$RUN.zip" 2>&1)
has "account.json" "$listing" "account.json"
has "the message, as .eml" "$listing" "Alpha letter $RUN.eml"
has "the Space file" "$listing" "space/alpha.txt"
has "contacts.vcf" "$listing" "contacts.vcf"
has "a calendar .ics" "$listing" "calendar/"
same "the file's bytes are exactly what was uploaded" \
     "$("$PY" -c "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('space/alpha.txt').decode())" ".tmp/export-$RUN.zip")" \
     "the exact bytes of alpha $RUN"
has "the contact is in the vCard" "$("$PY" -c "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('contacts.vcf').decode())" ".tmp/export-$RUN.zip")" "Alpha Friend $RUN"
has "the event is in the .ics" "$("$PY" -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(''.join(z.read(n).decode() for n in z.namelist() if n.startswith('calendar/')))" ".tmp/export-$RUN.zip")" "SUMMARY:Alpha event $RUN"
if printf '%s' "$listing" | grep -qF "Life Beta"; then fail "another person's data in A's export"; else pass "nothing of B's in A's export"; fi

# ---------------------------------------------------------------------------
step "2. Self-delete (§8): 7 days' grace, then everything"
r=$(req POST /api/me/delete "$A" '{"password":"not the password"}')
same "the wrong password: refused" "$(status "$r")" "400"
r=$(req POST /api/me/delete "$A" "{\"password\":\"$PW\"}")
same "the right password: scheduled" "$(status "$r")" "200"
same "for 7 days from now" "$(PG "SELECT (delete_after BETWEEN now()+interval '6 days 23 hours' AND now()+interval '7 days 1 minute')::text FROM core.personal_accounts WHERE user_id='$A_ID'")" "true"
same "it can be cancelled" "$(jq_ "$(body "$(req GET /api/me/lifecycle "$A")")" "d['canCancel']")" "True"
same "cancel" "$(status "$(req POST /api/me/delete/cancel "$A")")" "200"
same "…and it is off" "$(PG "SELECT coalesce(delete_after::text,'none') FROM core.personal_accounts WHERE user_id='$A_ID'")" "none"
req POST /api/me/delete "$A" "{\"password\":\"$PW\"}" >/dev/null
run_pass
same "day 0: a pass does nothing yet" "$(PG "SELECT count(*) FROM core.users WHERE id='$A_ID'")" "1"
PG "UPDATE core.personal_accounts SET delete_after=now()-interval '1 minute' WHERE user_id='$A_ID'" >/dev/null
run_pass
same "day 7: the person is gone" "$(PG "SELECT count(*) FROM core.users WHERE id='$A_ID'")" "0"
same "…their mailbox and messages" "$(PG "SELECT count(*) FROM mail.mailboxes WHERE address='$A_ADDR'")|$(PG "SELECT count(*) FROM mail.messages WHERE subject='Alpha letter $RUN'")" "0|0"
same "…their Space file row" "$(PG "SELECT count(*) FROM space.files WHERE id='$A_FILE'")" "0"
if [ -n "$(find "$BLOBS" -name "$(basename "$A_BLOB")" 2>/dev/null)" ]; then fail "the blob is still on disk"; else pass "…and its bytes, on disk"; fi
[ -d "$VMAIL/personal.local/$A_NAME" ] && fail "the maildir is still on disk" || pass "…the maildir, on disk"
same "…their contacts" "$(PG "SELECT count(*) FROM family.contacts WHERE display_name='Alpha Friend $RUN'")" "0"
same "…the meetings they hosted" "$(PG "SELECT count(*) FROM connect.meetings WHERE title='Alpha meeting $RUN'")" "0"
same "…their calendar" "$(PG "SELECT count(*) FROM calendar.events WHERE title='Alpha event $RUN'")" "0"
same "the AI trial record stays, nameless (one per phone, ever)" "$(PG "SELECT count(*)||' '||coalesce(user_id::text,'null') FROM core.ai_trials WHERE phone_hash='$A_HASH' GROUP BY user_id")" "1 null"
same "the purge is in the audit log" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%personal.account_purged' AND target_id='$A_ID'")" "1"
same "A cannot sign in" "$(status "$(req POST /api/auth/login "" "{\"email\":\"$A_ADDR\",\"password\":\"$PW\"}")")" "401"

step "3. The address is held (§8), and never while its old mail may be on disk"
same "held: A's address is not available" "$(available "$A_NAME")" "False"
same "for 90 days" "$(PG "SELECT (held_until BETWEEN now()+interval '89 days' AND now()+interval '90 days 1 minute')::text FROM core.address_holds WHERE address='$A_ADDR'")" "true"
PG "UPDATE core.address_holds SET held_until=now()-interval '1 minute' WHERE address='$A_ADDR'" >/dev/null
same "day 90: free again" "$(available "$A_NAME")" "True"

# ---------------------------------------------------------------------------
step "4. Inactive (§8): 12 months, two warnings, deleted 90 days after the first"
age_b() { PG "UPDATE core.users SET last_login_at=now()-interval '$1', created_at=now()-interval '2 years' WHERE id='$B_ID'; UPDATE core.refresh_tokens SET issued_at=now()-interval '$1' WHERE user_id='$B_ID'" >/dev/null; }
age_b "300 days"
run_pass
same "300 days unused: no warning" "$(PG "SELECT coalesce(inactive_warned_at::text,'none') FROM core.personal_accounts WHERE user_id='$B_ID'")" "none"
age_b "366 days"
run_pass
same "366 days unused: the first warning" "$(PG "SELECT (inactive_warned_at IS NOT NULL)::text FROM core.personal_accounts WHERE user_id='$B_ID'")" "true"
# Calibration: coming back after a warning clears it.
PG "UPDATE core.users SET last_login_at=now() WHERE id='$B_ID'" >/dev/null
run_pass
same "B signs in: the warning is cleared" "$(PG "SELECT coalesce(inactive_warned_at::text,'none') FROM core.personal_accounts WHERE user_id='$B_ID'")" "none"
age_b "366 days"; run_pass
PG "UPDATE core.personal_accounts SET inactive_warned_at=now()-interval '31 days' WHERE user_id='$B_ID'" >/dev/null
run_pass
same "30 days after the first: the second warning" "$(PG "SELECT (inactive_final_warned_at IS NOT NULL)::text FROM core.personal_accounts WHERE user_id='$B_ID'")" "true"
same "…still there" "$(PG "SELECT count(*) FROM core.users WHERE id='$B_ID'")" "1"
PG "UPDATE core.personal_accounts SET inactive_warned_at=now()-interval '91 days' WHERE user_id='$B_ID'" >/dev/null
run_pass
same "90 days after the first: deleted" "$(PG "SELECT count(*) FROM core.users WHERE id='$B_ID'")" "0"
same "C, signed in today, was never warned" "$(PG "SELECT coalesce(inactive_warned_at::text,'none') FROM core.personal_accounts WHERE user_id='$C_ID'")" "none"

# ---------------------------------------------------------------------------
step "5. Suspension (§8)"
r=$(req POST "/api/admin/personal-accounts/$C_ID/suspend" "$OP" '{}')
same "no reason: refused" "$(status "$r")" "400"
r=$(req POST "/api/admin/personal-accounts/$C_ID/suspend" "$OP" '{"reason":"spam complaints (test)"}')
same "suspended" "$(status "$r")" "200"
same "the reason is kept" "$(PG "SELECT suspended_reason FROM core.personal_accounts WHERE user_id='$C_ID'")" "spam complaints (test)"
C2=$(login "$C_ADDR")
[ -n "$C2" ] && pass "a suspended person can still sign in" || fail "suspended sign-in refused"
same "…and download their data" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me/export" -H "Authorization: Bearer $C2")" "200"
r=$(curl -s -X POST "$API/api/mail/send" -H "Authorization: Bearer $C2" -F "to=someone@example.test" -F "subject=hi" -F "bodyText=hi")
has "…but cannot send" "$r" "can't send mail right now"
same "resume" "$(status "$(req POST "/api/admin/personal-accounts/$C_ID/resume" "$OP")")" "200"
r=$(curl -s -X POST "$API/api/mail/send" -H "Authorization: Bearer $C2" -F "to=someone@example.test" -F "subject=hi" -F "bodyText=hi")
if printf '%s' "$r" | grep -qF "can't send mail right now"; then fail "still refused as suspended after resume"; else pass "calibration: after resume, the suspension is no longer the refusal"; fi

# ---------------------------------------------------------------------------
step "6. The operator's list, numbers and delete (§9)"
req POST "/api/admin/personal-accounts/$C_ID/suspend" "$OP" '{"reason":"list test"}' >/dev/null
l=$(body "$(req GET "/api/admin/personal-accounts?q=lifec.$RUN&filter=suspended" "$OP")")
same "search + filter find C, suspended" "$(jq_ "$l" "(len(d['rows']), d['rows'][0]['email'], d['rows'][0]['status'])")" "(1, '$C_ADDR', 'suspended')"
same "…with plan and storage" "$(jq_ "$l" "(d['rows'][0]['plan'], d['rows'][0]['quotaBytes'])")" "('Free', 1073741824)"
if printf '%s' "$l" | grep -qi '"phone'; then fail "a phone field is in the operator's list"; else pass "no phone field anywhere in the list"; fi
same "filter 'free' holds C too" "$(jq_ "$(body "$(req GET "/api/admin/personal-accounts?q=lifec.$RUN&filter=free" "$OP")")" "len(d['rows'])")" "1"
same "filter 'paid' does not" "$(jq_ "$(body "$(req GET "/api/admin/personal-accounts?q=lifec.$RUN&filter=paid" "$OP")")" "len(d['rows'])")" "0"
s=$(body "$(req GET /api/admin/personal-accounts/stats "$OP")")
same "the numbers answer (trials started counted)" "$(jq_ "$s" "d['trialsStarted'] >= 1 and d['suspended'] >= 1")" "True"
r=$(req POST "/api/admin/personal-accounts/$C_ID/delete" "$OP" '{"reason":"test","confirmAddress":"wrong@personal.local"}')
same "delete with the wrong address typed: refused" "$(status "$r")" "400"

# The maildir calibration rides on C's deletion: a file the purge cannot remove.
mkdir -p "$VMAIL/personal.local/$C_NAME/cur" && printf 'x' > "$VMAIL/personal.local/$C_NAME/cur/locked.eml"
attrib +r "$(cygpath -w "$VMAIL/personal.local/$C_NAME/cur/locked.eml")" >/dev/null 2>&1 || chmod a-w "$VMAIL/personal.local/$C_NAME/cur/locked.eml"
r=$(req POST "/api/admin/personal-accounts/$C_ID/delete" "$OP" "{\"reason\":\"test\",\"confirmAddress\":\"$C_ADDR\"}")
same "delete with the address typed back: scheduled" "$(status "$r")" "200"
run_pass
same "C is gone at the next pass" "$(PG "SELECT count(*) FROM core.users WHERE id='$C_ID'")" "0"
same "the maildir it could not delete is recorded" "$(PG "SELECT count(*) FROM core.personal_purge_leftovers WHERE kind='maildir' AND address='$C_ADDR'")" "1"
PG "UPDATE core.address_holds SET held_until=now()-interval '1 minute' WHERE address='$C_ADDR'" >/dev/null
same "past its 90 days, the address is STILL held (the old mail may be on disk)" "$(available "$C_NAME")" "False"
attrib -r "$(cygpath -w "$VMAIL/personal.local/$C_NAME/cur/locked.eml")" >/dev/null 2>&1 || chmod u+w "$VMAIL/personal.local/$C_NAME/cur/locked.eml"
run_pass
same "the retry removes it" "$(PG "SELECT count(*) FROM core.personal_purge_leftovers WHERE address='$C_ADDR'")" "0"
[ -d "$VMAIL/personal.local/$C_NAME" ] && fail "C's maildir still on disk" || pass "…from disk"
same "…and only then is the address free" "$(available "$C_NAME")" "True"

# ---------------------------------------------------------------------------
step "7. Organisations untouched"
same "the operator's routes: an organisation person is 'not a personal account'" \
     "$(status "$(req POST "/api/admin/personal-accounts/$TECHVEIN_OWNER/suspend" "$OP" '{"reason":"x"}')")" "404"
APW=$(grep -o "Username=tatvaos_app;Password=[^;']*" .tmp/run-api.sh | sed 's/.*Password=//')
r=$(wsl -e env PGPASSWORD="$APW" psql -h localhost -U tatvaos_app -d tatvaos_personal -Atc "SELECT * FROM core.purge_personal_account('$TECHVEIN_OWNER')" 2>&1 | tr -d '\r')
has "the purge function refuses an organisation's person" "$r" "is not a personal account"
same "…who is still there" "$(PG "SELECT count(*) FROM core.users WHERE id='$TECHVEIN_OWNER'")" "1"

PG "DELETE FROM core.platform_settings WHERE key='personal.signup_open'" >/dev/null
rm -f ".tmp/alpha-$RUN.txt" ".tmp/export-$RUN.zip" ".tmp/export-$RUN.status"
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
