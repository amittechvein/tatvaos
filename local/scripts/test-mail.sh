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

# ---------------------------------------------------------------------------
hdr "Containers"
for svc in tv-postgres tv-postfix tv-dovecot tv-mailpit; do
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
