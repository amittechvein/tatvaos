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
