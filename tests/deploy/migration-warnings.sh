#!/usr/bin/env bash
#
# deploy.sh's migration step shows a migration's WARNING lines - on success as
# well as on failure - and nothing quieter.
#
# WHY THIS EXISTS. Mr. Singh, 30 Sept 2026, reviewing PR 330: that migration
# deletes orphaned calendar.reminder_sends rows and says how many with RAISE
# WARNING - but deploy.sh printed a migration's output only when it FAILED, so
# on a successful deploy the count went nowhere. Rule 12: a step that did
# something unusual says so in the place people read. Printing everything
# would add a hundred files of NOTICE to every deploy and nobody would read
# it, so: WARNING lines only.
#
# HOW. The loop is CUT OUT OF deploy.sh ITSELF, between `schema_failed=0` and
# its `done`, and run as it is - not a copy that could drift. $COMPOSE is a
# stand-in that runs psql against this test's own throwaway database (house
# rule 13), and it refuses to run at all if deploy.sh's compose call ever
# changes shape, so the loop can never reach another database.
#
#   1. three probe migrations: one NOTICE (must NOT be shown), one WARNING on
#      success (must be shown), one WARNING then an error (shown, and FAIL)
#   2. every real migration, re-applied over a built database exactly as a
#      deploy re-applies them: which WARNING lines would a deploy show today?
#
# Usage: bash tests/deploy/migration-warnings.sh      Exit: 0 all passed, 1 not.
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY="$HERE/infra/scripts/deploy.sh"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
step() { printf "\n>> %s\n" "$1"; }
same() {
    if [ -z "$2" ] || [ -z "$3" ]; then fail "$1 - nothing to compare (got [$2], wanted [$3])"
    elif [ "$2" = "$3" ]; then pass "$1  [got $2]"
    else fail "$1 - got [$2], wanted [$3]"; fi
}

LOOP="$(awk '/^schema_failed=0$/{f=1} f{print} f&&/^done$/{exit}' "$DEPLOY")"
if [ -z "$LOOP" ] || ! printf '%s\n' "$LOOP" | grep -q '^done$'; then
    echo "  could not find the migration loop in deploy.sh (schema_failed=0 ... done) - the check did NOT run"; exit 2
fi

SCRATCH="$HERE/.tmp/migration-warnings-$$"; mkdir -p "$SCRATCH/probe/local/postgres/init"
trap 'rm -rf "$SCRATCH"' EXIT          # before tdb_create: it chains this after the drop
# shellcheck source=../lib/throwaway-db.sh
source "$HERE/tests/lib/throwaway-db.sh"
tdb_create deploy_warnings || exit 2

# The stand-in for $COMPOSE. deploy.sh calls:
#   $COMPOSE exec -T postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1 < file
# Anything else is refused, loudly: the stand-in must never guess a database.
cat > "$SCRATCH/compose-stub.sh" <<'STUB'
#!/usr/bin/env bash
want="exec -T postgres psql -U postgres -d tatvaos_mail -v ON_ERROR_STOP=1"
if [ "$*" != "$want" ]; then echo "STUB REFUSED: deploy.sh's compose call changed shape: [$*]"; exit 97; fi
if command -v wsl >/dev/null 2>&1; then exec wsl -u postgres -e psql -d "$TDB_NAME" -v ON_ERROR_STOP=1
else exec psql -d "$TDB_NAME" -v ON_ERROR_STOP=1; fi
STUB
export TDB_NAME

# run_loop DIR -> what deploy.sh would print for the migrations in DIR
run_loop() (
    cd "$1" || exit 2
    COMPOSE="bash $SCRATCH/compose-stub.sh"
    ok()   { printf '   [ ok ] %s\n' "$1"; }
    bad()  { printf '   [FAIL] %s\n' "$1"; }
    note() { printf '   %s\n' "$1"; }
    eval "$LOOP"
)

printf "\n  deploy.sh migration warnings\n  tree under test: %s\n  database: %s\n" "$(git -C "$HERE" rev-parse HEAD 2>/dev/null)" "$TDB_NAME"

step "1. Three probe migrations through deploy.sh's own loop"
P="$SCRATCH/probe/local/postgres/init"
printf "DO \$\$ BEGIN RAISE NOTICE 'tdb-probe-notice'; END \$\$;\n" > "$P/001-quiet.sql"
printf "DO \$\$ BEGIN RAISE WARNING 'tdb-probe-warning-on-success'; END \$\$;\n" > "$P/002-warns.sql"
printf "DO \$\$ BEGIN RAISE WARNING 'tdb-probe-warning-before-failing'; END \$\$;\nSELECT 1/0;\n" > "$P/003-fails.sql"
out="$(run_loop "$SCRATCH/probe" 2>&1)"
printf '%s\n' "$out" | sed 's/^/        | /'
same "the stand-in was not refused (deploy.sh's call has the shape it checks for)" "$(printf '%s\n' "$out" | grep -c "STUB REFUSED")" "0"
same "the quiet migration passes"                        "$(printf '%s\n' "$out" | grep -c '\[ ok \] 001-quiet.sql')" "1"
same "...and its NOTICE is NOT shown"                    "$(printf '%s\n' "$out" | grep -c 'tdb-probe-notice')" "0"
same "the warning migration passes"                      "$(printf '%s\n' "$out" | grep -c '\[ ok \] 002-warns.sql')" "1"
same "...and its WARNING IS shown, on success"           "$(printf '%s\n' "$out" | grep -c 'WARNING:.*tdb-probe-warning-on-success')" "1"
same "the failing migration is reported as failed"       "$(printf '%s\n' "$out" | grep -c '\[FAIL\] 003-fails.sql')" "1"
same "...and its WARNING is shown too"                   "$(printf '%s\n' "$out" | grep -c 'tdb-probe-warning-before-failing' | awk '{print ($1 >= 1) ? "yes" : "no"}')" "yes"

step "2. Every real migration, re-applied as a deploy re-applies them"
real="$(run_loop "$HERE" 2>&1)"
same "no real migration failed on the re-run" "$(printf '%s\n' "$real" | grep -c '\[FAIL\]')" "0"
warns="$(printf '%s\n' "$real" | grep -E '^ +(psql:[^ ]+ )?WARNING:' || true)"
n=$(printf '%s' "$warns" | grep -c . || true)
printf "        WARNING lines a deploy would show today: %s\n" "$n"
[ -n "$warns" ] && printf '%s\n' "$warns" | sed 's/^ */          /'
same "a normal deploy shows no WARNING (nothing unusual happened)" "$n" "0"

printf "\n  -----------------------------------------------\n"
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
