#!/usr/bin/env bash
#
# TatvaOS - tenant isolation test
#
# THE test. It is the actual guarantee that one organisation cannot read
# another's mail; the RLS policy is only its implementation.
#
# Grow this file with every endpoint you add, for the life of the project.
#
# ---------------------------------------------------------------------------
#  ONE script, two ways of reaching Postgres.
#
#  This used to exist as two copies - one for the local Docker stack, one
#  inlined into .github/workflows/ci.yml. They drifted, and a psql
#  command-tag bug that had already been fixed in one reappeared in the
#  other. Copies of assertions do not stay in sync; the connection details
#  are the only thing that legitimately differs, so that is the only thing
#  parameterised.
#
#    TATVAOS_PSQL_MODE=docker   (default)  docker exec tv-postgres psql -U <role>
#    TATVAOS_PSQL_MODE=direct              psql -h $PGHOST, then SET ROLE <role>
#
#  Direct mode is for CI service containers, where only the superuser has a
#  password and roles are reached with SET ROLE.
# ---------------------------------------------------------------------------

set -uo pipefail

TECHVEIN='11111111-1111-1111-1111-111111111111'
SCHOOL='22222222-2222-2222-2222-222222222222'

MODE="${TATVAOS_PSQL_MODE:-docker}"
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-tatvaos_mail}"
CONTAINER="${TATVAOS_PG_CONTAINER:-tv-postgres}"

PASSED=0; FAILED=0
c() { [ -t 1 ] && printf '%s' "$1" || true; }
GREEN=$(c $'\033[32m'); RED=$(c $'\033[31m'); CYAN=$(c $'\033[36m'); GRAY=$(c $'\033[90m'); RST=$(c $'\033[0m')

hdr()  { printf '\n%s== %s%s\n' "$CYAN" "$1" "$RST"; }
pass() { printf '  %s[PASS]%s %s\n' "$GREEN" "$RST" "$1"; PASSED=$((PASSED+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$1"; FAILED=$((FAILED+1)); }

# Run SQL as a given role. Returns psql's exit status; output goes to stdout.
run_as() {
    local role="$1" sql="$2"
    if [ "$MODE" = "direct" ]; then
        psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -tAc "SET ROLE $role; $sql"
    else
        docker exec "$CONTAINER" psql -U "$role" -d "$PGDATABASE" -tAc "$sql"
    fi
}

# Scalar result of a query run as a role.
#
# tail -n1 is not cosmetic. psql prints a command tag for every non-SELECT
# statement, so "SET ROLE x; SET app.tenant_id = y; SELECT count(*)" returns
# "SET", "SET", then the number. Without this the caller sees "SETSET0" and
# reports a failure that has nothing to do with isolation.
scalar_as() {
    run_as "$1" "$2" 2>/dev/null | tail -n1 | tr -d '[:space:]'
}

as_tenant() {
    scalar_as tatvaos_app "SET app.tenant_id = '$1'; $2"
}

no_context() {
    scalar_as tatvaos_app "$1"
}

# ---------------------------------------------------------------------------
if [ "$MODE" = "docker" ]; then
    docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || {
        printf '%sPostgres container %s is not running.%s\n' "$RED" "$CONTAINER" "$RST"; exit 1; }
fi

# ---------------------------------------------------------------------------
hdr "Each tenant sees only its own messages"

t=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM mail.messages")
s=$(as_tenant "$SCHOOL"   "SELECT count(*) FROM mail.messages")
[ "${t:-0}" -ge 1 ] && pass "Techvein sees its own messages ($t)" || fail "Techvein sees nothing - RLS too strict or seed missing"
[ "${s:-0}" -ge 1 ] && pass "ABC School sees its own messages ($s)" || fail "ABC School sees nothing"

hdr "Neither tenant can see the other's mail"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM mail.messages WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School rows" || fail "LEAK: Techvein sees $leak ABC School row(s)"

leak=$(as_tenant "$SCHOOL" "SELECT count(*) FROM mail.messages WHERE tenant_id = '$TECHVEIN'")
[ "${leak:-1}" -eq 0 ] && pass "ABC School cannot see Techvein rows" || fail "LEAK: ABC School sees $leak Techvein row(s)"

hdr "Subject lines do not cross the boundary"

subj=$(as_tenant "$SCHOOL" "SELECT string_agg(subject,'|') FROM mail.messages")
case "$subj" in
    *TECHVEIN*) fail "LEAK: ABC School can read a Techvein subject line" ;;
    *)          pass "no Techvein subject visible to ABC School" ;;
esac

hdr "Unset tenant context fails CLOSED"

n=$(no_context "SELECT count(*) FROM mail.messages")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero rows" \
                    || fail "DANGEROUS: ${n} row(s) visible with no tenant set"

hdr "Core content is isolated too, not just mail"

# Added when Core took ownership of billing. A leak here exposes what another
# organisation pays, which is commercially damaging in a different way from a
# mail leak and is just as unacceptable.
leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.subscriptions WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's subscription" \
                       || fail "LEAK: billing data visible across tenants"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.storage_pools WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's storage pool" \
                       || fail "LEAK: storage pool visible across tenants"

hdr "Connect meetings are isolated"

# Connect ships its own fixture rather than relying on the seed, because a
# meeting is created by a person at runtime and the seed has none. Inserted as
# postgres (superuser bypasses RLS), asserted as tatvaos_app, removed at the
# end — so a failing run leaves no rows behind to confuse the next one.
run_as postgres "
    INSERT INTO connect.meetings (id, tenant_id, code, title, status)
    VALUES ('dddddddd-0000-0000-0000-00000000dddd','$TECHVEIN','ISOTESTtechveinXXXXXXX','iso-techvein','active'),
           ('eeeeeeee-0000-0000-0000-00000000eeee','$SCHOOL','ISOTESTschoolXXXXXXXXX','iso-school','active')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO connect.participants (meeting_id, display_name, identity)
    VALUES ('dddddddd-0000-0000-0000-00000000dddd','iso','user:iso-t'),
           ('eeeeeeee-0000-0000-0000-00000000eeee','iso','user:iso-s')
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM connect.meetings WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's meetings" \
                       || fail "LEAK: $leak ABC School meeting(s) visible to Techvein"

own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM connect.meetings WHERE title = 'iso-techvein'")
[ "${own:-0}" -ge 1 ] && pass "Techvein sees its own meeting" \
                      || fail "Techvein sees nothing - RLS too strict, or the migration did not run"

# The child tables carry no tenant_id and are scoped through the meeting. A
# policy that forgot the EXISTS would show every tenant's participants while
# connect.meetings itself still looked correctly isolated.
leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM connect.participants WHERE identity = 'user:iso-s'")
[ "${leak:-1}" -eq 0 ] && pass "participants are scoped through the meeting" \
                       || fail "LEAK: another tenant's participant row is visible"

n=$(no_context "SELECT count(*) FROM connect.meetings")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero meetings" \
                    || fail "DANGEROUS: ${n} meeting(s) visible with no tenant set"

# The empty-string trap: the connection interceptor sends an unset tenant as
# '' and a bare ::uuid cast on that THROWS, taking the request with it. This
# asserts the query answers rather than errors.
empty=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM connect.meetings")
[ "${empty:-x}" = "0" ] && pass "empty tenant string returns zero, does not throw" \
                        || fail "empty app.tenant_id did not return 0 (got '${empty}') - check the nullif()"

forge_out=$(run_as tatvaos_app \
    "SET app.tenant_id = '$TECHVEIN';
     INSERT INTO connect.meetings (tenant_id, code, title)
     VALUES ('$SCHOOL','ISOTESTforgedXXXXXXXXX','forged-by-isolation-test');" 2>&1)
forge_rc=$?
if [ "$forge_rc" -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security\|violates'; then
    pass "cross-tenant meeting INSERT blocked by WITH CHECK"
else
    fail "LEAK: Techvein wrote a meeting tagged as ABC School - WITH CHECK is missing"
fi

run_as postgres "
    DELETE FROM connect.meetings
     WHERE title IN ('iso-techvein','iso-school','forged-by-isolation-test');" >/dev/null 2>&1

hdr "Sign-in handoff codes are isolated, and the redeem reaches no further than one row"

# Decision 0003. This table is unusual and so is its test: the REDEEM is
# deliberately allowed to cross the tenant boundary, because the browser
# presenting a code has no session and the tenant is unknown until the row is
# read. That makes "how far can it reach" the question worth asking, not "can
# it reach at all". The fixture uses a real user per tenant, since the row
# references both.
run_as postgres "
    INSERT INTO core.auth_handoff_codes (tenant_id, user_id, code_hash, path, expires_at)
    SELECT '$TECHVEIN', u.id, 'iso-handoff-techvein', '/mail/inbox', now() + interval '10 minutes'
      FROM core.users u WHERE u.tenant_id = '$TECHVEIN' LIMIT 1;
    INSERT INTO core.auth_handoff_codes (tenant_id, user_id, code_hash, path, expires_at)
    SELECT '$SCHOOL', u.id, 'iso-handoff-school', '/mail/inbox', now() + interval '10 minutes'
      FROM core.users u WHERE u.tenant_id = '$SCHOOL' LIMIT 1;" >/dev/null 2>&1

own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.auth_handoff_codes WHERE code_hash = 'iso-handoff-techvein'")
[ "${own:-0}" -ge 1 ] && pass "Techvein sees its own handoff code" \
                      || fail "Techvein sees nothing - RLS too strict, or the migration did not run"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.auth_handoff_codes WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's handoff codes" \
                       || fail "LEAK: $leak ABC School handoff code(s) visible to Techvein"

n=$(no_context "SELECT count(*) FROM core.auth_handoff_codes")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero handoff codes" \
                    || fail "DANGEROUS: ${n} handoff code(s) visible with no tenant set"

forge_out=$(run_as tatvaos_app \
    "SET app.tenant_id = '$TECHVEIN';
     INSERT INTO core.auth_handoff_codes (tenant_id, user_id, code_hash, path, expires_at)
     SELECT '$SCHOOL', u.id, 'iso-handoff-forged', '/mail/inbox', now() + interval '10 minutes'
       FROM core.users u WHERE u.tenant_id = '$TECHVEIN' LIMIT 1;" 2>&1)
forge_rc=$?
if [ "$forge_rc" -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security\|violates'; then
    pass "cross-tenant handoff code INSERT blocked by WITH CHECK"
else
    fail "LEAK: Techvein minted a handoff code tagged as ABC School - WITH CHECK is missing"
fi

# The deliberate hole, bounded. With NO tenant set, the SECURITY DEFINER
# function returns the ONE row whose hash was presented — and nothing else.
# A function that returned more, or that answered for a hash nobody holds,
# would turn a 256-bit guess into an oracle.
redeemed=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM core.redeem_handoff_code('iso-handoff-school')")
[ "${redeemed:-x}" = "1" ] && pass "redeem resolves its own row with no tenant context - the point of the function" \
                           || fail "the handoff redeem did not work without a tenant (got '${redeemed}')"

stranger=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM core.redeem_handoff_code('iso-handoff-not-a-real-hash')")
[ "${stranger:-x}" = "0" ] && pass "redeem answers nothing for a hash nobody holds" \
                           || fail "DANGEROUS: the redeem returned a row for an unknown hash"

run_as postgres "
    DELETE FROM core.auth_handoff_codes
     WHERE code_hash IN ('iso-handoff-techvein','iso-handoff-school','iso-handoff-forged');" >/dev/null 2>&1

hdr "Writes cannot be forged into another tenant"

forge_out=$(run_as tatvaos_app \
    "SET app.tenant_id = '$TECHVEIN';
     INSERT INTO mail.messages (tenant_id, mailbox_id, folder_id, subject)
     SELECT '$SCHOOL', m.id, f.id, 'forged-by-isolation-test'
     FROM   mail.mailboxes m
     JOIN   mail.folders   f ON f.mailbox_id = m.id AND f.name = 'INBOX'
     WHERE  m.address = 'amit@techvein.local'
     LIMIT  1;" 2>&1)
forge_rc=$?

# The source row is one Techvein CAN see, stamped with ABC School's id. An
# earlier version selected from a row belonging to the other tenant, which RLS
# made invisible - so nothing was inserted, psql exited 0, and the test passed
# while proving nothing.
if [ "$forge_rc" -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security\|violates'; then
    pass "cross-tenant INSERT blocked by WITH CHECK"
elif printf '%s' "$forge_out" | grep -q 'INSERT 0 0'; then
    fail "test inconclusive - source row not visible, rewrite the fixture"
else
    fail "LEAK: Techvein wrote a row tagged as ABC School - WITH CHECK is missing"
    run_as postgres "DELETE FROM mail.messages WHERE subject = 'forged-by-isolation-test';" >/dev/null 2>&1
fi

hdr "Mail edge cannot reach content tables"

if run_as tatvaos_mailedge "SELECT count(*) FROM mail.messages" >/dev/null 2>&1; then
    fail "mail edge can read messages - revoke that grant"
else
    pass "mail edge denied on messages"
fi

if run_as tatvaos_mailedge "SELECT count(*) FROM core.subscriptions" >/dev/null 2>&1; then
    fail "mail edge can read billing - revoke that grant"
else
    pass "mail edge denied on billing"
fi

if run_as tatvaos_mailedge "SELECT count(*) FROM mail.mailboxes" >/dev/null 2>&1; then
    pass "mail edge can still read mailboxes (needed for routing)"
else
    fail "mail edge cannot read mailboxes - Postfix will reject everything"
fi

# ---------------------------------------------------------------------------
hdr "Append-only tables refuse rewrites from the app"

# Every schema re-grants the app UPDATE and DELETE on all its tables on every
# deploy; later files take them back for the tables that are records. Which
# writes each table really has is catalogued in
# local/postgres/init/20260915-append-only-revokes.sql. Checked by privilege,
# not by rows: WHERE false touches nothing, so the only way one of these can
# fail is a permission error.
for stmt in \
    "DELETE FROM core.audit_logs WHERE false" \
    "UPDATE core.audit_logs SET tenant_id = tenant_id WHERE false" \
    "DELETE FROM connect.meeting_events WHERE false" \
    "UPDATE connect.meeting_events SET kind = kind WHERE false" \
    "DELETE FROM connect.recording_access_log WHERE false" \
    "UPDATE connect.recording_access_log SET level = level WHERE false" \
    "DELETE FROM mail.api_keys WHERE false" \
    "DELETE FROM mail.app_passwords WHERE false" \
    "DELETE FROM mail.api_sends WHERE false" \
    "DELETE FROM family.contact_audit_logs WHERE false"
do
    if run_as tatvaos_app "$stmt" >/dev/null 2>&1; then
        fail "app can still run: $stmt"
    else
        pass "app refused: $stmt"
    fi
done

# Rule 7, the other half. The writes the app really makes must still work: an
# audit trail nobody can append to is an outage, and a key that cannot be
# revoked is worse than one that can be deleted.
for stmt in \
    "INSERT INTO core.audit_logs (tenant_id) SELECT tenant_id FROM core.audit_logs WHERE false" \
    "INSERT INTO connect.meeting_events (meeting_id, kind, occurred_at) SELECT meeting_id, kind, occurred_at FROM connect.meeting_events WHERE false" \
    "INSERT INTO connect.recording_access_log (tenant_id, recording_id, level) SELECT tenant_id, recording_id, level FROM connect.recording_access_log WHERE false" \
    "UPDATE mail.api_keys SET revoked_at = revoked_at WHERE false" \
    "UPDATE mail.app_passwords SET revoked_at = revoked_at WHERE false"
do
    if run_as tatvaos_app "$stmt" >/dev/null 2>&1; then
        pass "app can still run: $stmt"
    else
        fail "app REFUSED a write it needs: $stmt"
    fi
done

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
