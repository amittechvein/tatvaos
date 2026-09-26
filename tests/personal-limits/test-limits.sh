#!/usr/bin/env bash
#
# TatvaOS — personal plan limits in each product, the per-person AI switch
# and the trial (build plan personal-plans-build-plan.md §4, §5, §11, part D).
#
# Every limit is shown stopping AT ITS EDGE and calibrated from the other
# side (the same request allowed just below the limit, or on a bigger plan):
#
#   1. storage follows the plan (1 GB Free → 10 GB Premium → back), an upload
#      over the allowance is refused, and incoming mail over it is DEFERRED
#      by the mail-edge policy service ("mailbox full"), never accepted
#   2. public links: refused on Free, allowed on Basic
#   3. Connect, the HOST's plan: the 6th person refused on Free (signed in and
#      by the guest door), the host told, the 5th allowed; recording refused on
#      Free even when called directly, and not for that reason on Premium;
#      a meeting past 60 minutes is ended by the server (asked of the media
#      server — locally there is none, so the log line and "not marked ended"
#      are the proof)
#   4. AI: the person's own switch needs confirming; switching on starts the
#      15-day trial ONCE per phone; minutes are written by AI for a host in
#      trial with the switch on, and not for a host without it; a trial that
#      has ended stops them; Mail AI is refused for personal accounts;
#      an organisation account is told AI is its administrator's
#
# Needs: the Development API ($TATVAOS_API) started from .tmp/run-api.sh with
# Connect__Recording__Enabled=true, Mail__PolicyPort=$POLICY_PORT and
# Mail__QuotaEnforcement=enforce, Ai__BaseUrl pointing at a fake provider
# ($FAKE_AI, a copy of tests/ai/fake-ai-mail.mjs on its own port); the
# database from local/postgres/init.     bash tests/personal-limits/test-limits.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
FAKE_AI="${TATVAOS_FAKE_AI:-http://127.0.0.1:5399}"
POLICY_PORT="${TATVAOS_POLICY_PORT:-10325}"
LOG="${TATVAOS_API_LOG:-.tmp/api.log}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
HOUSE="99999999-9999-9999-9999-999999999999"
FREE="b0000000-0000-0000-0000-000000000001"
BASIC="b0000000-0000-0000-0000-000000000002"
PREMIUM="b0000000-0000-0000-0000-000000000003"
OWNER_PHONE="+919999900001"
GB=1073741824
RUN=$(date +%s)

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
has() { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$2]"; fi; }
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
# Setup SQL must not fail quietly: the first run lost every transcript to a
# CHECK nobody saw, and the notes steps then 'failed' for the wrong reason.
PGX() {
    local out; out=$($PSQL "$1" 2>&1 | tr -d '\r')
    if printf '%s' "$out" | grep -q "ERROR"; then fail "setup SQL: $out"; fi
}
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
plan_to() { req PUT "/api/admin/personal-accounts/$1/plan" "$OP" "{\"planId\":\"$2\",\"reason\":\"test-limits $RUN\"}" >/dev/null; }
quota_of() { PG "SELECT quota_bytes FROM core.user_storage('$1')"; }
policy() { # recipient size -> the policy service's action line
    "$PY" - "$1" "$2" "$POLICY_PORT" <<'PYEOF'
import socket, sys
rcpt, size, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = socket.create_connection(("127.0.0.1", port), timeout=10)
s.sendall(f"request=smtpd_access_policy\nprotocol_state=RCPT\nrecipient={rcpt}\nsize={size}\nsender=probe@example.test\n\n".encode())
data = b""
while not data.endswith(b"\n\n"):
    chunk = s.recv(4096)
    if not chunk: break
    data += chunk
print(data.decode().strip())
PYEOF
}
upload() { # token bytes -> "body\nstatus"
    head -c "$2" /dev/zero | tr '\0' 'x' > ".tmp/up-$RUN.txt"
    curl -s -w '\n%{http_code}' -X POST "$API/api/space/files?scope=personal" -H "Authorization: Bearer $1" \
         -F "sizeBytes=$2" -F "scope=personal" -F "file=@.tmp/up-$RUN.txt;filename=up-$RUN-$RANDOM.txt;type=text/plain"
}

# ---------------------------------------------------------------------------
step "0. Two Free personal accounts, an operator, an organisation owner"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$h" = "200" ] && pass "API health 200" || { fail "API health $h"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FAKE_AI/hits")" = "200" ] && pass "fake AI provider answers" || { fail "no fake AI at $FAKE_AI"; exit 1; }
OP=$(jq_ "$(body "$(req POST /api/dev/operator-session "")")" "d['accessToken']")
[ -n "$OP" ] && pass "operator session" || { fail "no operator"; exit 1; }
PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_open','true') ON CONFLICT (key) DO UPDATE SET value='true'; DELETE FROM core.personal_signup_attempts" >/dev/null

join_one() {
    local tok sid code r
    tok=$(jq_ "$(body "$(req GET /api/join/status "")")" "d['formToken']"); sleep 5
    r=$(req POST /api/join/start "" "{\"localPart\":\"$1\",\"displayName\":\"$2\",\"phone\":\"$3\",\"dateOfBirth\":\"1990-01-01\",\"declaredAdult\":true,\"website\":\"\",\"formToken\":\"$tok\"}")
    sid=$(jq_ "$(body "$r")" "d['signupId']"); code=$(jq_ "$(body "$r")" "d['devCode']")
    req POST "/api/join/$sid/verify" "" "{\"code\":\"$code\"}" >/dev/null
    req POST "/api/join/$sid/complete" "" "{\"password\":\"a long enough passphrase\",\"acceptTerms\":true,\"acceptPrivacy\":true}" >/dev/null
    jq_ "$(body "$(req POST /api/auth/login "" "{\"email\":\"$1@personal.local\",\"password\":\"a long enough passphrase\"}")")" "d['accessToken']"
}
A=$(join_one "lima.$RUN" "Lima Host" "7$(printf '%09d' $((RUN % 1000000000)))")
B=$(join_one "limb.$RUN" "Limb Guest" "6$(printf '%09d' $(((RUN + 29) % 1000000000)))")
[ -n "$A" ] && [ -n "$B" ] && pass "A and B are Free personal accounts" || { fail "could not make accounts"; exit 1; }
A_ID=$(PG "SELECT id FROM core.users WHERE email='lima.$RUN@personal.local'")
B_ID=$(PG "SELECT id FROM core.users WHERE email='limb.$RUN@personal.local'")
PG "UPDATE core.users SET phone='$OWNER_PHONE', role='org_owner' WHERE id='d1111111-1111-1111-1111-111111111111' AND (phone IS NULL OR phone='$OWNER_PHONE'); UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
code=$(jq_ "$(body "$(req POST /api/auth/otp/request "" "{\"phone\":\"$OWNER_PHONE\"}")")" "d.get('devCode') or ''")
ORG=$(jq_ "$(body "$(req POST /api/auth/otp/verify "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")")" "d.get('accessToken') or ''")
[ -n "$ORG" ] && pass "Techvein owner signed in" || fail "no org sign-in"

# ---------------------------------------------------------------------------
step "1. Storage follows the plan (§2.3, §4.2, §4.3)"
same "Free: 1 GB" "$(quota_of "$A_ID")" "$GB"
plan_to "$A_ID" "$PREMIUM"
same "Premium: 10 GB, at the next check" "$(quota_of "$A_ID")" "$((10 * GB))"
same "…and the Account page's storage says 10 GB" "$(jq_ "$(body "$(req GET /api/account/storage "$A")")" "d.get('quotaBytes') or d.get('totalBytes') or d.get('quota')")" "$((10 * GB))"
plan_to "$A_ID" "$FREE"
same "back to Free: 1 GB" "$(quota_of "$A_ID")" "$GB"
same "an organisation person is unchanged (stored allowance)" \
     "$(PG "SELECT (s.quota_bytes IS NOT DISTINCT FROM u.storage_quota_bytes)::text FROM core.users u, core.user_storage(u.id) s WHERE u.id='d1111111-1111-1111-1111-111111111111'")" "true"

PG "UPDATE core.plans SET per_user_quota_bytes=3000 WHERE id='$FREE'" >/dev/null
r=$(upload "$A" 5000)
same "an upload over the allowance: refused (413)" "$(status "$r")" "413"
a=$(policy "lima.$RUN@personal.local" 5000)
has "incoming mail over it: deferred as mailbox full" "$a" "Mailbox is full"
has "…a temporary refusal the sender is told about, not an accept" "$a" "452"
PG "UPDATE core.plans SET per_user_quota_bytes=$GB WHERE id='$FREE'" >/dev/null
r=$(upload "$A" 5000)
[ "$(status "$r")" -lt 300 ] && pass "calibration: the same upload fits in 1 GB ($(status "$r"))" || fail "upload at 1 GB: $(status "$r") $(body "$r" | head -c 160)"
FILE_ID=$(jq_ "$(body "$r")" "d.get('id') or d.get('file',{}).get('id')")
a=$(policy "lima.$RUN@personal.local" 5000)
if printf '%s' "$a" | grep -qF "452"; then fail "calibration: mail still deferred at 1 GB: $a"; else pass "calibration: the same mail is accepted at 1 GB ($a)"; fi

# ---------------------------------------------------------------------------
step "2. Public links follow the plan (§2.3, §4.6)"
r=$(req POST "/api/space/files/$FILE_ID/link" "$A" "{}")
same "Free: refused" "$(status "$r")" "403"
has "…saying which plans have them" "$(jq_ "$(body "$r")" "d['error']")" "Basic and Premium"
plan_to "$A_ID" "$BASIC"
r=$(req POST "/api/space/files/$FILE_ID/link" "$A" "{}")
[ "$(status "$r")" -lt 300 ] && pass "Basic: allowed ($(status "$r"))" || fail "Basic link: $(status "$r") $(body "$r" | head -c 160)"
plan_to "$A_ID" "$FREE"

# ---------------------------------------------------------------------------
step "3. Connect — the host's plan decides (D2, §4.5)"
M=$(body "$(req POST /api/connect/meetings "$A" "{\"title\":\"Free meet $RUN\",\"allowGuests\":true,\"waitingRoom\":\"off\"}")")
M_ID=$(jq_ "$M" "d['id']"); M_CODE=$(jq_ "$M" "d['code']")
g=$(body "$(req GET "/api/connect/meetings/$M_ID" "$A")")
same "the room is told the limits" "$(jq_ "$g" "(d['planLimits']['maxPeople'], d['planLimits']['maxMinutes'], d['planLimits']['recording'])")" "(5, 60, False)"
PG "UPDATE connect.meetings SET status='active', started_at=now() WHERE id='$M_ID'" >/dev/null
# Four people in the room (events, as the webhook would write them).
for i in 1 2 3 4; do
    PG "INSERT INTO connect.meeting_events(meeting_id, kind, identity, display_name, occurred_at) VALUES ('$M_ID','participant_joined','guest:0000000$i-0000-0000-0000-00000000$RUN','P$i', now())" >/dev/null
done
same "4 people in the room" "$(PG "SELECT count(DISTINCT identity) FROM connect.meeting_events WHERE meeting_id='$M_ID' AND kind='participant_joined'")" "4"
r=$(req POST "/api/connect/meetings/$M_ID/join" "$B" "{}")
same "the 5th person (B, signed in) gets in" "$(jq_ "$(body "$r")" "d.get('status')")" "joined"
PG "INSERT INTO connect.meeting_events(meeting_id, kind, identity, display_name, occurred_at) VALUES ('$M_ID','participant_joined','user:$B_ID~dev1','B', now())" >/dev/null
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/connect/g/$M_CODE/join" -H 'Content-Type: application/json' -d '{"displayName":"Sixth Guest"}')
same "the 6th (a guest) is refused: 409" "$(status "$r")" "409"
same "…'This meeting is full.'" "$(jq_ "$(body "$r")" "d['error']")" "This meeting is full."
same "…and no guest row was made for them" "$(PG "SELECT count(*) FROM connect.participants WHERE meeting_id='$M_ID' AND display_name='Sixth Guest'")" "0"
l=$(body "$(req GET "/api/connect/meetings/$M_ID/lobby" "$A")")
same "the host is told" "$(jq_ "$l" "d['capacity']['notice']")" "Someone couldn't join: your plan allows 5 people."
r=$(req POST "/api/connect/meetings/$M_ID/join" "$A" "{}")
same "the host is never refused from their own meeting" "$(jq_ "$(body "$r")" "d.get('status')")" "joined"
plan_to "$A_ID" "$BASIC"
r=$(curl -s -w '\n%{http_code}' -X POST "$API/api/connect/g/$M_CODE/join" -H 'Content-Type: application/json' -d '{"displayName":"Sixth On Basic"}')
same "calibration: on Basic (20) the same 6th guest gets in" "$(jq_ "$(body "$r")" "d.get('status')")" "joined"
plan_to "$A_ID" "$FREE"

r=$(req POST "/api/connect/meetings/$M_ID/recordings" "$A" "{}")
same "Free: recording refused (a direct API call, no button)" "$(status "$r")" "403"
same "…'Recording is part of Premium.'" "$(jq_ "$(body "$r")" "d['error']")" "Recording is part of Premium."
plan_to "$A_ID" "$PREMIUM"
r=$(req POST "/api/connect/meetings/$M_ID/recordings" "$A" "{}")
if [ "$(jq_ "$(body "$r")" "d.get('premium')")" = "True" ]; then fail "Premium still refused as not-Premium"; else pass "calibration: Premium is not refused for its plan ($(status "$r"): $(jq_ "$(body "$r")" "d.get('error','')" | head -c 60))"; fi
plan_to "$A_ID" "$FREE"

# The 60-minute end. Another Free meeting started 10 minutes ago is the control.
M2=$(jq_ "$(body "$(req POST /api/connect/meetings "$A" "{\"title\":\"Control $RUN\"}")")" "d['id']")
PG "UPDATE connect.meetings SET status='active', started_at=now()-interval '61 minutes' WHERE id='$M_ID'; UPDATE connect.meetings SET status='active', started_at=now()-interval '10 minutes' WHERE id='$M2'" >/dev/null
seen=""
for _ in $(seq 1 25); do grep -qF "Meeting $M_ID reached its host's 60-minute limit" "$LOG" && { seen=yes; break; }; sleep 2; done
[ -n "$seen" ] && pass "past 60 minutes: the server ends it (asks the media server)" || fail "no end attempted for $M_ID within 50s"
grep -qF "Meeting $M2 reached" "$LOG" && fail "the 10-minute meeting was ended too" || pass "calibration: a 10-minute meeting is left alone"
same "with no media server to agree, it is NOT marked ended (it would still be running)" "$(PG "SELECT status FROM connect.meetings WHERE id='$M_ID'")" "active"

# ---------------------------------------------------------------------------
step "4. AI — the person's own switch, the trial, minutes (D3, D6, §5)"
m=$(body "$(req GET /api/me/ai "$A")")
same "off to start with, no trial" "$(jq_ "$m" "(d['enabled'], d['trial'])")" "(False, None)"
r=$(req PUT /api/me/ai "$A" '{"on":true,"confirm":false}')
same "switching on without confirming: refused" "$(status "$r")" "400"
r=$(req PUT /api/me/ai "$A" '{"on":true,"confirm":true}')
same "confirmed: on, and the trial starts — 15 days" "$(jq_ "$(body "$r")" "(d['enabled'], d['trial']['daysLeft'])")" "(True, 15)"
HASH=$(PG "SELECT phone_hash FROM core.personal_accounts WHERE user_id='$A_ID'")
STARTED=$(PG "SELECT started_at FROM core.ai_trials WHERE phone_hash='$HASH'")
req PUT /api/me/ai "$A" '{"on":false,"confirm":false}' >/dev/null
req PUT /api/me/ai "$A" '{"on":true,"confirm":false}' >/dev/null
same "off and on again: the same trial, not a second" "$(PG "SELECT count(*)||' '||(started_at='$STARTED') FROM core.ai_trials WHERE phone_hash='$HASH' GROUP BY started_at")" "1 true"
same "AI minutes on, from the trial; recording still off" \
     "$(jq_ "$(body "$(req GET /api/me/plan "$A")")" "[(f['source'],f['included']) for f in d['features'] if f['code'] in ('connect.ai_minutes','connect.recording')]")" \
     "[('trial', True), ('not in plan', False)]"
r=$(req POST /api/mail/ai/rewrite "$A" '{"text":"hello there","style":"formal"}')
has "Mail AI is refused for a personal account" "$(jq_ "$(body "$r")" "d.get('error','')")" "isn't part of personal accounts"
r=$(req POST /api/mail/ai/rewrite "$B" '{"text":"hello there","style":"formal"}')
has "B, switch off: told to switch it on" "$(jq_ "$(body "$r")" "d.get('error','')")" "Switch AI on in your Account"
same "an organisation account has no personal switch (404)" "$(status "$(req GET /api/me/ai "$ORG")")" "404"

# Minutes: A (trial, switch on) and B (switch off) each host a meeting with a
# ready transcript; the notes worker (every minute) writes both.
mk_transcribed() { # host-token title -> meeting id
    local id; id=$(jq_ "$(body "$(req POST /api/connect/meetings "$1" "{\"title\":\"$2\"}")")" "d['id']")
    # 'failed', not 'ready': a ready recording must have a file
    # (recordings_ready_has_file). The notes worker reads the transcript either way.
    PGX "UPDATE connect.meetings SET status='ended', started_at=now()-interval '20 minutes', ended_at=now() WHERE id='$id';
        WITH r AS (INSERT INTO connect.recordings(meeting_id, egress_id, status) VALUES ('$id','EG_test_$RANDOM','failed') RETURNING id)
        INSERT INTO connect.transcripts(recording_id, meeting_id, status, segments)
        SELECT r.id, '$id', 'ready', '[{\"start\":0,\"end\":5,\"text\":\"We agreed the budget.\",\"speaker\":\"Host\"}]'::jsonb FROM r;
        UPDATE connect.participants SET first_joined_at=now()-interval '19 minutes' WHERE meeting_id='$id'" >/dev/null
    echo "$id"
}
HITS0=$(curl -s "$FAKE_AI/hits" | j "d if isinstance(d,int) else d.get('hits')")
MA=$(mk_transcribed "$A" "Trial minutes $RUN")
MB=$(mk_transcribed "$B" "No consent $RUN")
done_=""
for _ in $(seq 1 70); do
    n=$(PG "SELECT count(*) FROM connect.meeting_notes WHERE meeting_id IN ('$MA','$MB') AND status NOT IN ('queued')")
    [ "$n" = "2" ] && { done_=yes; break; }; sleep 3
done
[ -n "$done_" ] && pass "the notes worker wrote both meetings' notes" || fail "notes not written within 210s ($n of 2)"
same "A's minutes were written by AI, on A's behalf" \
     "$(PG "SELECT count(*) FROM core.ai_usage WHERE user_id='$A_ID' AND feature='connect.minutes' AND outcome='ok'")" "1"
same "B's were not: no AI use for B" "$(PG "SELECT count(*) FROM core.ai_usage WHERE user_id='$B_ID'")" "0"
HITS1=$(curl -s "$FAKE_AI/hits" | j "d if isinstance(d,int) else d.get('hits')")
same "the provider was asked exactly once" "$((HITS1 - HITS0))" "1"

# The trial ends: minutes stop.
PG "UPDATE core.ai_trials SET started_at=now()-interval '16 days', ends_at=now()-interval '1 day' WHERE phone_hash='$HASH'" >/dev/null
m=$(body "$(req GET /api/me/plan "$A")")
same "day 16: AI minutes off" "$(jq_ "$m" "[f['included'] for f in d['features'] if f['code']=='connect.ai_minutes'][0]")" "False"
MA2=$(mk_transcribed "$A" "After trial $RUN")
for _ in $(seq 1 70); do [ "$(PG "SELECT count(*) FROM connect.meeting_notes WHERE meeting_id='$MA2' AND status<>'queued'")" = "1" ] && break; sleep 3; done
same "after the trial, A's meeting gets notes without AI" "$(PG "SELECT count(*) FROM core.ai_usage WHERE user_id='$A_ID' AND feature='connect.minutes' AND outcome='ok'")" "1"
plan_to "$A_ID" "$PREMIUM"
same "Premium: AI minutes on again, from the plan" "$(jq_ "$(body "$(req GET /api/me/plan "$A")")" "[f['source'] for f in d['features'] if f['code']=='connect.ai_minutes'][0]")" "plan"
plan_to "$A_ID" "$FREE"

PG "DELETE FROM core.platform_settings WHERE key='personal.signup_open'" >/dev/null
rm -f ".tmp/up-$RUN.txt"
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
