#!/usr/bin/env bash
#
# TatvaOS Mail - tenant isolation test
#
# This is the seed of tests/isolation from the delivery plan. It is the actual
# guarantee that one organisation cannot read another's mail; the RLS policy is
# only its implementation.
#
# Grow this file with every endpoint you add, for the life of the project.

set -uo pipefail

TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); GRAY=$(c $'\033[90m'); RST=$(c $'\033[0m')

hdr()  { printf '\n%s== %s%s\n' "$CYAN" "$1" "$RST"; }
pass() { printf '  %s[PASS]%s %s\n' "$GREEN" "$RST" "$1"; PASSED=$((PASSED+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$1"; FAILED=$((FAILED+1)); }

# Run a query as the application role with a given tenant context.
#
# psql emits a command tag for every statement, so "SET ...; SELECT count(*)"
# returns two lines: "SET" then "1". Without tail -n1 the caller sees "SET1"
# and every numeric comparison fails with "integer expected".
as_tenant() {
    local tenant="$1" sql="$2"
    docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -tAc \
        "SET app.tenant_id = '$tenant'; $sql" 2>/dev/null | tail -n1 | tr -d '[:space:]'
}

no_context() {
    docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

docker ps --format '{{.Names}}' | grep -qx tv-postgres || {
    printf '%sPostgres is not running.%s\n' "$RED" "$RST"; exit 1; }

# ---------------------------------------------------------------------------
hdr "Each tenant sees only its own messages"

t=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM messages")
s=$(as_tenant "$SCHOOL"   "SELECT count(*) FROM messages")
[ "${t:-0}" -ge 1 ] && pass "Techvein sees its own messages ($t)" || fail "Techvein sees nothing - RLS too strict or seed missing"
[ "${s:-0}" -ge 1 ] && pass "ABC School sees its own messages ($s)" || fail "ABC School sees nothing"

hdr "Neither tenant can see the other's mail"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM messages WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School rows" || fail "LEAK: Techvein sees $leak ABC School row(s)"

leak=$(as_tenant "$SCHOOL" "SELECT count(*) FROM messages WHERE tenant_id = '$TECHVEIN'")
[ "${leak:-1}" -eq 0 ] && pass "ABC School cannot see Techvein rows" || fail "LEAK: ABC School sees $leak Techvein row(s)"

hdr "Subject lines do not cross the boundary"

subj=$(as_tenant "$SCHOOL" "SELECT string_agg(subject,'|') FROM messages")
case "$subj" in
    *TECHVEIN*) fail "LEAK: ABC School can read a Techvein subject line" ;;
    *)          pass "no Techvein subject visible to ABC School" ;;
esac

hdr "Unset tenant context fails CLOSED"

n=$(no_context "SELECT count(*) FROM messages")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero rows" \
                    || fail "DANGEROUS: ${n} row(s) visible with no tenant set"

hdr "Writes cannot be forged into another tenant"

forge_out=$(docker exec tv-postgres psql -U tatvaos_app -d tatvaos_mail -tAc \
    "SET app.tenant_id = '$TECHVEIN';
     INSERT INTO messages (tenant_id, mailbox_id, folder_id, subject)
     SELECT '$SCHOOL', m.id, f.id, 'forged-by-isolation-test'
     FROM   mailboxes m
     JOIN   folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
     WHERE  m.address = 'amit@techvein.local'
     LIMIT  1;" 2>&1)
forge_rc=$?

if [ "$forge_rc" -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security\|violates'; then
    pass "cross-tenant INSERT blocked by WITH CHECK"
elif printf '%s' "$forge_out" | grep -q 'INSERT 0 0'; then
    fail "test inconclusive - source row not visible, rewrite the fixture"
else
    fail "LEAK: Techvein wrote a row tagged as ABC School - WITH CHECK is missing"
    # clean up so the next run is not polluted by the forged row
    docker exec tv-postgres psql -U postgres -d tatvaos_mail -tAc \
        "DELETE FROM messages WHERE subject = 'forged-by-isolation-test';" >/dev/null 2>&1
fi

hdr "Mail edge cannot reach content tables"

if docker exec tv-postgres psql -U tatvaos_mailedge -d tatvaos_mail \
        -tAc "SELECT count(*) FROM messages" >/dev/null 2>&1; then
    fail "mail edge can read messages - revoke that grant"
else
    pass "mail edge denied on messages"
fi

if docker exec tv-postgres psql -U tatvaos_mailedge -d tatvaos_mail \
        -tAc "SELECT count(*) FROM mailboxes" >/dev/null 2>&1; then
    pass "mail edge can still read mailboxes (needed for routing)"
else
    fail "mail edge cannot read mailboxes - Postfix will reject everything"
fi

# ---------------------------------------------------------------------------
printf '\n%s%s%s\n' "$CYAN" "----------------------------------------" "$RST"
printf '  passed: %s%d%s   failed: %s%d%s\n' \
    "$GREEN" "$PASSED" "$RST" \
    "$([ "$FAILED" -gt 0 ] && echo "$RED" || echo "$GRAY")" "$FAILED" "$RST"

if [ "$FAILED" -eq 0 ]; then
    printf '\n  %sTenant isolation holds.%s\n\n' "$GREEN" "$RST"; exit 0
else
    printf '\n  %sISOLATION IS BROKEN. Stop and fix this before writing more code.%s\n\n' "$RED" "$RST"; exit 1
fi
