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
#   H  ABC School (period 30 d), rejected 31 d ago   -> erased
#   I  ABC School (period 30 d), rejected 29 d ago   -> kept
#
# ...then that the erasure took their applications and history, that the audit
# log says HOW MANY and never who, that a second run takes nobody, and that the
# database refuses the states the sweep relies on never existing.
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
PG "INSERT INTO hire.settings (tenant_id, retention_days) VALUES ('$S', 30)
    ON CONFLICT (tenant_id) DO UPDATE SET retention_days = 30" >/dev/null
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
    cand=$(PG "WITH i AS (INSERT INTO hire.candidates (tenant_id, full_name, email, talent_pool_until, talent_pool_consent_at, updated_at)
               VALUES ('$tenant','ret-$RUN-$key','ret-$RUN-$key@example.test',
                       $until_sql, $consent_sql,
                       now() - interval '${6:-0} days') RETURNING id) SELECT id FROM i")
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
n=$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")
same "nine candidates in place" "$n" "9"
same "C really has an active application" "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id='$C' AND outcome='active'")" "1"
same "F really has no application" "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id='$F'")" "0"
FLOOR=$(PG "SELECT coalesce(max(id),0) FROM core.audit_logs")

printf '\n>> 1. The sweep, as the app with no tenant\n'
erased=$(PGAPP "SELECT hire.sweep_expired_candidates()")
[ -n "$erased" ] && [ "$erased" -ge 4 ] 2>/dev/null && pass "the sweep ran and erased at least the four due ($erased)" \
    || fail "the sweep answered '$erased' — expected a count of at least 4"

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

printf '\n>> 2. Everything about an erased candidate went with them\n'
same "no application left for A, E or H" \
    "$(PG "SELECT count(*) FROM hire.applications WHERE candidate_id IN ('$A','$E','$H')")" "0"
same "no history left for them" \
    "$(PG "SELECT count(*) FROM hire.application_events e WHERE e.reason='ret-$RUN-event' AND NOT EXISTS (SELECT 1 FROM hire.applications a WHERE a.id=e.application_id)")" "0"
same "the kept candidates' history is untouched (B, C, D, I)" \
    "$(PG "SELECT count(*) FROM hire.application_events e JOIN hire.applications a ON a.id=e.application_id WHERE a.candidate_id IN ('$B','$C','$D','$I') AND e.reason='ret-$RUN-event'")" "4"

printf '\n>> 3. The audit log says how many, never who\n'
same "one row for Techvein, counting its three" \
    "$(PG "SELECT (after_state->>'erased') FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$T' AND action='candidate.retention_erased'")" "3"
same "one row for ABC School, counting its one" \
    "$(PG "SELECT (after_state->>'erased') FROM core.audit_logs WHERE id > $FLOOR AND tenant_id='$S' AND action='candidate.retention_erased'")" "1"
same "no audit row written by the sweep names anyone" \
    "$(PG "SELECT count(*) FROM core.audit_logs WHERE id > $FLOOR AND (coalesce(before_state::text,'')||coalesce(after_state::text,'')||coalesce(target_id,'')) ~* 'ret-$RUN|@example'")" "0"

printf '\n>> 4. A second run takes nobody new\n'
before=$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")
again=$(PGAPP "SELECT hire.sweep_expired_candidates()")
same "the survivors are all still there" "$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")" "$before"
same "and the second run erased nothing of ours (it answered $again)" \
    "$(PG "SELECT count(*) FROM hire.candidates WHERE id IN ('$B','$C','$D','$G','$I')")" "5"

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
same "the app cannot read another organisation's settings" \
    "$(PGAPP "SET app.tenant_id = '$T'; SELECT count(*) FROM hire.settings WHERE tenant_id = '$S'")" "0"

printf '\n>> Clean up\n'
PG "DELETE FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'" >/dev/null
PG "DELETE FROM hire.job_openings WHERE title LIKE 'ret-$RUN-%'" >/dev/null
PG "DELETE FROM hire.settings WHERE tenant_id = '$S'" >/dev/null
same "fixtures removed" "$(PG "SELECT count(*) FROM hire.candidates WHERE full_name LIKE 'ret-$RUN-%'")" "0"

printf '\n  passed: %d   failed: %d\n\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
