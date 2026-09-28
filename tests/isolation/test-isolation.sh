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

hdr "Connect's child tables carry their own tenant_id (decision 0007, step two)"

# Nine tables that were isolated only by a policy joining to connect.meetings
# for every row now carry tenant_id, set by a trigger FROM THE MEETING. Fixture
# as postgres: a School meeting with one row in each table the trigger feeds.
SM=$(scalar_as postgres "WITH x AS (INSERT INTO connect.meetings (tenant_id, code, title, kind, status)
        VALUES ('$SCHOOL', 'iso-s2-$$', 'iso-s2-school', 'instant', 'active') RETURNING id) SELECT id FROM x")
run_as postgres "
    INSERT INTO connect.participants (meeting_id, identity, display_name, role, is_guest)
        VALUES ('$SM', 'iso-s2-p', 'iso-s2', 'participant', true);
    INSERT INTO connect.meeting_events (meeting_id, kind, occurred_at) VALUES ('$SM', 'room_started', now());
    INSERT INTO connect.meeting_chat (meeting_id, client_id, identity, display_name, body) VALUES ('$SM', gen_random_uuid(), 'iso-s2-p', 'iso', 'iso-s2');
    INSERT INTO connect.recordings (meeting_id, egress_id, mode, status, file_name) VALUES ('$SM', 'EG_iso_s2_$$', 'audio', 'ready', 'iso-s2.ogg');" >/dev/null 2>&1

for t in participants lobby_requests meeting_events meeting_chat caption_lines meeting_blocks meeting_notes recordings transcripts; do
    n=$(no_context "SELECT count(*) FROM connect.$t")
    [ "${n:-1}" -eq 0 ] && pass "connect.$t: no tenant context returns zero rows"                         || fail "DANGEROUS: connect.$t shows ${n} row(s) with no tenant set"
    empty=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM connect.$t")
    [ "${empty:-x}" = "0" ] && pass "connect.$t: empty tenant string returns zero"                             || fail "connect.$t: empty app.tenant_id returned '${empty}'"
    there=$(scalar_as postgres "SELECT count(*) FROM connect.$t WHERE tenant_id = '$SCHOOL'")
    leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM connect.$t WHERE tenant_id = '$SCHOOL'")
    if [ "${there:-0}" -eq 0 ]; then
        pass "connect.$t: (no School rows exist to leak - covered by the no-context checks)"
    elif [ "${leak:-1}" -eq 0 ]; then
        pass "connect.$t: Techvein sees none of ABC School's ${there} row(s)"
    else
        fail "LEAK: connect.$t shows ${leak} ABC School row(s) to Techvein"
    fi
done

# The fixture really exists, row by row: it is ONE psql batch, one bad insert
# rolls back all four (a ready recording without a file did, on the first
# run), and then "no School rows to leak" would be every answer above.
for t in participants meeting_events meeting_chat recordings; do
    same_n=$(scalar_as postgres "SELECT count(*) FROM connect.$t WHERE meeting_id = '$SM' AND tenant_id = '$SCHOOL'")
    [ "${same_n:-0}" -eq 1 ] && pass "connect.$t: the trigger gave the School fixture row the School's tenant_id"                              || fail "connect.$t: the School fixture row is missing or has the wrong tenant_id (got '${same_n}')"
done

# A writer cannot choose tenant_id: the trigger takes it from the meeting.
run_as postgres "INSERT INTO connect.meeting_events (meeting_id, kind, occurred_at, tenant_id)
    VALUES ('$SM', 'participant_joined', now(), '$TECHVEIN');" >/dev/null 2>&1
forged=$(scalar_as postgres "SELECT count(*) FROM connect.meeting_events WHERE meeting_id = '$SM' AND tenant_id = '$TECHVEIN'")
[ "${forged:-1}" -eq 0 ] && pass "a supplied tenant_id is overwritten from the meeting (even as postgres)"                          || fail "LEAK: a child row kept a tenant_id that is not its meeting's"

# Techvein cannot hang a row off ABC School's meeting: the trigger cannot see
# the meeting under Techvein's RLS, tenant_id stays NULL, NOT NULL refuses it.
out=$(run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
    INSERT INTO connect.meeting_chat (meeting_id, client_id, identity, display_name, body) VALUES ('$SM', gen_random_uuid(), 'x', 'x', 'iso-s2-forged');" 2>&1)
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qiE 'null value|row-level security'; then
    pass "Techvein cannot write a chat row into ABC School's meeting"
else
    fail "LEAK: Techvein wrote into ABC School's meeting ($(printf '%s' "$out" | head -c 120))"
fi

run_as postgres "DELETE FROM connect.meetings WHERE id = '$SM';" >/dev/null 2>&1

hdr "Locations and designations are isolated (Hire & People, Phase 0)"

# Fixture as postgres (bypasses RLS), asserted as tatvaos_app, removed at the
# end - the Connect pattern above. One row per tenant per table.
run_as postgres "
    INSERT INTO core.locations (tenant_id, name) VALUES
        ('$TECHVEIN','iso-loc-techvein'), ('$SCHOOL','iso-loc-school')
    ON CONFLICT DO NOTHING;
    INSERT INTO core.designations (tenant_id, title) VALUES
        ('$TECHVEIN','iso-des-techvein'), ('$SCHOOL','iso-des-school')
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1

for pair in "core.locations:name:iso-loc" "core.designations:title:iso-des"; do
    tbl=${pair%%:*}; rest=${pair#*:}; col=${rest%%:*}; pfx=${rest#*:}

    # The subject happened: the fixture is really there, and the owner sees it.
    # Without this every "0 leaked" below would pass on an empty table.
    own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM $tbl WHERE $col = '$pfx-techvein'")
    [ "${own:-0}" -eq 1 ] && pass "$tbl: Techvein sees its own row" \
                          || fail "$tbl: Techvein cannot see its own row (got '${own}') - fixture or RLS too strict"

    leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM $tbl WHERE tenant_id = '$SCHOOL'")
    [ "${leak:-1}" -eq 0 ] && pass "$tbl: Techvein cannot see ABC School's rows" \
                           || fail "LEAK: $tbl shows $leak ABC School row(s) to Techvein"

    leak=$(as_tenant "$SCHOOL" "SELECT count(*) FROM $tbl WHERE $col = '$pfx-techvein'")
    [ "${leak:-1}" -eq 0 ] && pass "$tbl: ABC School cannot see Techvein's row" \
                           || fail "LEAK: $tbl shows a Techvein row to ABC School"

    n=$(no_context "SELECT count(*) FROM $tbl")
    [ "${n:-1}" -eq 0 ] && pass "$tbl: no tenant context returns zero rows" \
                        || fail "DANGEROUS: $tbl shows ${n} row(s) with no tenant set"

    empty=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM $tbl")
    [ "${empty:-x}" = "0" ] && pass "$tbl: empty tenant string returns zero, does not throw" \
                            || fail "$tbl: empty app.tenant_id did not return 0 (got '${empty}') - check the nullif()"

    # An UPDATE aimed across the boundary must touch nothing. Read back as
    # postgres, so RLS cannot hide a row that was in fact changed.
    run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
        UPDATE $tbl SET $col = '$pfx-hijacked' WHERE tenant_id = '$SCHOOL';" >/dev/null 2>&1
    hij=$(scalar_as postgres "SELECT count(*) FROM $tbl WHERE $col = '$pfx-hijacked'")
    [ "${hij:-1}" -eq 0 ] && pass "$tbl: cross-tenant UPDATE changed nothing" \
                          || fail "LEAK: Techvein renamed an ABC School row in $tbl"

    forge_out=$(run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
        INSERT INTO $tbl (tenant_id, $col) VALUES ('$SCHOOL', '$pfx-forged');" 2>&1)
    forge_rc=$?
    if [ "$forge_rc" -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security'; then
        pass "$tbl: cross-tenant INSERT blocked by WITH CHECK"
    else
        fail "LEAK: Techvein wrote a $tbl row tagged as ABC School - WITH CHECK is missing"
    fi

    # Names are unique per organisation ignoring case and outer spaces. The
    # refusal must be the unique index, not some other error.
    dup_out=$(run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
        INSERT INTO $tbl (tenant_id, $col) VALUES ('$TECHVEIN', '  ISO-${pfx#iso-}-TECHVEIN ');" 2>&1)
    if printf '%s' "$dup_out" | grep -qi 'duplicate key'; then
        pass "$tbl: same name in a different case is refused"
    else
        fail "$tbl: a case-variant duplicate was accepted or failed for another reason"
    fi
done

run_as postgres "
    DELETE FROM core.locations    WHERE name  LIKE 'iso-loc-%' OR lower(btrim(name))  LIKE 'iso-loc-%';
    DELETE FROM core.designations WHERE title LIKE 'iso-des-%' OR lower(btrim(title)) LIKE 'iso-des-%';" >/dev/null 2>&1

hdr "Hire job openings are isolated, and cannot point into another organisation"

# Fixture as postgres. The School location exists so a Techvein job can TRY
# to name it below. Drafts, so no slug: since 24 Sept a slug exists only once
# a job is published (ck_job_slug_at_publish). The first run after that rule
# went red on "sees its own job" when this fixture still carried slugs and
# was refused — the guard doing its job, not a leak.
run_as postgres "
    INSERT INTO core.locations (id, tenant_id, name) VALUES
        ('0a000000-0000-0000-0000-0000000000a1','$SCHOOL','iso-job-loc-school')
    ON CONFLICT DO NOTHING;
    INSERT INTO hire.job_openings (id, tenant_id, title) VALUES
        ('0b000000-0000-0000-0000-0000000000b1','$TECHVEIN','iso-job-techvein'),
        ('0b000000-0000-0000-0000-0000000000b2','$SCHOOL','iso-job-school')
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1

own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.job_openings WHERE title = 'iso-job-techvein'")
[ "${own:-0}" -eq 1 ] && pass "Techvein sees its own job opening" \
                      || fail "Techvein cannot see its own job (got '${own}') - fixture or RLS too strict"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.job_openings WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's job openings" \
                       || fail "LEAK: $leak ABC School job(s) visible to Techvein"

leak=$(as_tenant "$SCHOOL" "SELECT count(*) FROM hire.job_openings WHERE title = 'iso-job-techvein'")
[ "${leak:-1}" -eq 0 ] && pass "ABC School cannot see Techvein's job opening" \
                       || fail "LEAK: a Techvein job is visible to ABC School"

n=$(no_context "SELECT count(*) FROM hire.job_openings")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero job openings" \
                    || fail "DANGEROUS: ${n} job opening(s) visible with no tenant set"

empty=$(scalar_as tatvaos_app "SET app.tenant_id = ''; SELECT count(*) FROM hire.job_openings")
[ "${empty:-x}" = "0" ] && pass "empty tenant string returns zero job openings, does not throw" \
                        || fail "hire.job_openings: empty app.tenant_id did not return 0 (got '${empty}')"

run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
    UPDATE hire.job_openings SET title = 'iso-job-hijacked' WHERE tenant_id = '$SCHOOL';" >/dev/null 2>&1
hij=$(scalar_as postgres "SELECT count(*) FROM hire.job_openings WHERE title = 'iso-job-hijacked'")
[ "${hij:-1}" -eq 0 ] && pass "cross-tenant job UPDATE changed nothing" \
                      || fail "LEAK: Techvein renamed an ABC School job"

forge_out=$(run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
    INSERT INTO hire.job_openings (tenant_id, title) VALUES ('$SCHOOL','iso-job-forged');" 2>&1)
if [ $? -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security'; then
    pass "cross-tenant job INSERT blocked by WITH CHECK"
else
    fail "LEAK: Techvein wrote a job tagged as ABC School - WITH CHECK is missing"
fi

# The references. Run as POSTGRES, which bypasses row-level security, so the
# only thing that can refuse is the composite (tenant_id, id) foreign key. A
# plain FK on id alone would accept both of these.
for ref in "location_id:0a000000-0000-0000-0000-0000000000a1:ABC School's location" \
           "hiring_manager_id:$(scalar_as postgres "SELECT id FROM core.users WHERE tenant_id = '$SCHOOL' ORDER BY id LIMIT 1"):an ABC School person"
do
    col=${ref%%:*}; rest=${ref#*:}; val=${rest%%:*}; what=${rest#*:}
    if [ -z "$val" ]; then fail "no fixture for '$what' - nothing to test the $col foreign key with"; continue; fi
    out=$(run_as postgres "UPDATE hire.job_openings SET $col = '$val'
                            WHERE id = '0b000000-0000-0000-0000-0000000000b1';" 2>&1)
    if printf '%s' "$out" | grep -qi 'foreign key'; then
        pass "a Techvein job cannot name $what ($col), even bypassing RLS"
    else
        fail "LEAK: a Techvein job was allowed to name $what ($col)"
    fi
done

run_as postgres "
    DELETE FROM hire.job_openings WHERE title LIKE 'iso-job-%';
    DELETE FROM core.locations WHERE name = 'iso-job-loc-school';" >/dev/null 2>&1

hdr "Hire teams are isolated, and cannot contain another organisation's people"

T_USER=$(scalar_as postgres "SELECT id FROM core.users WHERE tenant_id = '$TECHVEIN' ORDER BY id LIMIT 1")
S_USER=$(scalar_as postgres "SELECT id FROM core.users WHERE tenant_id = '$SCHOOL' ORDER BY id LIMIT 1")
run_as postgres "
    INSERT INTO hire.team_members (tenant_id, user_id, role) VALUES
        ('$TECHVEIN','$T_USER','recruiter'), ('$SCHOOL','$S_USER','recruiter')
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1

own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.team_members WHERE user_id = '$T_USER'")
[ "${own:-0}" -eq 1 ] && pass "Techvein sees its own team member" \
                      || fail "Techvein cannot see its own team member (got '${own}') - fixture or RLS too strict"

leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.team_members WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's hiring team" \
                       || fail "LEAK: $leak ABC School team member(s) visible to Techvein"

n=$(no_context "SELECT count(*) FROM hire.team_members")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero team members" \
                    || fail "DANGEROUS: ${n} team member(s) visible with no tenant set"

# The privilege-escalation shape: Techvein's admin writing a row that makes
# someone a recruiter in ABC School. WITH CHECK must refuse it.
forge_out=$(run_as tatvaos_app "SET app.tenant_id = '$TECHVEIN';
    INSERT INTO hire.team_members (tenant_id, user_id, role) VALUES ('$SCHOOL','$S_USER','hiring_manager')
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'hiring_manager';" 2>&1)
if [ $? -ne 0 ] && printf '%s' "$forge_out" | grep -qi 'row-level security'; then
    pass "cross-tenant team write blocked by WITH CHECK"
else
    fail "LEAK: Techvein wrote into ABC School's hiring team - WITH CHECK is missing"
fi

# As postgres (bypasses RLS): only the composite FK can refuse an ABC School
# person on Techvein's team.
out=$(run_as postgres "INSERT INTO hire.team_members (tenant_id, user_id, role)
                       VALUES ('$TECHVEIN','$S_USER','recruiter');" 2>&1)
if [ -z "$S_USER" ]; then fail "no ABC School person to test the team foreign key with"
elif printf '%s' "$out" | grep -qi 'foreign key'; then pass "Techvein's team cannot contain an ABC School person, even bypassing RLS"
else fail "LEAK: an ABC School person was put on Techvein's hiring team"; fi

run_as postgres "DELETE FROM hire.team_members WHERE user_id IN ('$T_USER','$S_USER');" >/dev/null 2>&1

hdr "Hire careers sites are isolated, and the public resolver fails closed"

run_as postgres "
    INSERT INTO hire.careers_sites (tenant_id, slug, display_name, erasure_contact, is_enabled) VALUES
        ('$TECHVEIN','iso-careers-t','iso-careers-t','p@t.example',true),
        ('$SCHOOL','iso-careers-s','iso-careers-s','p@s.example',true)
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1

own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.careers_sites WHERE slug = 'iso-careers-t'")
[ "${own:-0}" -eq 1 ] && pass "Techvein sees its own careers site" \
                      || fail "Techvein cannot see its own careers site (got '${own}') - fixture or RLS too strict"
leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM hire.careers_sites WHERE tenant_id = '$SCHOOL'")
[ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School's careers site" \
                       || fail "LEAK: ABC School's careers site visible to Techvein"
n=$(no_context "SELECT count(*) FROM hire.careers_sites")
[ "${n:-1}" -eq 0 ] && pass "no tenant context returns zero careers sites" \
                    || fail "DANGEROUS: ${n} careers site(s) visible with no tenant set"

# The resolver is how a stranger reaches a tenant. With the platform switch
# as the migration leaves it (off), it must answer nothing even for an
# enabled site.
sw=$(scalar_as postgres "SELECT coalesce((SELECT value FROM core.platform_settings WHERE key='hire.careers_portal_enabled'),'(missing)')")
[ "$sw" = "false" ] && pass "the platform switch is off as installed" \
                    || fail "the platform switch reads '$sw' - it must be installed as false"
r=$(no_context "SELECT count(*) FROM hire.resolve_careers_site('iso-careers-t')")
[ "${r:-1}" -eq 0 ] && pass "the public resolver answers nothing while the platform switch is off" \
                    || fail "DANGEROUS: the careers resolver answered with the platform switch off"

run_as postgres "DELETE FROM hire.careers_sites WHERE slug IN ('iso-careers-t','iso-careers-s');" >/dev/null 2>&1

hdr "SECURITY DEFINER functions cannot be hijacked through their search path"

# Mr. Singh, 24 Sept 2026 (PR 275): a SECURITY DEFINER function runs with its
# owner's rights and past row-level security; with a mutable search_path,
# anyone who can create an object in a schema on that path can have their
# code run with those rights. Two things make that impossible, and both are
# checked across EVERY such function, not only the careers resolver:
#   1. every SECURITY DEFINER function pins search_path;
#   2. no application role can CREATE in any schema — so there is nowhere to
#      plant a lookalike even if a path were wrong.
# Audited by hand the same day: 43 functions, all pinned; eight Connect
# functions omit pg_temp, but every table they name is schema-qualified, so a
# temporary table has nothing to shadow (reported to Mr. Singh as hygiene).
n=$(scalar_as postgres "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
                           AND NOT coalesce(array_to_string(p.proconfig, ';'), '') ~ 'search_path='")
total=$(scalar_as postgres "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')")
[ "${total:-0}" -ge 10 ] && [ "${n:-1}" -eq 0 ] \
    && pass "all ${total} SECURITY DEFINER functions pin their search_path" \
    || fail "DANGEROUS: ${n:-?} of ${total:-?} SECURITY DEFINER function(s) have no pinned search_path"

c=$(scalar_as postgres "SELECT count(*) FROM pg_namespace n CROSS JOIN pg_roles r
                         WHERE r.rolname IN ('tatvaos_app','tatvaos_mailedge')
                           AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
                           AND has_schema_privilege(r.oid, n.oid, 'CREATE')")
pub=$(scalar_as postgres "SELECT count(*) FROM pg_namespace n
                           WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
                             AND has_schema_privilege('public', n.oid, 'CREATE')")
[ "${c:-1}" -eq 0 ] && [ "${pub:-1}" -eq 0 ] \
    && pass "no application role (and not PUBLIC) can create objects in any schema" \
    || fail "DANGEROUS: application roles can CREATE in ${c:-?} schema(s), PUBLIC in ${pub:-?}"

path=$(scalar_as postgres "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'hire.resolve_careers_site(text)'::regprocedure")
[ "$path" = "search_path=pg_catalog,hire,core,pg_temp" ] \
    && pass "the public careers resolver searches pg_catalog first and pg_temp last" \
    || fail "the careers resolver's path is '$path'"

hdr "Connect's definer functions: pinned, not PUBLIC, and the attendee lists stay in their organisation (0007 review)"

# The 28 Sept review (docs/decisions/0007-tenantless-paths.md section 3).
# 20260928-d-connect-definer-review.sql pins every connect definer to
# pg_catalog first and pg_temp last and revokes PUBLIC; asserted here for
# EVERY connect definer, so a new one that skips the pattern fails this suite.
total=$(scalar_as postgres "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname = 'connect' AND p.prosecdef")
bad=$(scalar_as postgres "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'connect' AND p.prosecdef
                             AND NOT coalesce(array_to_string(p.proconfig, ';'), '') ~ '^search_path=pg_catalog,.*pg_temp$'")
[ "${total:-0}" -ge 20 ] && [ "${bad:-1}" -eq 0 ]     && pass "all ${total} connect definers search pg_catalog first and pg_temp last"     || fail "${bad:-?} of ${total:-?} connect definer(s) do not search pg_catalog first and pg_temp last"
pub=$(scalar_as postgres "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'connect' AND p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')")
[ "${pub:-1}" -eq 0 ] && pass "no connect definer is executable by PUBLIC"                       || fail "DANGEROUS: ${pub} connect definer(s) are executable by PUBLIC"

# The attendee list (emails and names) for a School meeting, asked for from
# Techvein, must be empty; asked for from the School, it must not be - or the
# empty answer proves nothing.
MM=$(scalar_as postgres "WITH x AS (INSERT INTO connect.meetings (tenant_id, code, title, kind, status)
        VALUES ('$SCHOOL', 'iso-min-$$', 'iso-min', 'instant', 'ended') RETURNING id) SELECT id FROM x")
run_as postgres "INSERT INTO connect.participants (meeting_id, user_id, identity, display_name, role, is_guest, first_joined_at)
    SELECT '$MM', u.id, 'iso-min-p', 'iso-min', 'participant', false, now()
      FROM core.users u WHERE u.tenant_id = '$SCHOOL' AND u.email <> '' AND u.status = 'active' LIMIT 1;" >/dev/null 2>&1
# And one guest - unreachable by email - so the School's unreachable count is 1
# and Techvein's 0 means something (without it both are 0 whatever the guard).
run_as postgres "INSERT INTO connect.participants (meeting_id, identity, display_name, role, is_guest, first_joined_at)
    VALUES ('$MM', 'iso-min-g', 'iso-min-guest', 'participant', true, now());" >/dev/null 2>&1
own=$(as_tenant "$SCHOOL" "SELECT count(*) FROM connect.minutes_recipients('$MM')")
[ "${own:-0}" -ge 1 ] && pass "minutes_recipients: the School sees its own meeting's attendee"                       || fail "minutes_recipients returned '${own}' to the School for its own meeting - fixture or function broken"
leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM connect.minutes_recipients('$MM')")
[ "${leak:-1}" -eq 0 ] && pass "minutes_recipients: Techvein gets none of a School meeting's attendees"                        || fail "LEAK: minutes_recipients gave Techvein ${leak} School attendee(s)"
n=$(no_context "SELECT count(*) FROM connect.minutes_recipients('$MM')")
[ "${n:-1}" -eq 0 ] && pass "minutes_recipients: no tenant context returns none"                     || fail "DANGEROUS: minutes_recipients returned ${n} attendee(s) with no tenant set"
ocnt=$(as_tenant "$SCHOOL" "SELECT connect.minutes_unreachable('$MM')")
[ "${ocnt:-0}" = "1" ] && pass "minutes_unreachable: the School counts its own guest (1)"                        || fail "minutes_unreachable gave the School '${ocnt}' for its own meeting - fixture or function broken"
cnt=$(as_tenant "$TECHVEIN" "SELECT connect.minutes_unreachable('$MM')")
[ "${cnt:-1}" = "0" ] && pass "minutes_unreachable: Techvein's count for a School meeting is 0"                       || fail "LEAK: minutes_unreachable gave Techvein '${cnt}' for a School meeting"
run_as postgres "DELETE FROM connect.meetings WHERE id = '$MM';" >/dev/null 2>&1

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

hdr "OpenID Connect provider tables are isolated; the two resolvers reach one row each"
# Decision 0004, option (b): the four provider tables are FORCE RLS like every
# other table, and only the client-by-id and token-by-hash lookups go through
# SECURITY DEFINER resolvers. Rows for both tenants, then: neither tenant sees
# the other's; no context sees nothing; the resolvers answer with the right
# tenant and nothing else; a revoked client is reported as such.
run_as postgres "
    INSERT INTO core.oidc_applications (id, tenant_id, client_id, client_type, display_name)
    VALUES ('0a000000-0000-0000-0000-00000000000a','$TECHVEIN','tos_iso_techvein','confidential','iso-techvein'),
           ('0b000000-0000-0000-0000-00000000000b','$SCHOOL','tos_iso_school','confidential','iso-school'),
           ('0c000000-0000-0000-0000-00000000000c','$SCHOOL','tos_iso_school_revoked','confidential','iso-school-revoked')
    ON CONFLICT (id) DO NOTHING;
    UPDATE core.oidc_applications SET revoked_at = now() WHERE id = '0c000000-0000-0000-0000-00000000000c';
    INSERT INTO core.oidc_authorizations (id, tenant_id, application_id, subject, status, type)
    VALUES ('0a000000-0000-0000-0000-0000000000aa','$TECHVEIN','0a000000-0000-0000-0000-00000000000a','user-t','valid','permanent'),
           ('0b000000-0000-0000-0000-0000000000bb','$SCHOOL','0b000000-0000-0000-0000-00000000000b','user-s','valid','permanent')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO core.oidc_tokens (id, tenant_id, application_id, authorization_id, reference_id, subject, status, type)
    VALUES ('0a000000-0000-0000-0000-000000000aaa','$TECHVEIN','0a000000-0000-0000-0000-00000000000a','0a000000-0000-0000-0000-0000000000aa','isohash_techvein','user-t','valid','access_token'),
           ('0b000000-0000-0000-0000-000000000bbb','$SCHOOL','0b000000-0000-0000-0000-00000000000b','0b000000-0000-0000-0000-0000000000bb','isohash_school','user-s','valid','access_token')
    ON CONFLICT (id) DO NOTHING;
" >/dev/null 2>&1

for tbl in core.oidc_applications core.oidc_authorizations core.oidc_tokens; do
    leak=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM $tbl WHERE tenant_id = '$SCHOOL'")
    [ "${leak:-1}" -eq 0 ] && pass "Techvein cannot see ABC School rows in $tbl" || fail "LEAK: Techvein sees $leak ABC School row(s) in $tbl"
    leak=$(as_tenant "$SCHOOL" "SELECT count(*) FROM $tbl WHERE tenant_id = '$TECHVEIN'")
    [ "${leak:-1}" -eq 0 ] && pass "ABC School cannot see Techvein rows in $tbl" || fail "LEAK: ABC School sees $leak Techvein row(s) in $tbl"
    own=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM $tbl WHERE tenant_id = '$TECHVEIN'")
    [ "${own:-0}" -ge 1 ] && pass "Techvein sees its own rows in $tbl ($own)" || fail "Techvein sees nothing in $tbl - RLS too strict"
    n=$(no_context "SELECT count(*) FROM $tbl")
    [ "${n:-1}" -eq 0 ] && pass "no tenant context: zero rows in $tbl" || fail "DANGEROUS: $n row(s) in $tbl with no tenant set"
done

# The resolvers work with NO tenant set (that is their whole purpose) and
# answer only the row for the key presented.
r=$(no_context "SELECT tenant_id::text FROM core.resolve_oidc_client('tos_iso_school')")
[ "$r" = "$SCHOOL" ] && pass "resolve_oidc_client names the owning tenant with no context set" || fail "resolve_oidc_client answered '$r' for a school client"
r=$(no_context "SELECT was_revoked::text FROM core.resolve_oidc_client('tos_iso_school_revoked')")
[ "$r" = "true" ] && pass "resolve_oidc_client reports a revoked client as revoked" || fail "resolve_oidc_client says '$r' for a revoked client"
r=$(no_context "SELECT count(*) FROM core.resolve_oidc_client('tos_iso_nobody')")
[ "${r:-1}" -eq 0 ] && pass "resolve_oidc_client answers nothing for an unknown client id" || fail "resolve_oidc_client answered $r row(s) for an unknown id"
r=$(no_context "SELECT tenant_id::text FROM core.resolve_oidc_token('isohash_techvein')")
[ "$r" = "$TECHVEIN" ] && pass "resolve_oidc_token names the owning tenant from the hash" || fail "resolve_oidc_token answered '$r'"
# and the resolver is a key, not a window: it cannot be asked for "all rows"
r=$(no_context "SELECT count(*) FROM core.resolve_oidc_token('')")
[ "${r:-1}" -eq 0 ] && pass "resolve_oidc_token answers nothing for an empty hash" || fail "resolve_oidc_token answered $r row(s) for ''"

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
hdr "AI usage is private to each organisation"

# The metering record (20260924-ai-usage.sql): what an organisation spent on
# AI, per person and feature — commercially private. One fixture row per
# tenant, inserted as postgres and removed at the end.
run_as postgres "
    INSERT INTO core.ai_usage (tenant_id, feature, outcome, tokens_in, tokens_out)
    VALUES ('$TECHVEIN', 'isolation.fixture', 'ok', 1, 1), ('$SCHOOL', 'isolation.fixture', 'ok', 1, 1);
" >/dev/null 2>&1
n=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.ai_usage WHERE feature = 'isolation.fixture'")
[ "${n:-0}" -eq 1 ] && pass "an organisation sees exactly its own AI usage"                    || fail "an organisation sees ${n:-?} fixture usage rows (want exactly its own 1)"
n=$(as_tenant "$TECHVEIN" "SELECT count(*) FROM core.ai_usage WHERE tenant_id = '$SCHOOL'")
[ "${n:-1}" -eq 0 ] && pass "another organisation's AI usage is invisible"                     || fail "LEAK: another tenant's AI usage visible ($n rows)"
n=$(no_context "SELECT count(*) FROM core.ai_usage")
[ "${n:-1}" -eq 0 ] && pass "no context sees no AI usage"                     || fail "DANGEROUS: ${n} AI usage row(s) visible with no tenant set"
run_as postgres "DELETE FROM core.ai_usage WHERE feature = 'isolation.fixture';" >/dev/null 2>&1

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
    "DELETE FROM family.contact_audit_logs WHERE false"     "DELETE FROM core.ai_usage WHERE false"     "UPDATE core.ai_usage SET tokens_in = tokens_in WHERE false"     "DELETE FROM core.ai_usage_alerts WHERE false"
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
    "UPDATE mail.app_passwords SET revoked_at = revoked_at WHERE false"     "INSERT INTO core.ai_usage (tenant_id, feature, outcome) SELECT tenant_id, feature, outcome FROM core.ai_usage WHERE false"
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
