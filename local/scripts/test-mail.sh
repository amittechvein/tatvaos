#!/usr/bin/env bash
#
# TatvaOS Mail - local stack smoke test
#
# Proves the whole inbound loop end to end:
#   swaks -> Postfix :2525 -> Postgres lookup -> LMTP -> Dovecot -> maildir
#
# and that the things which SHOULD fail actually do.
#
#   ./scripts/test-mail.sh

set -uo pipefail

SMTP_HOST=${SMTP_HOST:-localhost}
SMTP_PORT=${SMTP_PORT:-2525}
IMAP_PORT=${IMAP_PORT:-1143}
PASS=${MAIL_PASS:-devpass123}

PASSED=0; FAILED=0

c()    { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); YEL=$(c $'\033[33m')
CYAN=$(c $'\033[36m');  GRAY=$(c $'\033[90m'); RST=$(c $'\033[0m')

hdr()  { printf '\n%s== %s%s\n' "$CYAN" "$1" "$RST"; }
pass() { printf '  %s[PASS]%s %s\n' "$GREEN" "$RST" "$1"; PASSED=$((PASSED+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$1"; FAILED=$((FAILED+1)); }
info() { printf '  %s%s%s\n' "$GRAY" "$1" "$RST"; }

need() { command -v "$1" >/dev/null 2>&1 || { printf '%sMissing %s. Install it: sudo apt install -y %s%s\n' "$RED" "$1" "$2" "$RST"; exit 1; }; }
need swaks swaks
need docker docker
need curl curl

# ---------------------------------------------------------------------------
hdr "Containers"
for svc in tv-postgres tv-postfix tv-dovecot tv-mailpit tv-opendkim; do
    if docker ps --format '{{.Names}}' | grep -qx "$svc"; then
        pass "$svc running"
    else
        fail "$svc NOT running  (docker compose up -d)"
    fi
done
[ "$FAILED" -gt 0 ] && { printf '\n%sStack is not up. Start it first.%s\n\n' "$RED" "$RST"; exit 1; }

# ---------------------------------------------------------------------------
hdr "Database lookups (as the mail-edge role)"

q() { docker exec tv-postgres psql -U tatvaos_mailedge -d tatvaos_mail -tAc "$1" 2>/dev/null; }

[ "$(q "SELECT count(*) FROM core.domains WHERE is_active")" -ge 2 ] \
    && pass "domains visible to mail edge" || fail "domain lookup failed"

[ "$(q "SELECT count(*) FROM mail.mailboxes WHERE is_active")" -ge 4 ] \
    && pass "mailboxes visible to mail edge" || fail "mailbox lookup failed"

# The mail edge must NOT be able to read message content.
if docker exec tv-postgres psql -U tatvaos_mailedge -d tatvaos_mail \
        -tAc "SELECT count(*) FROM mail.messages" >/dev/null 2>&1; then
    fail "mail edge CAN read messages - grants are wrong, fix before going further"
else
    pass "mail edge cannot read messages (permission denied, as designed)"
fi

# ---------------------------------------------------------------------------
hdr "Inbound delivery"

send() {
    swaks --server "$SMTP_HOST:$SMTP_PORT" \
          --from "$1" --to "$2" \
          --header "Subject: $3" --body "$4" \
          --hide-all --silent 3 >/dev/null 2>&1
}

if send "outside@example.com" "amit@techvein.local" "smoke test $(date +%s)" "hello from swaks"; then
    pass "accepted for amit@techvein.local"
else
    fail "delivery to amit@techvein.local rejected"
fi

if send "outside@example.com" "principal@abcschool.local" "cross tenant $(date +%s)" "second tenant"; then
    pass "accepted for principal@abcschool.local (second tenant)"
else
    fail "delivery to second tenant rejected"
fi

hdr "Alias resolution"
if send "outside@example.com" "ceo@techvein.local" "alias test $(date +%s)" "via alias"; then
    pass "ceo@ alias accepted (resolves to amit@)"
else
    fail "alias lookup failed"
fi

hdr "Rejections that SHOULD happen"
if send "outside@example.com" "nosuchuser@techvein.local" "should bounce" "x"; then
    fail "unknown recipient was ACCEPTED - reject_unlisted_recipient is not working"
else
    pass "unknown recipient rejected at SMTP time (550, no backscatter)"
fi

if send "outside@example.com" "someone@notourdomain.com" "should bounce" "x"; then
    fail "relay to a foreign domain ACCEPTED - you have an open relay"
else
    pass "foreign domain rejected (not an open relay)"
fi

# ---------------------------------------------------------------------------
hdr "Maildir"
sleep 2
for box in "techvein.local/amit" "abcschool.local/principal"; do
    n=$(docker exec tv-dovecot sh -c "ls -1 /var/mail/vhosts/$box/new 2>/dev/null | wc -l" 2>/dev/null || echo 0)
    if [ "${n:-0}" -gt 0 ]; then
        pass "$box has $n message(s) on disk"
    else
        fail "$box maildir empty - check: docker compose logs dovecot"
    fi
done

# ---------------------------------------------------------------------------
hdr "IMAP"
imap_login() {
    docker exec tv-dovecot doveadm auth test "$1" "$PASS" 2>&1 | grep -qi 'auth succeeded'
}

# If auth is broken, the cause is nearly always the Postgres connection rather
# than the password. Surface Dovecot's own words instead of a bare FAIL.
auth_hint() {
    local out
    out=$(docker exec tv-dovecot doveadm auth test "amit@techvein.local" "$PASS" 2>&1 | head -3)
    [ -n "$out" ] && printf '         %s\n' "$out"
}
if imap_login "amit@techvein.local"; then
    pass "amit@techvein.local authenticates"
else
    fail "IMAP auth failed for amit@"
    auth_hint
fi
imap_login "principal@abcschool.local" && pass "principal@abcschool.local authenticates" || fail "IMAP auth failed for principal@"

wrong_out=$(docker exec tv-dovecot doveadm auth test "amit@techvein.local" "wrongpassword" 2>&1)
if printf '%s' "$wrong_out" | grep -qi 'auth succeeded'; then
    fail "wrong password ACCEPTED - check password_query"
elif printf '%s' "$wrong_out" | grep -qi 'auth failed'; then
    pass "wrong password rejected"
else
    # Neither string - Dovecot could not complete the lookup at all
    fail "auth lookup did not run. Dovecot cannot reach Postgres:"
    printf '         %s\n' "$(printf '%s' "$wrong_out" | head -3)"
fi

# ===========================================================================
#  THE OUTBOUND GATE
# ===========================================================================
#
#  This is the abuse control the Linode SMTP unblock request rests on: a
#  tenant that has not verified a domain of its own cannot email the outside
#  world. Until now nothing asserted it — and a gate nobody tested is a gate
#  that might be off.
#
#  It only applies to the SUBMISSION port (5870 here, 587 in production).
#  Everything above sends through 2525, which is inbound and never consults
#  it — which is exactly why it went untested for so long.
#
#  The fixture is created here rather than in the seed so this file is
#  self-contained and so an unverified tenant does not sit in the demo data
#  looking like a real customer.
# ===========================================================================
hdr "Outbound gate (submission)"

SUB_PORT=${SUB_PORT:-5870}
GATE_TENANT='cccccccc-cccc-cccc-cccc-cccccccccccc'

psql_root() { docker exec -i tv-postgres psql -U postgres -d tatvaos_mail -tAc "$1" 2>&1; }

gate_teardown() {
    psql_root "DELETE FROM mail.mailboxes WHERE tenant_id = '$GATE_TENANT';
               DELETE FROM core.domains   WHERE tenant_id = '$GATE_TENANT';
               DELETE FROM core.storage_pools WHERE tenant_id = '$GATE_TENANT';
               DELETE FROM core.tenants   WHERE id = '$GATE_TENANT';" >/dev/null 2>&1
}
trap gate_teardown EXIT

gate_teardown   # in case a previous run died before its trap fired

setup_out=$(psql_root "
    INSERT INTO core.tenants (id, name, type, status, admin_name, admin_email, country)
    VALUES ('$GATE_TENANT', 'Unverified Co', 'business', 'trial',
            'Nobody', 'nobody@unverified.local', 'IN');

    INSERT INTO core.storage_pools (tenant_id, storage_model, total_bytes, per_user_quota_bytes)
    VALUES ('$GATE_TENANT', 'per_user', 1073741824, 1073741824);

    -- The whole point: is_active so mail routes to us, but ownership and MX
    -- both NULL, so the tenant has proved nothing.
    INSERT INTO core.domains (tenant_id, fqdn, type, is_active,
                              ownership_verified_at, mx_verified_at, is_platform)
    VALUES ('$GATE_TENANT', 'unverified.local', 'primary', true, NULL, NULL, true);

    INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part, type,
                                imap_password_hash, quota_bytes)
    SELECT '$GATE_TENANT', d.id, 'spammer@unverified.local', 'spammer', 'user',
           '{PLAIN}devpass123', 1073741824
      FROM core.domains d WHERE d.fqdn = 'unverified.local';
")

if psql_root "SELECT count(*) FROM mail.mailboxes WHERE address = 'spammer@unverified.local'" \
   | grep -qx 1; then
    pass "fixture created (unverified tenant, no ownership, no MX)"
else
    fail "could not create the gate fixture — the rest of this section proves nothing"
    printf '         %s\n' "$(printf '%s' "$setup_out" | tail -3)"
fi

# The view is the gate's source of truth. If this is wrong, everything below
# is testing Postfix against a lie.
if psql_root "SELECT count(*) FROM mail.senders_allowed_external
               WHERE address = 'spammer@unverified.local'" | grep -qx 0; then
    pass "senders_allowed_external excludes the unverified sender"
else
    fail "senders_allowed_external INCLUDES an unverified sender — the view is broken"
fi

if psql_root "SELECT count(*) FROM mail.senders_allowed_external
               WHERE address = 'amit@techvein.local'" | grep -qx 1; then
    pass "senders_allowed_external includes a fully verified sender"
else
    fail "a verified sender is NOT in the view — the gate would block real customers"
fi

submit() {
    swaks --server "$SMTP_HOST:$SUB_PORT" \
          --from "$1" --to "$2" \
          --header "Subject: gate test $(date +%s)" --body "x" \
          --hide-all --silent 3 >/dev/null 2>&1
}

# Like submit(), but keeps the transcript: the refusal's CODE and WORDING are
# the assertion, not merely that something was refused.
submit_verbose() {
    swaks --server "$SMTP_HOST:$SUB_PORT" \
          --from "$1" --to "$2" \
          --header "Subject: gate test $(date +%s)" --body "x" 2>&1
}

# THE assertion. If the send SUCCEEDS we have an open spam relay and the
# answer we gave Linode is untrue. But a bare "was it refused" is not enough
# to pass: this test once said [PASS] while main.cf carried shell quotes
# inside the static: value - the restriction was unparseable, Postfix refused
# EVERYTHING with "451 4.3.5 Server configuration error", and the customer
# story behind the green tick was an infinite retry loop with no mention of
# domain verification. A working gate and a broken config both refuse; only
# the code and the sentence tell them apart.
gate_out=$(submit_verbose "spammer@unverified.local" "victim@gmail.com")
if printf '%s' "$gate_out" | grep -q '250 2.0.0'; then
    fail "UNVERIFIED TENANT SENT TO THE OUTSIDE WORLD — the outbound gate is OFF"
    info "This is the control the Linode SMTP unblock rests on. Do not deploy."
elif printf '%s' "$gate_out" | grep -q '550 5\.7\.1' \
     && printf '%s' "$gate_out" | grep -q 'requires a verified domain'; then
    pass "unverified tenant refused with 550 5.7.1 and the verification message"
else
    fail "refused, but NOT with our 550 and our wording — the gate config is broken"
    info "A 451 here means the static: value did not parse; the customer sees"
    info "'server configuration error' and retries forever."
    printf '         %s\n' "$(printf '%s' "$gate_out" | grep -E '[245][0-9][0-9] ' | tail -3)"
fi

# The gate must not be a blanket ban, or a new customer cannot email their own
# colleagues while they set DNS up — which is the first hour of every signup.
if submit "spammer@unverified.local" "spammer@unverified.local"; then
    pass "unverified tenant can still send within the platform"
else
    fail "unverified tenant cannot send internally either — the gate is too broad"
fi

# A paying, verified customer must be unaffected.
if submit "amit@techvein.local" "someone@gmail.com"; then
    pass "verified tenant sends off-platform normally"
else
    fail "VERIFIED tenant blocked from sending out — the gate is rejecting customers"
fi

# ---------------------------------------------------------------------------
#  KNOWN GAP, asserted deliberately so it cannot change without someone
#  noticing.
#
#  'internal_only' permits any domain THE PLATFORM hosts, not any domain THE
#  TENANT owns. So an unverified signup can email every other TatvaOS
#  customer — while the rejection message says "outside your organisation".
#
#  Low impact at four customers, and it grows with every one. Fixing it needs
#  a recipient check scoped to the sender's tenant. Recorded here rather than
#  changed on the eve of a production promotion.
# ---------------------------------------------------------------------------
if submit "spammer@unverified.local" "amit@techvein.local"; then
    info "KNOWN GAP: unverified tenant can email OTHER tenants on the platform"
    info "  the gate is platform-internal, not organisation-internal"
else
    pass "gate is organisation-scoped (better than documented — update the docs)"
fi

gate_teardown
trap - EXIT
pass "fixture removed"

# ===========================================================================
#  PORT 587: A SIGNED-IN USER SENDS ONLY AS AN ADDRESS THEY OWN
# ===========================================================================
#
#  Found 1 Oct 2026, proven on this stack 2 Oct: production's 587 required a
#  sign-in, and then let the signed-in user put ANY address in MAIL FROM.
#  Signed in as ABC School's principal, mail as Techvein's amit@ went out
#  (250 queued), so did mail as ceo@bank.example. A school account could
#  send as another organisation, and past the outbound gate, since the gate
#  judged the address claimed rather than the person signed in.
#
#  The fix is Postfix's own: smtpd_sender_login_maps says who may use each
#  address (mail.sender_logins(), the mail edge's one question), and
#  reject_authenticated_sender_login_mismatch refuses everything else - for
#  signed-in sessions only, so the API's port 10587 (no sign-in, our own
#  network) is untouched.
#
#  This stack's 587 normally takes NO sign-in (local posture), so nothing
#  here could fail. The section switches 587 to production's exact rules
#  first - the lines Postfix's and Dovecot's entrypoints apply outside local,
#  minus the certificate - and puts the local ones back when it ends.
# ===========================================================================
hdr "Port 587: senders tied to the signed-in user"

SL_SCHOOL='22222222-2222-2222-2222-222222222222'
SL_DOMAIN='b2222222-2222-2222-2222-222222222222'
SL_USER='d2222222-2222-2222-2222-222222222222'      # the principal's person

sl_teardown() {
    psql_root "DELETE FROM mail.aliases   WHERE address IN ('hello@abcschool.local');
               DELETE FROM mail.mailboxes WHERE address IN ('office@abcschool.local','notices@abcschool.local');" >/dev/null 2>&1
    docker exec tv-postfix postconf -e submission_sasl_auth_enable=no \
        "submission_client_restrictions=permit_mynetworks,reject" \
        "submission_recipient_restrictions=permit_mynetworks,reject_unauth_destination,reject" \
        "submission_sender_login_check=warn_if_reject reject_authenticated_sender_login_mismatch" >/dev/null 2>&1
    docker exec tv-postfix sh -c 'echo warn > /etc/postfix/sender-ownership-mode' >/dev/null 2>&1
    docker exec tv-postfix postfix reload >/dev/null 2>&1
    docker exec tv-dovecot sh -c 'rm -f /etc/dovecot/env-overrides.conf && doveadm reload' >/dev/null 2>&1
}
trap sl_teardown EXIT
sl_teardown

# Two shared mailboxes - one the principal may SEND AS, one they may only
# READ - and an alias that delivers to the principal.
sl_setup=$(psql_root "
    INSERT INTO mail.mailboxes (tenant_id, domain_id, address, local_part, type, imap_password_hash, quota_bytes)
    VALUES ('$SL_SCHOOL', '$SL_DOMAIN', 'office@abcschool.local',  'office',  'shared', '{PLAIN}devpass123', 1073741824),
           ('$SL_SCHOOL', '$SL_DOMAIN', 'notices@abcschool.local', 'notices', 'shared', '{PLAIN}devpass123', 1073741824);
    INSERT INTO mail.mailbox_permissions (mailbox_id, user_id, permission)
    SELECT id, '$SL_USER', 'send_as' FROM mail.mailboxes WHERE address = 'office@abcschool.local';
    INSERT INTO mail.mailbox_permissions (mailbox_id, user_id, permission)
    SELECT id, '$SL_USER', 'read'    FROM mail.mailboxes WHERE address = 'notices@abcschool.local';
    INSERT INTO mail.aliases (tenant_id, domain_id, target_mailbox_id, address)
    SELECT '$SL_SCHOOL', '$SL_DOMAIN', id, 'hello@abcschool.local' FROM mail.mailboxes WHERE address = 'principal@abcschool.local';
")
if [ "$(psql_root "SELECT count(*) FROM mail.mailbox_permissions p JOIN mail.mailboxes m ON m.id = p.mailbox_id
                   WHERE m.address IN ('office@abcschool.local','notices@abcschool.local')")" = 2 ] \
   && [ "$(psql_root "SELECT count(*) FROM mail.aliases WHERE address = 'hello@abcschool.local'")" = 1 ]; then
    pass "fixture: a send-as shared mailbox, a read-only one, an alias"
else
    fail "could not create the fixture - this section proves nothing"
    printf '         %s\n' "$(printf '%s' "$sl_setup" | tail -3)"
fi

# Production's 587: sign-in required (Postfix), and Dovecot's SASL listener.
docker exec tv-dovecot sh -c 'printf "%s\n" "service auth {" "    inet_listener postfix-sasl {" "        port = 12345" "    }" "}" > /etc/dovecot/env-overrides.conf && doveadm reload' >/dev/null 2>&1
docker exec tv-postfix postconf -e submission_sasl_auth_enable=yes \
    "submission_client_restrictions=permit_sasl_authenticated,reject" \
    "submission_recipient_restrictions=permit_sasl_authenticated,reject_unauth_destination,reject" >/dev/null 2>&1
docker exec tv-postfix postfix reload >/dev/null 2>&1

# The check has two modes (Amit, 2 Oct 2026: warn first, enforce after a
# week of evidence). sl_mode sets BOTH halves: Postfix's envelope check
# (submission_sender_login_check) and the From-line filter
# (/etc/postfix/sender-ownership-mode). Enforce first: it is the rule.
sl_mode() {
    local check="reject_authenticated_sender_login_mismatch"
    [ "$1" = warn ] && check="warn_if_reject $check"
    docker exec tv-postfix sh -c "echo $1 > /etc/postfix/sender-ownership-mode && postconf -e 'submission_sender_login_check=$check' && postfix reload" >/dev/null 2>&1
    sleep 2
}
sl_mode enforce

# as LOGIN FROM TO [HEADER-FROM] -> the whole conversation, for code-and-
# wording asserts. HEADER-FROM is the visible From: line; without it swaks
# writes the envelope sender there.
as() {
    local hdr=(); [ -n "${4:-}" ] && hdr=(--header "From: $4")
    swaks --server "$SMTP_HOST:$SUB_PORT" --auth PLAIN --auth-user "$1" --auth-password "$PASS" \
          --from "$2" --to "$3" --header "Subject: 587 login test $(date +%s)" "${hdr[@]}" --body "x" 2>&1
}
queued()   { printf '%s' "$1" | grep -q '250 2.0.0 Ok: queued'; }
refused()  { printf '%s' "$1" | grep -q '553 5.7.1' && printf '%s' "$1" | grep -q 'not owned by user'; }
# The From-line filter answers after the headers, with its own words.
hrefused() { printf '%s' "$1" | grep -q '550 5.7.1' && printf '%s' "$1" | grep -q 'From: address'; }

# Wait until 587 answers with AUTH - a reload is not instant. A section that
# runs against a half-reloaded server tests the reload, not the rule.
for _ in $(seq 1 20); do
    swaks --server "$SMTP_HOST:$SUB_PORT" --quit-after EHLO 2>&1 | grep -q 'AUTH' && break; sleep 1
done

# The controls: the rules really are production's.
out=$(swaks --server "$SMTP_HOST:$SUB_PORT" --from principal@abcschool.local --to colleague@abcschool.local --body x 2>&1)
printf '%s' "$out" | grep -q '554 5.7.1' && pass "control: no sign-in is refused (554)" \
                                         || fail "control: unauthenticated submission was not refused - production rules not active"
out=$(swaks --server "$SMTP_HOST:$SUB_PORT" --auth PLAIN --auth-user principal@abcschool.local --auth-password wrong \
            --from principal@abcschool.local --to colleague@abcschool.local --body x 2>&1)
printf '%s' "$out" | grep -q '535 5.7.8' && pass "control: a wrong password is refused (535)" \
                                         || fail "control: a wrong password was not refused"

out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local)
queued "$out"  && pass "own address: accepted"                         || fail "own address refused - real users could not send"
out=$(as principal@abcschool.local office@abcschool.local amit@techvein.local)
queued "$out"  && pass "a shared mailbox they may SEND AS: accepted"   || fail "send_as on a shared mailbox refused"
out=$(as principal@abcschool.local hello@abcschool.local amit@techvein.local)
queued "$out"  && pass "an alias that delivers to them: accepted"      || fail "their own alias refused"
out=$(as office@abcschool.local office@abcschool.local amit@techvein.local)
queued "$out"  && pass "a shared mailbox signed in as itself: accepted" || fail "a shared mailbox's own sign-in refused"

out=$(as principal@abcschool.local amit@techvein.local outside@example.com)
if refused "$out"; then pass "ANOTHER ORGANISATION'S mailbox: refused (553 5.7.1, not owned)"
else fail "signed in as ABC School, SENT AS TECHVEIN - any user can impersonate any mailbox"
     info "$(printf '%s' "$out" | grep -E '^<[-~*]' | grep -E ' (4|5)[0-9]{2} ' | head -2)"; fi
out=$(as principal@abcschool.local ceo@bank.example outside@example.com)
if refused "$out"; then pass "an address nobody here owns: refused"
else fail "signed in as ABC School, SENT AS ceo@bank.example"; fi
out=$(as principal@abcschool.local notices@abcschool.local amit@techvein.local)
if refused "$out"; then pass "a shared mailbox they may only READ: refused"
else fail "read-only permission let them send as the shared mailbox"; fi
out=$(as principal@abcschool.local AMIT@TechVein.local outside@example.com)
if refused "$out"; then pass "...and capitals are not a way round"
else fail "sent as AMIT@TechVein.local - case is a way round the check"; fi

# The VISIBLE From: line (Mr. Singh, 2 Oct): mail apps show the person this,
# not the envelope. An honest envelope with another organisation's From:
# was queued until the From-line filter (local/postfix/sender-milter.py).
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local "amit@techvein.local")
if hrefused "$out"; then pass "honest envelope, ANOTHER ORGANISATION'S From: line: refused (550 5.7.1)"
elif queued "$out"; then fail "honest envelope with From: amit@techvein.local was ACCEPTED - the visible sender is forgeable"
else fail "honest envelope + forged From: refused, but not by the From-line check:"
     info "$(printf '%s' "$out" | grep -E '^<[-~*]' | grep -E ' (4|5)[0-9]{2} ' | head -2)"; fi
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local '"The Principal" <principal@abcschool.local>')
queued "$out"  && pass "own From: line with a display name: accepted"  || fail "own From: with a display name refused"
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local "office@abcschool.local")
queued "$out"  && pass "From: a shared mailbox they may SEND AS: accepted" || fail "From: a send_as shared mailbox refused"
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local "notices@abcschool.local")
if hrefused "$out"; then pass "From: a shared mailbox they may only READ: refused"
else fail "read-only permission let them put the shared mailbox in From:"; fi

# The API's port: no sign-in, our own network, and it sends as whichever
# mailbox the signed-in web user chose. The rule applies to SIGNED-IN
# sessions only, so this must be unchanged. Spoken from inside Postfix's
# container (10587 is never published).
api_out=$(docker exec tv-postfix bash -c 'exec 3<>/dev/tcp/127.0.0.1/10587; r(){ IFS= read -r l <&3; printf "%s\n" "$l"; }; r >/dev/null;
    printf "EHLO test\r\n" >&3; while r | grep -q "^250-"; do :; done;
    printf "MAIL FROM:<amit@techvein.local>\r\n" >&3; r;
    printf "RCPT TO:<principal@abcschool.local>\r\n" >&3; r;
    printf "QUIT\r\n" >&3' 2>&1)
if printf '%s' "$api_out" | tail -1 | grep -q '^250'; then
    pass "the API port (10587, no sign-in) is unchanged"
else
    fail "the API port refused a sender - the web app could not send"
    info "$(printf '%s' "$api_out" | tr -d '\r' | tail -2)"
fi

# WARN MODE (how it first ships, Amit 2 Oct): nothing is refused, and every
# message that WOULD be is written to a record that survives deploys - the
# evidence Mr. Singh's count needs, which Postfix's own log (lost at every
# deploy) cannot give. One line per mismatch: kind, class, organisation ids,
# a hash of the sign-in. Never an address.
sl_mode warn
EV=/var/log/tatvaos/sender-ownership.jsonl
ev_count() { docker exec tv-postfix sh -c "if [ -f $EV ]; then wc -l < $EV; else echo 0; fi" 2>/dev/null | tr -d ' \r'; }
n0=$(ev_count)
out=$(as principal@abcschool.local amit@techvein.local amit@techvein.local "principal@abcschool.local")
queued "$out" && pass "warn: another organisation's envelope sender is accepted (not yet refused)" \
              || fail "warn mode refused an envelope it should only record"
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local "amit@techvein.local")
queued "$out" && pass "warn: another organisation's From: line is accepted (not yet refused)" \
              || fail "warn mode refused a From: line it should only record"
out=$(as principal@abcschool.local principal@abcschool.local amit@techvein.local)
queued "$out" && pass "warn: an honest message is accepted"            || fail "warn mode refused an honest message"
sleep 1
n1=$(ev_count)
if [ "$(( ${n1:-0} - ${n0:-0} ))" = 2 ]; then pass "warn: exactly two lines recorded (the two impersonations, not the honest one)"
else fail "warn: expected 2 new evidence lines, got $(( ${n1:-0} - ${n0:-0} ))"; fi
recent=$(docker exec tv-postfix sh -c "tail -n 2 $EV" 2>/dev/null)
for want in '"kind": "envelope"' '"kind": "header"' '"class": "other_org"' \
            "\"login_tenant\": \"$SL_SCHOOL\"" '"claimed_tenant": "11111111-1111-1111-1111-111111111111"'; do
    if printf '%s' "$recent" | grep -qF -- "$want"; then pass "warn record says $want"
    else fail "warn record lacks $want"; info "$(printf '%s' "$recent" | head -2)"; fi
done
if [ -n "$recent" ] && ! docker exec tv-postfix grep -q '@' "$EV" 2>/dev/null; then
    pass "the record holds no address at all"
else
    fail "the record holds an address (or is missing) - it must carry ids and a hash only"
fi

sl_teardown
trap - EXIT
pass "587 back to the local rules, fixture removed"

# ===========================================================================
#  DKIM SIGNING
# ===========================================================================
#
#  Unsigned mail from a new IP goes to spam, and the failure is invisible from
#  our side — no error, no bounce, just nobody replying. So this asserts the
#  signature is actually on the wire rather than trusting that a container
#  started.
# ===========================================================================
hdr "DKIM"

if docker ps --format '{{.Names}}' | grep -qx tv-opendkim; then
    pass "tv-opendkim running"
else
    fail "tv-opendkim NOT running — outbound mail is unsigned"
fi

signed_count=$(docker logs tv-opendkim 2>&1 | grep -c 'signing .* domain' || true)
[ "${signed_count:-0}" -gt 0 ] \
    && pass "opendkim loaded its key table" \
    || fail "opendkim never reported a key table — check: docker compose logs opendkim"

# Postfix must actually be pointed at it. A milter configured and not wired is
# the failure this whole section exists to catch.
if docker exec tv-postfix postconf -h smtpd_milters 2>/dev/null | grep -q 'opendkim:8891'; then
    pass "postfix is wired to the milter"
else
    fail "postfix has no milter configured — nothing is being signed"
fi

# End to end: submit a message and read it back out of Mailpit.
dkim_subject="dkim probe $(date +%s)"
swaks --server "$SMTP_HOST:${SUB_PORT:-5870}" \
      --from "amit@techvein.local" --to "someone@example.com" \
      --header "Subject: $dkim_subject" --body "signed?" \
      --hide-all --silent 3 >/dev/null 2>&1
sleep 3

# Mailpit keeps the raw source, which is the only place a header can be
# checked without trusting an intermediate summary.
msg_id=$(curl -s "http://localhost:8025/api/v1/search?query=$(printf '%s' "$dkim_subject" | sed 's/ /%20/g')" \
         2>/dev/null | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$msg_id" ]; then
    fail "the probe message never reached mailpit — cannot check for a signature"
else
    raw=$(curl -s "http://localhost:8025/api/v1/message/$msg_id/raw" 2>/dev/null)
    if printf '%s' "$raw" | grep -qi '^DKIM-Signature:'; then
        pass "outbound mail carries a DKIM-Signature"
        # d= must be the SENDING domain. A signature by the wrong domain is
        # worse than none: it passes verification and fails DMARC alignment,
        # which is far harder to work out from a spam folder.
        if printf '%s' "$raw" | tr -d '\n\r' | grep -qi 'd=techvein.local'; then
            pass "signed by the sending domain (d=techvein.local)"
        else
            fail "signed by the WRONG domain — DMARC alignment will fail"
            printf '         %s\n' "$(printf '%s' "$raw" | grep -i -m1 'd=')"
        fi
    else
        fail "NO DKIM-Signature header — mail is going out unsigned"
        info "check: docker compose logs opendkim postfix"
    fi
fi

# ---------------------------------------------------------------------------
hdr "Outbound containment"
info "Every outbound message relays to Mailpit. Nothing reaches the internet."
info "Open http://localhost:8025 to read them."

# ---------------------------------------------------------------------------
printf '\n%s%s%s\n' "$CYAN" "----------------------------------------" "$RST"
printf '  passed: %s%d%s   failed: %s%d%s\n' \
    "$GREEN" "$PASSED" "$RST" \
    "$([ "$FAILED" -gt 0 ] && echo "$RED" || echo "$GRAY")" "$FAILED" "$RST"

if [ "$FAILED" -eq 0 ]; then
    printf '\n  %sLocal stack is working end to end.%s\n' "$GREEN" "$RST"
    printf '  %sThunderbird: IMAP localhost:%s, no encryption, amit@techvein.local / %s%s\n\n' \
        "$GRAY" "$IMAP_PORT" "$PASS" "$RST"
    exit 0
else
    printf '\n  %sSee: docker compose logs postfix dovecot%s\n\n' "$YEL" "$RST"
    exit 1
fi
