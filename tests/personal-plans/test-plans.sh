#!/usr/bin/env bash
#
# TatvaOS — personal plans, part A (build plan personal-plans-build-plan.md
# §2, on PR 309's features model).
#
# Proves, against a LOCAL Development API and database:
#
#   1. the three personal plans exist with the §2.3 numbers, marked personal
#   2. a new /join account is on Personal Free with NO subscription row
#      (derived), and its answer is personal + ENFORCED
#   3. the operator moves them: a reason is required, an organisation plan is
#      refused, and the change is seen on the person's NEXT request with the
#      same token (no sign-out, §5) — up to Premium, down to Basic, back to
#      Free (which removes the live row)
#   4. the AI trial switches AI minutes on while it runs and off after, and
#      never switches recording on
#   5. ORGANISATIONS UNCHANGED: an organisation account's answer is warn-only
#      and is exactly PR 309's PlanEntitlements, feature by feature
#   6. a person's subscription never becomes the house's: the organisation
#      views of the house show no plan while someone in it is on Premium —
#      calibrated by pointing the same row at no person
#   7. guards: no personal plan for an organisation, no organisation plan on
#      the house, Personal Free cannot be deleted
#   8. the house never keeps everything, even after a migration re-run; an
#      operator's edit to a personal limit survives the re-run
#
# Needs: bash, curl, python; the API on $TATVAOS_API in Development with
# DevOperatorSignIn__Enabled=true and Personal__PhoneHashKey set; the database
# built from local/postgres/init (house on personal.local, the Techvein seed
# owner on +919999900001).    bash tests/personal-plans/test-plans.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5141}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
MIGRATION="local/postgres/init/20260926-z-personal-plans.sql"
TECHVEIN="11111111-1111-1111-1111-111111111111"
HOUSE="99999999-9999-9999-9999-999999999999"
FREE="b0000000-0000-0000-0000-000000000001"
BASIC="b0000000-0000-0000-0000-000000000002"
PREMIUM="b0000000-0000-0000-0000-000000000003"
STARTER="a0000000-0000-0000-0000-000000000001"
OWNER_PHONE="+919999900001"
RUN=$(date +%s)

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); RST=$(c $'\033[0m')
pass() { PASSED=$((PASSED+1)); printf '  %s✓%s %s\n' "$GREEN" "$RST" "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
step() { printf '\n%s>> %s%s\n' "$CYAN" "$1" "$RST"; }
# Empty operands are refused, not compared — empty = empty is a false green.
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got [$2], wanted [$3]"; fi
}
has() { if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 — '$3' not in [$(printf '%s' "$2" | head -c 200)]"; fi; }
PG() { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
j() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null | tr -d '\r'; }
jq_() { printf '%s' "$1" | j "$2"; }
req() { # method path token [body] -> "body\nstatus"
    local a=(-s -w '\n%{http_code}' -X "$1" "$API$2" -H 'Content-Type: application/json')
    [ -n "$3" ] && a+=(-H "Authorization: Bearer $3")
    [ -n "${4:-}" ] && a+=(-d "$4")
    curl "${a[@]}"
}
status() { printf '%s' "$1" | tail -n1; }
body()   { printf '%s' "$1" | sed '$d'; }
# One feature of a plan answer: "<included> <limit>" (limit None = no limit).
feat() { jq_ "$1" "[(f['included'], f['limit']) for f in d['features'] if f['code']=='$2'][0]" | tr -d "()," ; }

# ---------------------------------------------------------------------------
step "0. Stack, operator, a fresh personal account"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$h" = "200" ] && pass "API health 200" || { fail "API health $h"; exit 1; }
r=$(req POST /api/dev/operator-session "")
OP=$(jq_ "$(body "$r")" "d['accessToken']")
[ -n "$OP" ] && pass "operator session (development only)" || { fail "no operator session: $(body "$r" | head -c 200)"; exit 1; }

PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_open','true') ON CONFLICT (key) DO UPDATE SET value='true'" >/dev/null
PG "DELETE FROM core.personal_signup_attempts" >/dev/null
TOKEN=$(jq_ "$(body "$(req GET /api/join/status "")")" "d['formToken']")
sleep 5
NAME="plan.$RUN"; ADDR="$NAME@personal.local"; PW="a long enough passphrase"
PHONE="7$(printf '%09d' $((RUN % 1000000000)))"
r=$(req POST /api/join/start "" "{\"localPart\":\"$NAME\",\"displayName\":\"Plan Test\",\"phone\":\"$PHONE\",\"dateOfBirth\":\"1990-01-01\",\"declaredAdult\":true,\"website\":\"\",\"formToken\":\"$TOKEN\"}")
SID=$(jq_ "$(body "$r")" "d['signupId']"); CODE=$(jq_ "$(body "$r")" "d['devCode']")
req POST "/api/join/$SID/verify" "" "{\"code\":\"$CODE\"}" >/dev/null
r=$(req POST "/api/join/$SID/complete" "" "{\"password\":\"$PW\",\"acceptTerms\":true,\"acceptPrivacy\":true}")
same "personal account created" "$(status "$r")" "200"
r=$(req POST /api/auth/login "" "{\"email\":\"$ADDR\",\"password\":\"$PW\"}")
ME=$(jq_ "$(body "$r")" "d['accessToken']")
[ -n "$ME" ] && pass "signed in as the person" || { fail "sign-in: $(body "$r" | head -c 200)"; exit 1; }
UID_=$(PG "SELECT id FROM core.users WHERE email='$ADDR'")

# ---------------------------------------------------------------------------
step "1. The three personal plans (§2.3)"
plans=$(body "$(req GET /api/admin/plans "$OP")")
same "three plans marked personal" "$(jq_ "$plans" "sorted(p['name'] for p in d if p.get('audience')=='personal')")" \
     "['Personal Basic', 'Personal Free', 'Personal Premium']"
same "storage 1 / 5 / 10 GB" "$(jq_ "$plans" "[p['perUserQuotaBytes'] for p in sorted(d,key=lambda p:p['id']) if p.get('audience')=='personal']")" \
     "[1073741824, 5368709120, 10737418240]"
same "Free: 5 people, 60 min, 50 a day, 20 an hour, 15-day trial" \
     "$(jq_ "$plans" "[p['featureLimits'] for p in d if p['id']=='$FREE'][0]" | "$PY" -c "import sys,ast; l=ast.literal_eval(sys.stdin.read()); print(l['connect.max_participants'], l['connect.max_minutes'], l['mail.daily_recipients'], l['mail.hourly_recipients'], l['ai.trial_days'])")" \
     "5 60 50 20 15"
same "organisation plans unchanged in number (4) and audience" "$(jq_ "$plans" "len([p for p in d if p.get('audience')=='organisation'])")" "4"
# Mr. Singh on PR 313: three personal plans, editable; no new ones from the
# console. The SAME body is sent as an organisation plan first, so the
# refusal below cannot be some other validation failing.
PLAN_BODY="{\"name\":\"Probe $RUN\",\"storageModel\":\"pooled\",\"pooledStorageBytes\":1073741824,\"includedProducts\":[\"mail\"],\"aiCreditModel\":\"pooled\",\"audience\":\"%s\"}"
r=$(req POST /api/admin/plans "$OP" "$(printf "$PLAN_BODY" organisation)")
if [ "$(status "$r")" -lt 300 ]; then pass "calibration: the same body is accepted as an ORGANISATION plan ($(status "$r"))"
    PID_=$(jq_ "$(body "$r")" "d.get('id') or d.get('plan',{}).get('id') or ''"); [ -n "$PID_" ] && req DELETE "/api/admin/plans/$PID_" "$OP" >/dev/null
else fail "calibration: the probe body is not valid even as an organisation plan: $(status "$r") $(body "$r" | head -c 200)"; fi
r=$(req POST /api/admin/plans "$OP" "$(printf "$PLAN_BODY" personal)")
same "a NEW personal plan from the console: refused (400)" "$(status "$r")" "400"
has "…saying the personal plans are Free, Basic and Premium" "$(body "$r")" "Personal plans are Free, Basic and Premium"
same "…still three personal plans" "$(jq_ "$(body "$(req GET /api/admin/plans "$OP")")" "len([p for p in d if p.get('audience')=='personal'])")" "3"

# ---------------------------------------------------------------------------
step "2. A new account is on Free, derived, enforced"
same "no subscription row for the person" "$(PG "SELECT count(*) FROM core.subscriptions WHERE user_id='$UID_'")" "0"
mine=$(body "$(req GET /api/me/plan "$ME")")
same "plan: Personal Free" "$(jq_ "$mine" "d['planName']")" "Personal Free"
same "personal and ENFORCED" "$(jq_ "$mine" "(d['personal'], d['enforced'])")" "(True, True)"
same "storage 1 GB" "$(jq_ "$mine" "d['storageBytes']")" "1073741824"
same "meetings: 5 people"       "$(feat "$mine" connect.max_participants)" "True 5"
same "meetings: 60 minutes"     "$(feat "$mine" connect.max_minutes)" "True 60"
same "captions on"              "$(feat "$mine" connect.captions)" "True None"
same "recording off"            "$(feat "$mine" connect.recording)" "False None"
same "AI minutes off"           "$(feat "$mine" connect.ai_minutes)" "False None"
same "public links off (§2.3)"  "$(feat "$mine" space.public_links)" "False None"
same "no attendance record on Free" "$(feat "$mine" connect.attendance)" "False None"
op=$(body "$(req GET "/api/admin/personal-accounts/$UID_/plan" "$OP")")
same "the operator sees the same answer" "$(jq_ "$op" "(d['planName'], len(d['features']))")" "$(jq_ "$mine" "(d['planName'], len(d['features']))")"

# ---------------------------------------------------------------------------
step "3. The operator moves them (§2.2, §5)"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$OP" "{\"planId\":\"$PREMIUM\"}")
same "no reason: refused" "$(status "$r")" "400"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$OP" "{\"planId\":\"$STARTER\",\"reason\":\"test\"}")
same "an organisation plan: refused" "$(status "$r")" "400"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "" "{\"planId\":\"$PREMIUM\",\"reason\":\"test\"}")
same "no operator: 401" "$(status "$r")" "401"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$ME" "{\"planId\":\"$PREMIUM\",\"reason\":\"me\"}")
same "the person cannot move themselves: 403" "$(status "$r")" "403"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$OP" "{\"planId\":\"$PREMIUM\",\"reason\":\"test run $RUN\"}")
same "to Premium: 200" "$(status "$r")" "200"
mine=$(body "$(req GET /api/me/plan "$ME")")
same "seen on the next request, same token" "$(jq_ "$mine" "d['planName']")" "Personal Premium"
same "Premium: 50 people"       "$(feat "$mine" connect.max_participants)" "True 50"
same "Premium: no time limit"   "$(feat "$mine" connect.max_minutes)" "True None"
same "Premium: recording on"    "$(feat "$mine" connect.recording)" "True None"
same "Premium: AI minutes on"   "$(feat "$mine" connect.ai_minutes)" "True None"
same "Premium: 10 GB"           "$(jq_ "$mine" "d['storageBytes']")" "10737418240"
same "one live row, naming the person" "$(PG "SELECT count(*)||' '||max(plan_id::text) FROM core.subscriptions WHERE user_id='$UID_' AND status<>'cancelled'")" "1 $PREMIUM"
same "audited with the reason" "$(PG "SELECT count(*) FROM core.audit_logs WHERE action LIKE '%personal.plan_changed' AND target_id='$UID_' AND after_state::text LIKE '%test run $RUN%'")" "1"

# -- 6 runs here, while someone in the house is on Premium --------------------
step "6. A person's subscription is never the house's"
org=$(body "$(req GET "/api/admin/organisations/$HOUSE" "$OP")")
same "the house's organisation view shows no plan" "$(jq_ "$org" "d.get('planId') or d.get('plan') or 'none'")" "none"
ent=$(body "$(req GET "/api/admin/organisations/$HOUSE/plan" "$OP")")
same "309's entitlements for the house: no plan" "$(jq_ "$ent" "d['entitlements'].get('planName') or 'none'")" "none"
# Calibration: the same row with no person IS the house's subscription —
# which is exactly what every organisation reader would have seen without
# the user_id filter.
PG "UPDATE core.subscriptions SET user_id=NULL WHERE user_id='$UID_' AND status='active'" >/dev/null
ent=$(body "$(req GET "/api/admin/organisations/$HOUSE/plan" "$OP")")
same "calibration: unowned, the row becomes the house's plan" "$(jq_ "$ent" "d['entitlements'].get('planName') or 'none'")" "Personal Premium"
PG "UPDATE core.subscriptions SET user_id='$UID_' WHERE tenant_id='$HOUSE' AND user_id IS NULL AND status='active' AND plan_id='$PREMIUM'" >/dev/null
same "restored to the person" "$(PG "SELECT count(*) FROM core.subscriptions WHERE user_id='$UID_' AND status='active'")" "1"

step "3b. Down again"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$OP" "{\"planId\":\"$BASIC\",\"reason\":\"downgrade test\"}")
same "to Basic: 200" "$(status "$r")" "200"
mine=$(body "$(req GET /api/me/plan "$ME")")
same "Basic now" "$(jq_ "$mine" "d['planName']")" "Personal Basic"
same "Basic: recording off again" "$(feat "$mine" connect.recording)" "False None"
same "Basic: public links on"     "$(feat "$mine" space.public_links)" "True None"
same "still one live row; the old one cancelled" \
     "$(PG "SELECT sum((status<>'cancelled')::int)||' '||sum((status='cancelled')::int) FROM core.subscriptions WHERE user_id='$UID_'")" "1 1"
r=$(req PUT "/api/admin/personal-accounts/$UID_/plan" "$OP" "{\"planId\":\"$FREE\",\"reason\":\"back to free\"}")
same "back to Free: no live row at all" "$(PG "SELECT count(*) FROM core.subscriptions WHERE user_id='$UID_' AND status<>'cancelled'")" "0"
same "and the answer is Free" "$(jq_ "$(body "$(req GET /api/me/plan "$ME")")" "d['planName']")" "Personal Free"

# ---------------------------------------------------------------------------
step "4. The AI trial (D6) — part D starts it; here it is only read"
HASH=$(PG "SELECT phone_hash FROM core.personal_accounts WHERE user_id='$UID_'")
PG "INSERT INTO core.ai_trials(phone_hash,user_id,started_at,ends_at) VALUES ('$HASH','$UID_',now(),now()+interval '15 days')" >/dev/null
mine=$(body "$(req GET /api/me/plan "$ME")")
same "trial running: AI minutes on, from the trial" "$(jq_ "$mine" "[f['source'] for f in d['features'] if f['code']=='connect.ai_minutes'][0]")" "trial"
same "15 days left" "$(jq_ "$mine" "d['aiTrial']['daysLeft']")" "15"
same "the trial never switches recording on" "$(feat "$mine" connect.recording)" "False None"
PG "UPDATE core.ai_trials SET started_at=now()-interval '16 days', ends_at=now()-interval '1 day' WHERE phone_hash='$HASH'" >/dev/null
mine=$(body "$(req GET /api/me/plan "$ME")")
same "day 16: AI minutes off" "$(feat "$mine" connect.ai_minutes)" "False None"
same "trial shown as used" "$(jq_ "$mine" "d['aiTrial']['active']")" "False"

# ---------------------------------------------------------------------------
step "5. Organisations unchanged: warn-only, exactly PlanEntitlements"
# A database built from nothing has a seed owner with no phone and the role
# 'owner' (tests/oidc does the same): give them both, local seed row only.
PG "UPDATE core.users SET phone='$OWNER_PHONE', role='org_owner' WHERE id='d1111111-1111-1111-1111-111111111111' AND (phone IS NULL OR phone='$OWNER_PHONE')" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
code=$(jq_ "$(body "$(req POST /api/auth/otp/request "" "{\"phone\":\"$OWNER_PHONE\"}")")" "d.get('devCode') or ''")
ORG=$(jq_ "$(body "$(req POST /api/auth/otp/verify "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")")" "d.get('accessToken') or ''")
[ -n "$ORG" ] && pass "signed in as the Techvein owner" || fail "no org sign-in (devCode empty?)"
mine=$(body "$(req GET /api/me/plan "$ORG")")
same "organisation: not personal, NOT enforced" "$(jq_ "$mine" "(d['personal'], d['enforced'])")" "(False, False)"
ent=$(body "$(req GET "/api/admin/organisations/$TECHVEIN/plan" "$OP")")
same "same plan as 309 reports" "$(jq_ "$mine" "d['planName']")" "$(jq_ "$ent" "d['entitlements']['planName']")"
same "every feature identical to 309's answer" \
     "$(jq_ "$mine" "sorted((f['code'],f['included'],f['limit']) for f in d['features'])")" \
     "$(jq_ "$ent" "sorted((f['code'],f['included'],f['limit']) for f in d['entitlements']['features'])")"

# ---------------------------------------------------------------------------
step "7. Guards"
r=$(req PUT "/api/admin/organisations/$TECHVEIN/plan" "$OP" "{\"planId\":\"$FREE\"}")
same "a personal plan on an organisation: 400" "$(status "$r")" "400"
r=$(req PUT "/api/admin/organisations/$HOUSE/plan" "$OP" "{\"planId\":\"$STARTER\"}")
same "an organisation plan on the house: 400" "$(status "$r")" "400"
r=$(req DELETE "/api/admin/plans/$FREE" "$OP")
same "Personal Free cannot be deleted" "$(status "$r")" "400"
same "and it is still there" "$(PG "SELECT count(*) FROM core.plans WHERE id='$FREE'")" "1"

# ---------------------------------------------------------------------------
step "8. Re-running the migration"
PG "UPDATE core.tenants SET keeps_everything=true WHERE id='$HOUSE'" >/dev/null
PG "UPDATE core.plan_feature_limits SET limit_value=6 WHERE plan_id='$FREE' AND feature_code='connect.max_participants'" >/dev/null
out=$(wsl -e bash -c "cd /mnt/c/Users/amitd/Downloads/tatvaos-one/tatvaos-personal && PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -v ON_ERROR_STOP=1 -q -f $MIGRATION" 2>&1; echo "exit=$?")
printf '%s' "$out" | grep -qF -- "exit=0" && pass "re-runs cleanly" || fail "re-run: $out"
same "the house does not keep everything" "$(PG "SELECT keeps_everything FROM core.tenants WHERE id='$HOUSE'")" "f"
same "the operator's 6 survives the re-run" "$(PG "SELECT limit_value FROM core.plan_feature_limits WHERE plan_id='$FREE' AND feature_code='connect.max_participants'")" "6"
same "and is the answer at once" "$(feat "$(body "$(req GET /api/me/plan "$ME")")" connect.max_participants)" "True 6"
PG "UPDATE core.plan_feature_limits SET limit_value=5 WHERE plan_id='$FREE' AND feature_code='connect.max_participants'" >/dev/null

PG "DELETE FROM core.platform_settings WHERE key='personal.signup_open'" >/dev/null
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
