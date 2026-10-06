#!/usr/bin/env bash
#
# "Organisations unchanged", MEASURED (Mr. Singh on PR 313, 28 Sept 2026).
#
#   1. a database at main's schema holding the data under test
#      (MEASURE_DATA=seed: main's own seed files; or a SQL file: a copy of
#      production — see extract-production.sql)
#   2. BEFORE: main's code answers for every organisation user
#   3. PR 313's migrations applied the way deploy.sh applies them: every file
#      in local/postgres/init except the seeds, in name order
#   4. AFTER: PR 313's code answers for the same users, and the new
#      per-person path (EffectiveSettings) is checked against it
#   5. the count of users whose answer changed. It must be 0.
#   6. RED FIRST, two ways, on a scratch copy of the after-database:
#      a. a plan limit changed the way a careless migration would: the count
#         is no longer 0 (the measurement can see a customer's plan change)
#      b. a personal subscription row placed in an organisation, read by
#         main's code, which has no user_id filter: the count is no longer 0
#         (what the six filtered readers exist to prevent)
#
# Needs: .tmp/measure-before and .tmp/measure-after built (see the PR),
# .tmp/measure-main = a checkout of main; WSL Postgres (devpass).
#   bash tests/plans-measure/run.sh              # rehearsal on seed data
#   MEASURE_DATA=.tmp/prod-copy.sql bash tests/plans-measure/run.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ROOT=$(pwd)
DATA="${MEASURE_DATA:-seed}"
DB=tatvaos_measure
CONN="Host=localhost;Port=5432;Database=$DB;Username=postgres;Password=devpass"
WROOT=/mnt/c${ROOT#/c}
psqlw() { MSYS_NO_PATHCONV=1 wsl -e env PGPASSWORD=devpass psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
say() { printf '%s\n' "$*"; }
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf '  ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED+1)); printf '  ✗ %s\n' "$1"; }

apply_dir() { # dir, include-seeds(yes/no) — name order, as deploy.sh does.
    # ONE WSL call for the whole folder: a WSL launch per file exhausted the
    # laptop's memory (fork failures) on the first try.
    local dir="/mnt/c${1#/c}" seeds="$2"
    MSYS_NO_PATHCONV=1 wsl -e env PGPASSWORD=devpass DIR="$dir" SEEDS="$seeds" DB="$DB" bash -c '
        cd "$DIR" || exit 1
        for f in $(LC_ALL=C ls *.sql); do
            if [ "$SEEDS" = no ] && [[ "$f" == *seed* ]]; then continue; fi
            psql -h localhost -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f" >/dev/null 2>/tmp/measure-mig.err                 || { echo "migration $f FAILED:"; tail -3 /tmp/measure-mig.err; exit 1; }
        done'
}
measure() { # side db-name out-prefix
    local d="$1" out="$3"
    dotnet ".tmp/measure-$d/PlansMeasure.dll" "Host=localhost;Port=5432;Database=$2;Username=postgres;Password=devpass" "$out" 2>".tmp/measure-$d.err" | tr -d '\r'
}

say ">> 1. $DB at main's schema, data: $DATA"
psqlw -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0" >/dev/null
if [ "$DATA" = seed ]; then
    apply_dir "$ROOT/.tmp/measure-main/local/postgres/init" yes || exit 1
else
    apply_dir "$ROOT/.tmp/measure-main/local/postgres/init" no || exit 1
    psqlw -d "$DB" -f "/mnt/c$(cd "$(dirname "$DATA")" && pwd | sed 's#^/c##')/$(basename "$DATA")" >/dev/null || { say "loading $DATA failed"; exit 1; }
    # Every table arrived whole: the extract's manifest against the copy. A
    # table that failed to copy would otherwise measure as "no change".
    manifest=$(grep -m1 '^-- manifest ' "$DATA" | sed 's/^-- manifest //')
    [ -n "$manifest" ] || { fail "no manifest in $DATA"; exit 1; }
    bad=0
    for pair in $manifest; do
        t=${pair%%=*}; want=${pair#*=}
        got=$(psqlw -d "$DB" -Atc "SELECT count(*) FROM $t" | tr -d '\r')
        [ "$got" = "$want" ] || { fail "$t: $got rows loaded, production had $want"; bad=1; }
    done
    [ $bad = 0 ] && pass "every table loaded whole ($(printf '%s' "$manifest" | wc -w | tr -d ' ') tables, row counts equal to production's manifest)" || exit 1
fi
say "   $(psqlw -d "$DB" -Atc "SELECT count(*)||' organisations, '||(SELECT count(*) FROM core.users)||' users, '||(SELECT count(*) FROM core.subscriptions)||' subscriptions, '||(SELECT count(*) FROM core.plans)||' plans' FROM core.tenants" | tr -d '\r')"

say ">> 2. BEFORE (main's code)"
b=$(measure before $DB .tmp/m.before); say "   $b"
[ -s .tmp/m.before.users.tsv ] && pass "before: one line per organisation user" || { fail "before produced nothing: $(tail -3 .tmp/measure-before.err)"; exit 1; }

say ">> 3. PR 313's migrations, as deploy.sh applies them (no seeds)"
apply_dir "$ROOT/local/postgres/init" no || exit 1
pass "applied cleanly"

say ">> 4. AFTER (PR 313's code)"
a=$(measure after $DB .tmp/m.after); say "   $a"
[ -s .tmp/m.after.users.tsv ] && pass "after: one line per organisation user" || { fail "after produced nothing: $(tail -3 .tmp/measure-after.err)"; exit 1; }

say ">> 5. The count"
PY="${TATVAOS_PYTHON:-python}"
cmp_() { "$PY" tests/plans-measure/compare.py "$1" "$2" | tr -d '\r'; }
changed() { printf '%s' "$1" | sed -n 's/^changed_users=\([0-9]*\).*/\1/p'; }
out=$(cmp_ .tmp/m.before .tmp/m.after); printf '%s\n' "$out" | sed 's/^/   /'
nb=$(wc -l < .tmp/m.before.users.tsv | tr -d ' '); na=$(wc -l < .tmp/m.after.users.tsv | tr -d ' ')
[ "$nb" = "$na" ] && pass "the same $nb organisation users on both sides" || fail "user counts differ: $nb before, $na after"
[ "$(changed "$out")" = 0 ] && pass "ORGANISATION USERS WHOSE ANSWER CHANGED: 0 (plan, products, every existing feature's included/limit/source, AI credits, storage)" \
    || fail "organisation users whose answer changed: $(changed "$out")"
if printf '%s' "$out" | grep -q '^  added' && printf '%s' "$out" | grep '^  added' | grep -qv 'included=True limit=none'; then
    fail "a feature added by 313 reaches an organisation NOT included, or with a limit"
else pass "every feature 313 adds to the catalogue reaches organisations included, with no limit (listed above)"; fi
e=$(printf '%s' "$a" | sed -n 's/.*effective_differs=\([0-9]*\).*/\1/p')
[ "$e" = 0 ] && pass "the new per-person path agrees with the organisation's answer for every one (effective_differs=0)" || fail "effective_differs=$e: $(head -3 .tmp/measure-after.err)"

say ">> 6. RED FIRST: the measurement sees a change"
psqlw -d postgres -c "DROP DATABASE IF EXISTS ${DB}_red" -c "CREATE DATABASE ${DB}_red TEMPLATE $DB" >/dev/null 2>&1
# a. a customer's plan changed, as a careless migration would do: a limit on
#    the plan the newest organisation subscription uses, and keep-everything off.
psqlw -d ${DB}_red -c "INSERT INTO core.plan_feature_limits (plan_id, feature_code, limit_value)
    SELECT s.plan_id, 'mail.daily_recipients', 7 FROM core.subscriptions s
     WHERE s.user_id IS NULL AND s.status <> 'cancelled' ORDER BY s.started_at DESC LIMIT 1
    ON CONFLICT (plan_id, feature_code) DO UPDATE SET limit_value = EXCLUDED.limit_value + 1;
    UPDATE core.tenants SET keeps_everything = false" >/dev/null 2>.tmp/measure-red.err \
    || say "   (could not change a limit: $(head -2 .tmp/measure-red.err))"
measure after ${DB}_red .tmp/m.red1 >/dev/null
r=$(changed "$(cmp_ .tmp/m.after .tmp/m.red1)")
[ "${r:-0}" -gt 0 ] && pass "a. a plan limit changed (keep-everything off): $r user(s) counted as changed" || fail "a. a changed plan was NOT seen — the measurement proves nothing"
# b. a personal subscription row inside an organisation, read by main's code
psqlw -d postgres -c "DROP DATABASE IF EXISTS ${DB}_red" -c "CREATE DATABASE ${DB}_red TEMPLATE $DB" >/dev/null 2>&1
psqlw -d ${DB}_red -c "INSERT INTO core.subscriptions (tenant_id, plan_id, status, seats, started_at, user_id)
    SELECT s.tenant_id, (SELECT id FROM core.plans WHERE id <> s.plan_id ORDER BY id LIMIT 1), 'active', 1, now() + interval '1 day',
           (SELECT id FROM core.users u WHERE u.tenant_id = s.tenant_id LIMIT 1)
      FROM core.subscriptions s WHERE s.user_id IS NULL AND s.status <> 'cancelled' ORDER BY s.started_at DESC LIMIT 1" >/dev/null 2>.tmp/measure-red.err \
    || say "   (could not insert: $(head -2 .tmp/measure-red.err))"
measure before ${DB}_red .tmp/m.red2 >/dev/null
r=$(changed "$(cmp_ .tmp/m.before .tmp/m.red2)")
[ "${r:-0}" -gt 0 ] && pass "b. a personal row read WITHOUT the user_id filter (main's code): $r user(s) changed" || fail "b. the unfiltered reader was NOT seen"
measure after ${DB}_red .tmp/m.red3 >/dev/null
r=$(changed "$(cmp_ .tmp/m.after .tmp/m.red3)")
[ "$r" = 0 ] && pass "…the same row read WITH the filter (313's code): 0 changed" || fail "…313's code was moved by a personal row: $r"
psqlw -d postgres -c "DROP DATABASE IF EXISTS ${DB}_red" >/dev/null 2>&1

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
