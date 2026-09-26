#!/usr/bin/env bash
#
# TatvaOS — strangers must not see each other (build plan
# personal-plans-build-plan.md §6, part C).
#
# Two personal accounts, A and B, in the personal house. B has things: a
# contact, a calendar event, a folder, two meetings (one closed to outsiders,
# one open with a waiting room). A tries every surface — directory, search,
# suggestions, free/busy, photos, the Organisation folder, organisation-wide
# sharing, contact groups, organisation calendars, delegation, B's meetings by
# id and by code, their roster and chat — and must NEVER find B.
#
# CALIBRATED RED, as the plan requires. The same probes run a second time
# with the house switched back to an ordinary organisation (kind =
# 'organisation'): every probe must then SEE B (or be allowed). A probe that
# stays green both ways is not looking at the surface it names, and fails.
#
# Also: the database backstop (a raw INSERT of each organisation-wide row as
# the app role is refused in the house and accepted in Techvein), the house
# can never have organisation AI on, and an organisation account is unchanged
# (the Techvein owner still gets the directory).
#
# Needs: the Development API on $TATVAOS_API with DevOperatorSignIn,
# Personal__PhoneHashKey and LiveKit__ApiKey/ApiSecret set (any values — join
# only needs to be able to MINT); the database from local/postgres/init.
#   bash tests/personal-isolation/test-isolation.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PY="${TATVAOS_PYTHON:-python}"
API="${TATVAOS_API:-http://localhost:5297}"
PSQL="${TATVAOS_PSQL:-wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -d tatvaos_personal -Atc}"
APPSQL="${TATVAOS_APP_PSQL:-wsl -e env PGPASSWORD=dev_app_pw psql -h localhost -U tatvaos_app -d tatvaos_personal -Atc}"
HOUSE="99999999-9999-9999-9999-999999999999"
TECHVEIN="11111111-1111-1111-1111-111111111111"
OWNER_PHONE="+919999900001"
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
PG()  { $PSQL "$1" 2>/dev/null | tr -d '\r'; }
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
contains() { printf '%s' "$1" | grep -qF -- "$2"; }

# ---------------------------------------------------------------------------
step "0. Two strangers in the house"
h=$(curl -s -o /dev/null -w '%{http_code}' "$API/health")
[ "$h" = "200" ] && pass "API health 200" || { fail "API health $h"; exit 1; }
PG "UPDATE core.tenants SET kind='personal_house' WHERE id='$HOUSE'" >/dev/null
PG "INSERT INTO core.platform_settings(key,value) VALUES ('personal.signup_open','true') ON CONFLICT (key) DO UPDATE SET value='true'" >/dev/null
PG "DELETE FROM core.personal_signup_attempts" >/dev/null

join_one() { # localpart displayname phone -> access token
    local tok sid code r
    tok=$(jq_ "$(body "$(req GET /api/join/status "")")" "d['formToken']")
    sleep 5
    r=$(req POST /api/join/start "" "{\"localPart\":\"$1\",\"displayName\":\"$2\",\"phone\":\"$3\",\"dateOfBirth\":\"1990-01-01\",\"declaredAdult\":true,\"website\":\"\",\"formToken\":\"$tok\"}")
    sid=$(jq_ "$(body "$r")" "d['signupId']"); code=$(jq_ "$(body "$r")" "d['devCode']")
    req POST "/api/join/$sid/verify" "" "{\"code\":\"$code\"}" >/dev/null
    req POST "/api/join/$sid/complete" "" "{\"password\":\"a long enough passphrase\",\"acceptTerms\":true,\"acceptPrivacy\":true}" >/dev/null
    jq_ "$(body "$(req POST /api/auth/login "" "{\"email\":\"$1@personal.local\",\"password\":\"a long enough passphrase\"}")")" "d['accessToken']"
}
A_ADDR="anu.$RUN@personal.local"; B_ADDR="bhaskar.$RUN@personal.local"
B_NAME="Bhaskar Zyxw$RUN"
A=$(join_one "anu.$RUN" "Anu Test" "7$(printf '%09d' $((RUN % 1000000000)))")
B=$(join_one "bhaskar.$RUN" "$B_NAME" "6$(printf '%09d' $(((RUN + 17) % 1000000000)))")
[ -n "$A" ] && [ -n "$B" ] && pass "A and B signed in" || { fail "could not make the two accounts"; exit 1; }
A_ID=$(PG "SELECT id FROM core.users WHERE email='$A_ADDR'")
B_ID=$(PG "SELECT id FROM core.users WHERE email='$B_ADDR'")
A_MBOX=$(PG "SELECT id FROM mail.mailboxes WHERE address='$A_ADDR'")

# B's things
req POST /api/family/contacts "$B" "{\"displayName\":\"Secret Supplier $RUN\",\"email\":\"supplier.$RUN@example.test\"}" >/dev/null
B_FOLDER=$(jq_ "$(body "$(req POST /api/space/folders "$B" "{\"name\":\"B private $RUN\",\"scope\":\"personal\"}")")" "d['id']")
M_CLOSED=$(body "$(req POST /api/connect/meetings "$B" "{\"title\":\"B closed $RUN\",\"allowGuests\":false}")")
M_OPEN=$(body "$(req POST /api/connect/meetings "$B" "{\"title\":\"B open $RUN\",\"allowGuests\":true,\"waitingRoom\":\"guests\"}")")
MC_ID=$(jq_ "$M_CLOSED" "d['id']"); MC_CODE=$(jq_ "$M_CLOSED" "d['code']")
MO_ID=$(jq_ "$M_OPEN" "d['id']"); MO_CODE=$(jq_ "$M_OPEN" "d['code']")
[ -n "$MC_ID" ] && [ -n "$MO_ID" ] && [ -n "$B_FOLDER" ] && pass "B has a folder and two meetings" || fail "B's setup: closed=[$MC_ID] open=[$MO_ID] folder=[$B_FOLDER]"

# ---------------------------------------------------------------------------
# The probes. Each prints "LEAK" when A can see or reach B, "SAFE" when not.
# Run once with the house as a house (all must be SAFE) and once with it as an
# ordinary organisation (all must be LEAK) — the calibration.
# A probe against a dead API reads as SAFE (nothing came back) or LEAK (not
# 403) by accident. Found on the first run: the API died mid-suite and the
# results were noise. So every probe is followed by a health check, and a
# dead API stops the run instead of scoring it.
alive() {
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = "200" ] && return 0
    fail "the API stopped answering during '$1' — results after this are meaningless"
    printf '
%s passed, %s failed
' "$PASSED" "$FAILED"; exit 1
}
probe() { # name -> LEAK|SAFE
    local r s b
    case "$1" in
    mail-directory)      r=$(req GET "/api/mail/directory?q=bhaskar.$RUN" "$A"); contains "$(body "$r")" "$B_ADDR" && echo LEAK || echo SAFE ;;
    space-directory)     r=$(req GET "/api/space/directory?q=Bhaskar" "$A"); contains "$(body "$r")" "$B_ID" && echo LEAK || echo SAFE ;;
    contact-suggest)     r=$(req GET "/api/family/contacts/autocomplete?q=bhaskar" "$A"); contains "$(body "$r")" "$B_ADDR" && echo LEAK || echo SAFE ;;
    freebusy)            r=$(req GET "/api/calendar/freebusy?userIds=$B_ID&from=2026-12-01T00:00:00Z&to=2026-12-08T00:00:00Z" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    photo-lookup)        r=$(req POST /api/org/users/photos "$A" "{\"emails\":[\"$B_ADDR\"]}"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    photo-of-b)          r=$(req GET "/api/org/users/$B_ID/avatar" "$A"); [ "$(status "$r")" != "403" ] && echo LEAK || echo SAFE ;;
    # As an ADMIN: a plain personal account is refused by the OrgAdmin policy
    # anyway, which would prove nothing about the house rule. This asks what
    # happens if a house account ever carried an admin role (a mistake, an
    # operator slip): the guard's /api/org/ prefix must still refuse it.
    people-admin)        PG "UPDATE core.users SET role='org_admin' WHERE id='$A_ID'" >/dev/null
                         s=$(jq_ "$(body "$(req POST /api/auth/login "" "{\"email\":\"$A_ADDR\",\"password\":\"a long enough passphrase\"}")")" "d['accessToken']")
                         PG "UPDATE core.users SET role='employee' WHERE id='$A_ID'" >/dev/null
                         r=$(req GET /api/org/users "$s"); contains "$(body "$r")" "$B_ADDR" && echo LEAK || echo SAFE ;;
    groups)              r=$(req POST /api/family/groups "$A" "{\"name\":\"g$RUN$RANDOM\"}"); s=$(status "$r"); [ "$s" = "200" ] || [ "$s" = "201" ] && echo LEAK || echo SAFE ;;
    org-contact)         r=$(req POST /api/family/contacts "$A" "{\"displayName\":\"Org $RUN $RANDOM\",\"ownershipType\":\"organisational\"}"); s=$(status "$r"); [ "$s" = "200" ] || [ "$s" = "201" ] && echo LEAK || echo SAFE ;;
    org-calendar)        r=$(req POST /api/calendar/calendars "$A" "{\"name\":\"Org $RUN $RANDOM\",\"kind\":\"organisation\"}"); s=$(status "$r"); [ "$s" = "200" ] || [ "$s" = "201" ] && echo LEAK || echo SAFE ;;
    attendee-name)       r=$(req POST /api/calendar/events "$A" "{\"title\":\"t$RANDOM\",\"startsAt\":\"2026-12-01T10:00:00Z\",\"endsAt\":\"2026-12-01T11:00:00Z\",\"isAllDay\":false,\"attendees\":[{\"email\":\"$B_ADDR\",\"optional\":false}]}")
                         [ -n "$(PG "SELECT 1 FROM calendar.event_attendees WHERE email='$B_ADDR' AND (display_name='$B_NAME' OR user_id IS NOT NULL) LIMIT 1")" ] && echo LEAK || echo SAFE ;;
    org-folder)          r=$(req GET "/api/space/list?scope=organisational" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    org-share)           r=$(req PUT "/api/space/folders/$A_FOLDER/shares" "$A" "{\"orgWide\":true,\"permission\":\"view\"}"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    delegation)          r=$(req POST "/api/mail/mailboxes/$A_MBOX/permissions" "$A" "{\"userId\":\"$B_ID\",\"permission\":\"read\"}"); s=$(status "$r"); [ "$s" = "200" ] || [ "$s" = "201" ] || [ "$s" = "204" ] && echo LEAK || echo SAFE ;;
    meeting-by-id)       r=$(req GET "/api/connect/meetings/$MC_ID" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    closed-by-code)      r=$(req GET "/api/connect/meetings/by-code/$MC_CODE" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    closed-join)         r=$(req POST "/api/connect/meetings/$MC_ID/join" "$A" "{}"); contains "$(body "$r")" '"joined"' && echo LEAK || echo SAFE ;;
    roster)              r=$(req GET "/api/connect/meetings/$MO_ID/participants" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    open-code-host-id)   r=$(req GET "/api/connect/meetings/by-code/$MO_CODE" "$A"); contains "$(body "$r")" "$B_ID" && echo LEAK || echo SAFE ;;
    open-join-straight)  r=$(req POST "/api/connect/meetings/$MO_ID/join" "$A" "{}"); contains "$(body "$r")" '"joined"' && echo LEAK || echo SAFE ;;
    chat-while-waiting)  req POST "/api/connect/meetings/$MO_ID/join" "$A" "{}" >/dev/null
                         r=$(req GET "/api/connect/meetings/$MO_ID/chat" "$A"); [ "$(status "$r")" = "200" ] && echo LEAK || echo SAFE ;;
    *) echo "UNKNOWN" ;;
    esac
}
PROBES="mail-directory space-directory contact-suggest freebusy photo-lookup photo-of-b people-admin groups org-contact org-calendar attendee-name org-folder org-share delegation meeting-by-id closed-by-code closed-join roster open-code-host-id open-join-straight chat-while-waiting"

# Reset what a probe run leaves behind, so the second run starts equal.
reset_probe_state() {
    PG "DELETE FROM connect.participants WHERE user_id='$A_ID'; DELETE FROM connect.lobby_requests WHERE user_id='$A_ID';
        DELETE FROM calendar.event_attendees WHERE email='$B_ADDR';
        DELETE FROM mail.mailbox_permissions WHERE mailbox_id='$A_MBOX';
        DELETE FROM space.shares WHERE folder_id='$A_FOLDER';
        DELETE FROM family.contact_groups WHERE tenant_id='$HOUSE';
        DELETE FROM family.contacts WHERE tenant_id='$HOUSE' AND ownership_type='organisational';
        DELETE FROM calendar.calendars WHERE tenant_id='$HOUSE' AND kind<>'personal'" >/dev/null
}

A_FOLDER=$(jq_ "$(body "$(req POST /api/space/folders "$A" "{\"name\":\"A own $RUN\",\"scope\":\"personal\"}")")" "d['id']")
[ -n "$A_FOLDER" ] && pass "A has a folder of their own" || fail "A's folder"

# ---------------------------------------------------------------------------
step "1. As a personal house: A never finds B"
reset_probe_state
declare -A HOUSE_RESULT
for p in $PROBES; do
    v=$(probe "$p"); HOUSE_RESULT[$p]=$v; alive "$p"
    [ "$v" = "SAFE" ] && pass "$p" || fail "$p — A reached B ($v)"
done

# ---------------------------------------------------------------------------
step "2. Calibration: the same house as an ordinary organisation — every probe must now LEAK"
reset_probe_state
# The constraint forbids org AI only for the house; the triggers look at kind.
PG "UPDATE core.tenants SET kind='organisation' WHERE id='$HOUSE'" >/dev/null
sleep 62   # PersonalHouse caches the house id for one minute
for p in $PROBES; do
    v=$(probe "$p"); alive "$p"
    if [ "$v" = "LEAK" ]; then pass "$p goes red without the house rule"
    else fail "$p stays SAFE without the house rule — the probe is not looking at the surface"; fi
done
reset_probe_state
PG "UPDATE core.tenants SET kind='personal_house' WHERE id='$HOUSE'" >/dev/null
sleep 62
same "and back: the house is a house again" "$(probe mail-directory)" "SAFE"

# ---------------------------------------------------------------------------
step "3. What A may still do"
r=$(req GET "/api/org/users/$A_ID/avatar" "$A")
[ "$(status "$r")" != "403" ] && pass "A's own photo is not refused ($(status "$r"))" || fail "own photo refused"
r=$(req PUT "/api/space/folders/$A_FOLDER/shares" "$A" "{\"email\":\"$B_ADDR\",\"permission\":\"view\"}")
same "A shares a folder with B by ADDRESS" "$(status "$r")" "200"
same "B sees it in Shared with me" "$(jq_ "$(body "$(req GET /api/space/shared "$B")")" "any(x.get('id')=='$A_FOLDER' for x in (d if isinstance(d,list) else d.get('items',d.get('folders',[]))))")" "True"
r=$(req PUT "/api/space/folders/$A_FOLDER/shares" "$A" "{\"email\":\"nobody.$RUN@personal.local\",\"permission\":\"view\"}")
same "an unknown address: 404" "$(status "$r")" "404"
r=$(req GET "/api/connect/meetings/by-code/$MO_CODE" "$A")
same "B's OPEN meeting: A may look it up by code (as a guest could)" "$(status "$r")" "200"
same "…without learning who made it" "$(jq_ "$(body "$r")" "d.get('createdByUserId') is None")" "True"
req POST "/api/connect/meetings/$MO_ID/join" "$A" "{}" >/dev/null
r=$(req POST "/api/connect/meetings/$MO_ID/join" "$A" "{}")
same "A joining B's open meeting waits in the waiting room" "$(jq_ "$(body "$r")" "d.get('status')")" "waiting"
LOBBY=$(jq_ "$(body "$(req GET "/api/connect/meetings/$MO_ID/lobby" "$B")")" "d['waiting'][0]['requestId']")
r=$(req POST "/api/connect/meetings/$MO_ID/lobby/$LOBBY/admit" "$B")
[ "$(status "$r")" -lt 300 ] && pass "B admits A" || fail "admit: $(status "$r")"
same "admitted, A can now read the meeting's chat" "$(status "$(req GET "/api/connect/meetings/$MO_ID/chat" "$A")")" "200"
mine=$(body "$(req GET "/api/family/contacts/autocomplete?q=secret" "$B")")
contains "$mine" "supplier.$RUN@example.test" && pass "B's own contacts still suggest to B" || fail "B's own suggestion missing: $mine"

# ---------------------------------------------------------------------------
step "4. The database backstop (raw SQL as the app role)"
backstop() { # label sql-for-tenant(%T) -> refused in house, accepted in Techvein
    local house tech
    house=$($APPSQL "SET app.tenant_id='$HOUSE'; ${2//%T/$HOUSE}" 2>&1 | tr -d '\r')
    tech=$($APPSQL "BEGIN; SET LOCAL app.tenant_id='$TECHVEIN'; ${2//%T/$TECHVEIN}; ROLLBACK;" 2>&1 | tr -d '\r')
    if printf '%s' "$house" | grep -qF "not available in the personal house" && ! printf '%s' "$tech" | grep -qi "error"; then
        pass "$1: refused in the house, allowed in an organisation"
    else fail "$1 — house: $(printf '%s' "$house" | head -c 160) | techvein: $(printf '%s' "$tech" | head -c 160)"; fi
}
backstop "organisation folder" "INSERT INTO space.folders(tenant_id, name, ownership_type) VALUES ('%T','x$RUN','organisational')"
backstop "contact group"       "INSERT INTO family.contact_groups(tenant_id, name) VALUES ('%T','g$RUN')"
backstop "organisation calendar" "INSERT INTO calendar.calendars(tenant_id, name, kind) VALUES ('%T','c$RUN','organisation')"
r=$($PSQL "UPDATE core.tenants SET allow_ai=true WHERE id='$HOUSE'" 2>&1 | tr -d '\r')
printf '%s' "$r" | grep -qF "tenants_house_no_org_ai" && pass "the house can never have organisation AI switched on" || fail "allow_ai on the house: $r"

# ---------------------------------------------------------------------------
step "5. An organisation is unchanged"
PG "UPDATE core.users SET phone='$OWNER_PHONE', role='org_owner' WHERE id='d1111111-1111-1111-1111-111111111111' AND (phone IS NULL OR phone='$OWNER_PHONE')" >/dev/null
PG "UPDATE core.users SET login_otp_sent_at=NULL WHERE phone='$OWNER_PHONE'" >/dev/null
code=$(jq_ "$(body "$(req POST /api/auth/otp/request "" "{\"phone\":\"$OWNER_PHONE\"}")")" "d.get('devCode') or ''")
ORG=$(jq_ "$(body "$(req POST /api/auth/otp/verify "" "{\"phone\":\"$OWNER_PHONE\",\"code\":\"$code\"}")")" "d.get('accessToken') or ''")
[ -n "$ORG" ] && pass "signed in as the Techvein owner" || fail "no org sign-in"
same "the directory still answers for an organisation" "$(status "$(req GET "/api/mail/directory?q=a" "$ORG")")" "200"
same "and the Organisation folder" "$(status "$(req GET "/api/space/list?scope=organisational" "$ORG")")" "200"

reset_probe_state
PG "DELETE FROM core.platform_settings WHERE key='personal.signup_open'" >/dev/null
printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = "0" ]
