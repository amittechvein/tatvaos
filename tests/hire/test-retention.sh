#!/usr/bin/env bash
# TatvaOS Hire — automatic deletion of candidates past their retention period.
#
# Amit, 24 Sept 2026: six months after the decision by default, shorter if an
# organisation chooses (30..180 days), longer only with the candidate's
# recorded consent. hire.sweep_expired_candidates() does it; this proves WHO
# it takes and who it leaves, one day either side of each line:
#
#   A  rejected 181 days ago                         -> erased
#   B  rejected 179 days ago                         -> kept
#   C  rejected 300 days ago, another app ACTIVE     -> kept
#   D  withdrawn 200 days ago, consent until +30 d   -> kept
#   E  withdrawn 200 days ago, consent ran out       -> erased
#   F  never put forward, untouched 181 days         -> erased
#   G  never put forward, touched 10 days ago        -> kept
#   H  ABC School (30 d, applied by the sweep), 31 d -> erased
#   I  ABC School (30 d, applied by the sweep), 29 d -> kept
#   B2 Techvein asked for 30 d, 7 days NOT up, 60 d  -> kept
#   G2 last edited 181 d ago, system touch today     -> erased
#
# Mr. Singh, 24 Sept 2026 added: a shorter period waits seven days and the
# sweep applies it only once due (and logs that); the preview counts exactly
# who a shortening would delete, inside the tenant; the clock for someone
# never put forward is last_edited_at, which a system touch does not move;
# the sweep's log carries how many, under which period, set by whom and when.
#
# ...then that the erasure took their applications and history, that the audit
# log says HOW MANY and never who, that a second run takes nobody, that the
# database refuses the states the sweep relies on never existing, and that
# NOTHING of this test is left behind (a stage it left once broke the next
# test on the same database).
#
# CALIBRATED 24 Sept: sweep ignoring consent and the organisation's period ->
# D and H wrong; due rule on updated_at -> F and G2 wrongly kept; pending
# never applied -> H kept and nothing logged. Each restored -> 40/0.
#
# Runs the sweep as tatvaos_app with NO tenant — exactly how
# HireRetentionWorker calls it. Takes TATVAOS_PSQL / TATVAOS_PSQL_APP like the
# other tests, and TATVAOS_PGDATABASE (default tatvaos_mail).
# ---------------------------------------------------------------------------
set -uo pipefail
DB="${TATVAOS_PGDATABASE:-tatvaos_mail}"
T='11111111-1111-1111-1111-111111111111'   # Techvein: default period, 180 d
S='22222222-2222-2222-2222-222222222222'   # ABC School: period set to 30 d
RUN=$(date +%s)

WSL_KEEPALIVE=""
if [ -z "${TATVAOS_PSQL:-}" ]; then
    if command -v wsl >/dev/null 2>&1; then
        wsl -e sleep 600 >/dev/null 2>&1 &
        WSL_KEEPALIVE=$!
        sleep 2
        TATVAOS_PSQL="wsl -u postgres -e psql -d $DB -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-wsl -e psql postgresql://tatvaos_app:dev_app_pw@localhost/$DB -Atc}"
    else
        TATVAOS_PSQL="docker exec tv-postgres psql -U postgres -d $DB -Atc"
        TATVAOS_PSQL_APP="${TATVAOS_PSQL_APP:-docker exec tv-postgres psql -U tatvaos_app -d $DB -Atc}"
    fi
fi
trap '[ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1' EXIT

PG()    { $TATVAOS_PSQL "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }
PGRAW() { $TATVAOS_PSQL "$1" 2>&1 | grep -v "^wsl:"; }
PGAPP() { $TATVAOS_PSQL_APP "$1" 2>/dev/null | grep -v "^wsl:" | tail -n1; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  ✗ %s\n' "$1"; }
# An empty operand is a failure, never a match (testing-false-greens).
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 — nothing to compare (got '$2', wanted '$3')"
    elif [ "$2" = "$3" ]; then pass "$1"
    else fail "$1 — got '$2', wanted '$3'"; fi
}

printf '\n>> 0. Fixtures (run %s)\n' "$RUN"
[ -n "$(PG 'SELECT 1')" ] || { fail "psql does not answer"; exit 1; }

# One stage and one job per organisation, then candidates with back-dated
# decisions. Everything is named ret-$RUN-* so it can be found and removed.
# Mr. Singh, 24 Sept: a shorter period waits seven days. ABC School asked for
# 30 days eight days ago, so its wait is over and the sweep must apply it
# before judging anyone. Techvein asked for 30 days today, so its wait is NOT
# over and its candidates are still judged at 180.
PG "INSERT INTO hire.settings (tenant_id, retention_days, pending_retention_days, pending_effective_at, pending_requested_at)
    VALUES ('$S', 180, 30, now() - interval '1 day', now() - interval '8 days')
    ON CONFLICT (tenant_id) DO UPDATE SET retention_days = 180, pending_retention_days = 30,
        pending_effective_at = now() - interval '1 day', pending_requested_at = now() - interval '8 days'" >/dev/null
PG "INSERT INTO hire.settings (tenant_id, retention_days, pending_retention_days, pending_effective_at, pending_requested_at)
    VALUES ('$T', 180, 30, now() + interval '6 days', now() - interval '1 day')
    ON CONFLICT (tenant_id) DO UPDATE SET retention_days = 180, pending_retention_days = 30,
        pending_effective_at = now() + interval '6 days', pending_requested_at = now() - interval '1 day',
        updated_by = NULL" >/dev/null
# updated_by NULL: Techvein's 180 is the untouched DEFAULT here. Without this,
# a row left by test-job-openings (an admin explicitly choosing 180) made the
# sweep's log say 'organisation' — correct for that state, wrong fixture.
fixture() {   # tenant key label outcome decided_days_ago(or '') consent_until(or '')
    local tenant=$1 key=$2 outcome=$3 days=$4 consent=$5
    local stage job cand until_sql consent_sql
    # Spelled out, not ${consent:-NULL}: that expands to the VALUE when it is
    # set, and the first run built "current_date + (30)30" — two fixtures were
    # never created and the checks on them failed with nothing to compare.
    if [ -n "$consent" ]; then until_sql="current_date + ($consent)"; consent_sql="now()"
    else until_sql="NULL"; consent_sql="NULL"; fi
    stage=$(PG "SELECT id FROM hire.pipeline_stages WHERE tenant_id='$tenant' AND key='ret_stage'")
    [ -z "$stage" ] && stage=$(PG "WITH i AS (INSERT INTO hire.pipeline_stages (tenant_id, key, name, position) VALUES ('$tenant','ret_stage','ret',999) RETURNING id) SELECT id FROM i")
    job=$(PG "SELECT id FROM hire.job_openings WHERE tenant_id='$tenant' AND title='ret-$RUN-job'")
    [ -z "$job" ] && job=$(PG "WITH i AS (INSERT INTO hire.job_openings (tenant_id, title) VALUES ('$tenant','ret-$RUN-job') RETURNING id) SELECT id FROM i")
    # last_edited_at is the clock; updated_at is set to NOW on every fixture,
    # as if a maintenance job had just touched the row — which must not
    # restart anyone's retention (Mr. Singh, 24 Sept).
    cand=$(PG "WITH i AS (INSERT INTO hire.candidates (tenant_id, full_name, email, talent_pool_until, talent_pool_consent_at, last_edited_at, updated_at)
               VALUES ('$tenant','ret-$RUN-$key','ret-$RUN-$key@example.test',
                       $until_sql, $consent_sql,
                       now() - interval '${6:-0} days', now()) RETURNING id) SELECT id FROM i")
    if [ "$outcome" != "none" ]; then
        PG "INSERT INTO hire.applications (tenant_id, candidate_id, job_id, stage_id, outcome, rejection_reason, decided_at)
            VALUES ('$tenant','$cand','$job','$stage','$outcome',
                    CASE WHEN '$outcome'='rejected' THEN 'retention test' END,
                    CASE WHEN '$outcome'='active' THEN NULL ELSE now() - interval '$days days' END)" >/dev/null
        PG "INSERT INTO hire.application_events (tenant_id, application_id, kind, reason)
            SELECT '$tenant', id, 'created', 'ret-$RUN-event' FROM hire.applications WHERE candidate_id='$cand'" >/dev/null
    fi
    printf '%s' "$cand"
}
A=$(fixture "$T" A rejected 181 '')
B=$(fixture "$T" B rejected 179 '')
C=$(fixture "$T" C rejected 300 '')
# C's second application, to a second job, still active.
C_JOB2=$(PG "WITH i AS (INSERT INTO hire.job_openings (tenant_id, title) VALUES ('$T','ret-$RUN-job2') RETURNING id) SELECT id FROM i")
PG "INSERT INTO hire.applications (tenant_id, candidate_id, job_id, stage_id)
    SELECT '$T','$C','$C_JOB2', id FROM hire.pipeline_stages WHERE tenant_id='$T' AND key='ret_stage'" >/dev/null
D=$(fixture "$T" D withdrawn 200 30)
E=$(fixture "$T" E withdrawn 200 -1)
F=$(fixture "$T" F none '' '' 181)
G=$(fixture "$T" G none '' '' 10)
H=$(fixture "$S" H rejected 31 '')
I=$(fixture "$S" I rejected 29 '')
# Techvein asked for 30 days, but its seven days are not up: someone rejected
# 60 days ago is still under 180 and must stay.
B2=$(fixture "$T" B2 rejected 60 '')
# Never put forward, last edited by a person 181 days ago; then a system job
# touches the row today (updated_at, and a no-op column write). Still due.
G2=$(fixture "$T" G2 none '' '' 181)
PG "UPDATE hire.candidates SET updated_at = now(), skills = skills WHERE id = '$G2'" >/dev/null
n=$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")
same "eleven candidates in place" "$n" "11"
same "G2's row was touched today, its last edit was not" \
    "$(PG "SELECT (updated_at > now() - interval '1 minute' AND last_edited_at < now() - interval '180 days')::text FROM hire.candidates WHERE id='$G2'")" "true"

printf '\n>> 0b. What a shorter period would delete, asked before it is saved\n'
# As the app inside Techvein: the preview the settings page shows. At the
# date a 30-day period would start (seven days on), it deletes B2 (60 d)
# that 180 days would keep. B (179 d) is NOT counted: seven days on it is
# past 180 anyway — the first version of this check expected it, wrongly.
# A, E, F, G2 are due under 180 already and not counted either.
impact=$(PGAPP "SET app.tenant_id = '$T';
    SELECT string_agg(d.id::text, ',' ORDER BY d.id) FROM hire.due_candidates(now() + interval '7 days', 30) d
     WHERE NOT EXISTS (SELECT 1 FROM hire.due_candidates(now() + interval '7 days', NULL) x WHERE x.id = d.id)
       AND d.id IN ('$A','$B','$B2','$C','$D','$E','$F','$G','$G2')")
same "the preview names exactly B2" "$impact" "$B2"
same "and cannot see ABC School's candidates at all" \
    "$(PGAPP "SET app.tenant_id = '$T'; SELECT count(*) FROM hire.due_candidates(now() + interval '365 days', 30) WHERE tenant_id = '$S'")" "0"
same "C really has an active application" "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id='$C' AND outcome='active'")" "1"
same "F really has no application" "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id='$F'")" "0"
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")

printf '\n>> 0c. Switched off, the sweep deletes nobody\n'
# Mr. Singh, 2 Oct 2026: #271 merges, but the sweep stays OFF until a lawyer
# has confirmed the periods - platform setting hire.retention_sweep_enabled,
# installed 'false'. Off, the sweep must answer NULL ("did not run", which
# the worker logs as OFF) and erase nobody, although five of these fixtures
# are due. Anything but the exact text 'true' is off: 'TRUE' is tried too.
# The setting is put back as found on exit, whatever happens.
ORIG_SW=$(PG "SELECT coalesce((SELECT value FROM core.platform_settings WHERE key='hire.retention_sweep_enabled'),'(missing)')")
[ "$ORIG_SW" = "false" ] || [ "$ORIG_SW" = "true" ] \
    && pass "the switch is installed (reads '$ORIG_SW')" \
    || fail "the switch reads '$ORIG_SW' - the migration should have installed it as 'false'"
restore_switch() {
    case "$ORIG_SW" in
        true|false) PG "UPDATE core.platform_settings SET value='$ORIG_SW' WHERE key='hire.retention_sweep_enabled'" >/dev/null ;;
    esac
}
trap 'restore_switch; [ -n "$WSL_KEEPALIVE" ] && kill "$WSL_KEEPALIVE" >/dev/null 2>&1' EXIT
ours="'$A','$B','$B2','$C','$D','$E','$F','$G','$G2','$H','$I'"
for off in false TRUE; do
    PG "UPDATE core.platform_settings SET value='$off' WHERE key='hire.retention_sweep_enabled'" >/dev/null
    same "with the switch at '$off', the sweep answers NULL (did not run)" \
        "$(PGAPP "SELECT (hire.sweep_expired_candidates() IS NULL)::text")" "true"
    same "and all eleven fixtures are still there, the five due ones included" \
        "$(PG "SELECT count(*) FROM hire.candidates WHERE id IN ($ours)")" "11"
done
same "no erasure was logged while it was off" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE id > $FLOOR AND action='candidate.retention_erased'")" "0"
# Applying a period an administrator chose seven days ago deletes nobody, so
# it runs while the sweep is off - otherwise the Settings page's dates lie.
same "ABC School's due shortening was applied all the same" \
    "$(PG "SELECT retention_days||'/'||coalesce(pending_retention_days::text,'none') FROM hire.settings WHERE tenant_id='$S'")" "30/none"
PG "UPDATE core.platform_settings SET value='true' WHERE key='hire.retention_sweep_enabled'" >/dev/null
same "switched on for the rest of this test" \
    "$(PG "SELECT value FROM core.platform_settings WHERE key='hire.retention_sweep_enabled'")" "true"

printf '\n>> 1. The sweep, as the app with no tenant\n'
# stderr kept: when the sweep itself errors, the database's own message is
# the only useful thing to print (the first run of this version printed '').
sweep_out=$($TATVAOS_PSQL_APP "SELECT hire.sweep_expired_candidates()" 2>&1 | grep -v "^wsl:")
erased=$(printf '%s\n' "$sweep_out" | tail -n1)
[ -n "$erased" ] && [ "$erased" -ge 5 ] 2>/dev/null && pass "the sweep ran and erased at least the five due ($erased)" \
    || fail "the sweep answered '$erased' — expected a count of at least 5. Database said: $(printf '%s' "$sweep_out" | head -c 300)"

gone()  { same "$1 is erased"  "$(PG "SELECT count(*) FROM hire.candidates WHERE id='$2'")" "0"; }
kept()  { same "$1 is kept"    "$(PG "SELECT count(*) FROM hire.candidates WHERE id='$2'")" "1"; }
gone "A (rejected 181 days ago)" "$A"
kept "B (rejected 179 days ago)" "$B"
kept "C (old rejection, but another application active)" "$C"
kept "D (withdrawn 200 days ago, consent until next month)" "$D"
gone "E (withdrawn 200 days ago, consent ran out yesterday)" "$E"
gone "F (never put forward, untouched 181 days)" "$F"
kept "G (never put forward, touched 10 days ago)" "$G"
gone "H (ABC School, 30-day period, rejected 31 days ago)" "$H"
kept "I (ABC School, 30-day period, rejected 29 days ago)" "$I"
kept "B2 (Techvein's shortening still waiting, rejected 60 days ago)" "$B2"
gone "G2 (last edited 181 days ago; a system touch today does not save them)" "$G2"

printf '\n>> 1b. The waiting shortenings\n'
same "ABC School's, seven days up, now applies" \
    "$(PG "SELECT retention_days||'/'||coalesce(pending_retention_days::text,'none') FROM hire.settings WHERE tenant_id='$S'")" "30/none"
same "and was logged: 180 -> 30, applied by the sweep" \
    "$(PG "SELECT (before_state->>'retentionDays')||'->'||(after_state->>'retentionDays') FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$S' AND action='hire_settings.retention_applied'")" "180->30"
same "Techvein's, not yet due, still waits" \
    "$(PG "SELECT retention_days||'/'||coalesce(pending_retention_days::text,'none') FROM hire.settings WHERE tenant_id='$T'")" "180/30"

printf '\n>> 2. Everything about an erased candidate went with them\n'
same "no application left for A, E or H" \
    "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id IN ('$A','$E','$H')")" "0"
same "no history left for them" \
    "$(PG "SELECT count(*) FROM hire.application_events e WHERE e.reason='ret-$RUN-event' AND NOT EXISTS (SELECT 1 FROM hire.applications a WHERE a.id=e.application_id)")" "0"
same "the kept candidates' history is untouched (B, C, D, I)" \
    "$(PG "SELECT count(*) FROM hire.application_events e JOIN hire.applications a ON a.id=e.application_id WHERE a.candidate_id IN ('$B','$C','$D','$I') AND e.reason='ret-$RUN-event'")" "4"

printf '\n>> 3. The audit log says how many, never who\n'
# Mr. Singh, 24 Sept: log the EVENT — how many, when, under which period, set
# by whom — so "what became of my application" has an answer.
same "one row for Techvein: four erased, under the 180-day default" \
    "$(PG "SELECT (after_state->>'erased')||'/'||(after_state->>'retentionDays')||'/'||(after_state->>'policy') FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$T' AND action='candidate.retention_erased'")" "4/180/default"
same "one row for ABC School: one erased, under its own 30 days" \
    "$(PG "SELECT (after_state->>'erased')||'/'||(after_state->>'retentionDays')||'/'||(after_state->>'policy') FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$S' AND action='candidate.retention_erased'")" "1/30/organisation"
same "and it says when the period was set" \
    "$(PG "SELECT (after_state->>'periodSetAt' IS NOT NULL)::text FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$S' AND action='candidate.retention_erased'")" "true"
same "no audit row written by the sweep names anyone" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE id > $FLOOR AND (coalesce(before_state::text,'')||coalesce(after_state::text,'')||coalesce(target_id,'')) ~* 'ret-$RUN|@example'")" "0"

printf '\n>> 4. A second run takes nobody new\n'
before=$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")
again=$(PGAPP "SELECT hire.sweep_expired_candidates()")
same "the survivors are all still there" "$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")" "$before"
same "and the second run erased nothing of ours (it answered $again)" \
    "$(PG "SELECT count(*) FROM hire.candidates WHERE id IN ('$B','$B2','$C','$D','$G','$I')")" "6"

printf '\n>> 5. The database refuses what the sweep relies on never existing\n'
refused() {  # label sql constraint
    local out; out=$(PGRAW "$2")
    printf '%s' "$out" | grep -q "$3" && pass "$1" || fail "$1 — not refused by $3: $(printf '%s' "$out" | head -c 160)"
}
refused "a rejected application with no decision date" \
    "UPDATE hire.applications SET decided_at = NULL WHERE candidate_id='$B'" "ck_application_decided_at"
refused "an active application with a decision date" \
    "UPDATE hire.applications SET decided_at = now() WHERE candidate_id='$C' AND outcome='active'" "ck_application_decided_at"
refused "a talent-pool date with no recorded consent" \
    "UPDATE hire.candidates SET talent_pool_consent_at = NULL WHERE id='$D'" "ck_candidate_talent_pool_consent"
refused "a retention period longer than 180 days" \
    "UPDATE hire.settings SET retention_days = 181 WHERE tenant_id='$S'" "retention_days_check"
refused "a retention period shorter than 30 days" \
    "UPDATE hire.settings SET retention_days = 29 WHERE tenant_id='$S'" "retention_days_check"
refused "a 'pending' change that lengthens (only shortening waits)" \
    "UPDATE hire.settings SET pending_retention_days = 190 WHERE tenant_id='$T'" "ck_settings_pending_shorter"
refused "a pending change without its date" \
    "UPDATE hire.settings SET pending_effective_at = NULL WHERE tenant_id='$T'" "ck_settings_pending_whole"
same "the app cannot read another organisation's settings" \
    "$(PGAPP "SET app.tenant_id = '$T'; SELECT count(*) FROM hire.settings WHERE tenant_id = '$S'")" "0"

printf '\n>> Clean up\n'
PG "DELETE FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'" >/dev/null
PG "DELETE FROM hire.job_openings WHERE title LIKE 'ret-$RUN-%'" >/dev/null
PG "DELETE FROM hire.settings WHERE tenant_id IN ('$S', '$T')" >/dev/null
# The stage too. The first version left it: the organisation's pipeline then
# held one stage, so the default twelve were never created, and the next test
# on the same database (test-job-openings step 14) failed for a reason that
# had nothing to do with it. Cross-test pollution; now removed and checked.
PG "DELETE FROM hire.pipeline_stages WHERE key = 'ret_stage'" >/dev/null
same "fixtures removed" "$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")" "0"
same "nothing of this test left behind (stages, jobs, settings)" \
    "$(PG "SELECT (SELECT count(*) FROM hire.pipeline_stages WHERE key='ret_stage') + (SELECT count(*) FROM hire.job_openings WHERE title LIKE 'ret-$RUN-%') + (SELECT count(*) FROM hire.settings WHERE tenant_id IN ('$S','$T'))")" "0"

restore_switch
same "the switch is back as found ('$ORIG_SW')" \
    "$(PG "SELECT value FROM core.platform_settings WHERE key='hire.retention_sweep_enabled'")" "$ORIG_SW"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
