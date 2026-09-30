# shellcheck shell=bash
# ---------------------------------------------------------------------------
# tests/lib/throwaway-db.sh - every test run gets its own database.
#
# WHY. Mr. Singh, 29 Sept 2026, to every session: "test against your own
# database". That day the PR 329 test failed in the SHARED local database for
# a reason that had nothing to do with PR 329: PR 330, still a draft, had left
# its row-level-security rule on calendar.reminder_sends there, and 329's code
# could not satisfy it. The session put the table back for its runs and
# restored 330's settings, which worked - but a shared test database means one
# session's unmerged change can make another's test fail, or PASS FOR THE
# WRONG REASON, and two sessions resetting the same table at once corrupt each
# other's results with nobody noticing. House rule 13.
#
# WHAT IT DOES, for a suite that sources it and calls tdb_create LABEL:
#   1. drops any test database a killed run left behind (older than 6 hours)
#   2. creates tatvaos_test_<label>_<time>_<random>
#   3. applies EVERY file in local/postgres/init/, in filename order, with
#      ON_ERROR_STOP, into the empty database - seeds included, as the local
#      stack does
#   4. applies them ALL A SECOND TIME: every file re-runs on every deploy, so
#      this is the migration re-run check, for free
#   5. drops the database on exit, pass or fail (an EXIT trap)
#
# and exports, for the suite:
#   TDB_NAME       the database's name - a PR's evidence names it
#   TDB_HOST       where the API should connect
#   TDB_CONN       ConnectionStrings__Postgres for the API, as tatvaos_app
#   TATVAOS_PSQL   "<psql as a superuser> -d <this database> -Atc", the shape
#                  the suites already use for their PG() helper
#
# ROLES ARE THE ONE THING A DATABASE CANNOT KEEP TO ITSELF. tatvaos_app and
# tatvaos_mailedge belong to the whole Postgres server. 0000-core-schema.sql
# creates them only if missing, and 0003-role-passwords.sql changes their
# passwords only when APP_DB_PASSWORD or MAILEDGE_DB_PASSWORD is set - so both
# are removed from the environment psql runs in, and every role on the server
# is fingerprinted (a hash of pg_authid, never a password) before and after.
# A migration that changes a server-wide role stops the run, naming it as the
# cause, instead of quietly changing everybody's database.
#
# WHERE POSTGRES IS. On the laptop: the WSL cluster, reached as the postgres
# user (`wsl -u postgres`), the same one the suites already use - only the
# DATABASE is new. Anywhere else: `psql` on PATH with the usual PG* variables
# (PGHOST, PGPORT, PGUSER as a superuser, PGPASSWORD), and TDB_HOST for what
# the API should connect to (default: PGHOST, else localhost).
#
# USE (a suite):
#   source "$HERE/tests/lib/throwaway-db.sh"
#   tdb_create mfa || exit 2           # exit 2 = the check did NOT run
#   ... PG() { $TATVAOS_PSQL "$1" ...; } and the API with $TDB_CONN ...
# If the suite sets its own EXIT trap, set it BEFORE tdb_create: the helper
# chains whatever trap is already there and runs it after the drop. A trap set
# after tdb_create replaces the drop; call tdb_drop from it instead.
#
# THE SHARED DATABASE (tatvaos_mail) is for trying things in a browser only,
# never for proof. This file never writes to it.
# ---------------------------------------------------------------------------

TDB_NAME=""; TDB_HOST=""; TDB_CONN=""; TDB__KEEPALIVE=""; TDB__MODE=""

# Everything below runs as a superuser, in a bash on the machine Postgres is
# on. The script arrives on stdin, so no path in it is rewritten by Git Bash.
tdb__admin_bash() {
    if [ "$TDB__MODE" = wsl ]; then wsl -u postgres -e bash -s
    else bash -s; fi
}

# The init folder as that bash sees it: /c/Users/... is /mnt/c/Users/... in WSL.
tdb__init_dir() {
    local root="$1"
    if [ "$TDB__MODE" = wsl ]; then
        printf '%s' "$root/local/postgres/init" | sed -E 's#^/([a-zA-Z])/#/mnt/\L\1/#'
    else printf '%s' "$root/local/postgres/init"; fi
}

tdb_create() {
    local label root init stamp rand
    label="$(printf '%s' "${1:-suite}" | tr 'A-Z-' 'a-z_' | tr -cd 'a-z0-9_' | cut -c1-20)"
    root="${TATVAOS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
    stamp="$(date +%s)"; rand="$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')"
    TDB_NAME="tatvaos_test_${label}_${stamp}_${rand}"

    if command -v wsl >/dev/null 2>&1; then
        TDB__MODE=wsl
        # WSL shuts its VM down between calls when nothing is running in it,
        # and Postgres with it. Keep it up for the length of the run.
        wsl -e sleep 3600 >/dev/null 2>&1 & TDB__KEEPALIVE=$!
        sleep 2
        wsl -u root -e bash -c "service postgresql status >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1"
        TDB_HOST="${TDB_HOST:-$(wsl hostname -I | tr -d '\r' | awk '{print $1}')}"
        TATVAOS_PSQL="wsl -u postgres -e psql -d $TDB_NAME -Atc"
    else
        TDB__MODE=local
        command -v psql >/dev/null 2>&1 || { echo "  tdb: no wsl and no psql on PATH - the check cannot run." >&2; return 2; }
        TDB_HOST="${TDB_HOST:-${PGHOST:-localhost}}"
        TATVAOS_PSQL="psql -d $TDB_NAME -Atc"
    fi
    case "$TDB_HOST" in
        *[!0-9a-zA-Z.:_-]*|"") echo "  tdb: '$TDB_HOST' is not a host address - the check cannot run." >&2; return 2 ;;
    esac
    init="$(tdb__init_dir "$root")"

    # The drop is registered BEFORE the database exists, so a failure half-way
    # through creating it still cleans up. Any trap the suite already set runs
    # after it.
    local prev; prev="$(trap -p EXIT | sed -E "s/^trap -- '(.*)' EXIT$/\1/")"
    # shellcheck disable=SC2064
    trap "tdb_drop; ${prev}" EXIT

    printf "  tdb: creating %s (Postgres: %s), applying %s\n" "$TDB_NAME" "$TDB__MODE" "$root/local/postgres/init" >&2
    local out rc
    out="$(tdb__admin_bash <<EOF
set -u
unset APP_DB_PASSWORD MAILEDGE_DB_PASSWORD
cd /tmp
fp() { psql -d postgres -Atq -c "SELECT md5(string_agg(concat_ws('|', rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, coalesce(rolpassword, ''), coalesce(rolvaliduntil::text, '')), ',' ORDER BY rolname)) FROM pg_authid"; }

# 1. A test database left by a killed run: older than 6 hours, nobody on it.
for d in \$(psql -d postgres -Atq -c "SELECT d.datname FROM pg_database d WHERE d.datname ~ '^tatvaos_test_[a-z0-9_]+\$' AND coalesce(split_part(shobj_description(d.oid, 'pg_database'), ' ', 2), '0')::bigint < extract(epoch FROM now()) - 21600 AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)"); do
    psql -d postgres -q -c "DROP DATABASE IF EXISTS \"\$d\"" && echo "  tdb: dropped a stale test database left by an earlier run: \$d"
done

# 2. Create it, marked with its creation time for step 1 of the next run.
psql -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TDB_NAME" || { echo "TDB_FAIL could not create the database"; exit 1; }
psql -d postgres -q -c "COMMENT ON DATABASE $TDB_NAME IS 'tatvaos-test $stamp'"

before=\$(fp)
[ -d "$init" ] || { echo "TDB_FAIL no init folder at $init"; exit 1; }
n=0
for pass in 1 2; do
    for f in "$init"/*.sql; do
        # ONE apply per file per pass; its stderr is kept for the message.
        # psql exits 3 on the first error under ON_ERROR_STOP.
        if ! err=\$(psql -d $TDB_NAME -v ON_ERROR_STOP=1 -q -X < "\$f" 2>&1 >/dev/null); then
            echo "TDB_FAIL pass \$pass: \$(basename "\$f") failed: \$(printf '%s\n' "\$err" | grep -v -E 'NOTICE:' | grep -m3 . | tr '\n' ' ')"
            exit 1
        fi
        [ \$pass = 1 ] && n=\$((n+1))
    done
done
after=\$(fp)
[ "\$before" = "\$after" ] || { echo "TDB_FAIL a migration changed a SERVER-WIDE role (pg_authid differs before/after) - every database on this server shares roles"; exit 1; }
echo "TDB_OK \$n"
EOF
)"; rc=$?
    printf '%s\n' "$out" | grep -E "^  tdb:" >&2
    if ! printf '%s\n' "$out" | grep -q "^TDB_OK "; then
        printf "  tdb: FAILED - %s\n" "$(printf '%s\n' "$out" | grep -m1 "^TDB_FAIL" | sed 's/^TDB_FAIL //')" >&2
        [ -n "$(printf '%s\n' "$out" | grep -m1 "^TDB_FAIL")" ] || printf "  tdb: (no verdict from Postgres, exit %s)\n" "$rc" >&2
        return 2
    fi
    local files; files="$(printf '%s\n' "$out" | sed -n 's/^TDB_OK //p')"
    TDB_CONN="Host=$TDB_HOST;Port=5432;Database=$TDB_NAME;Username=tatvaos_app;Password=dev_app_pw;Pooling=true"
    export TDB_NAME TDB_HOST TDB_CONN TATVAOS_PSQL
    printf "  tdb: %s ready - %s migration files applied twice (the re-run check), no server-wide role changed\n" "$TDB_NAME" "$files" >&2
    return 0
}

# Drop this run's database. Safe to call more than once, and it refuses any
# name that is not a test database - the shared one can never be its target.
tdb_drop() {
    local name="$TDB_NAME"
    [ -n "$name" ] || { tdb__stop_keepalive; return 0; }
    if ! printf '%s' "$name" | grep -qE '^tatvaos_test_[a-z0-9_]+$'; then
        echo "  tdb: refusing to drop '$name' - not a test database" >&2; return 1
    fi
    tdb__admin_bash <<EOF >/dev/null 2>&1
psql -d postgres -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$name' AND pid <> pg_backend_pid()"
psql -d postgres -q -c "DROP DATABASE IF EXISTS $name"
EOF
    local left
    left="$(tdb__admin_bash <<EOF 2>/dev/null | tr -d '\r'
psql -d postgres -Atq -c "SELECT count(*) FROM pg_database WHERE datname = '$name'"
EOF
)"
    if [ "$left" = "0" ]; then printf "  tdb: dropped %s\n" "$name" >&2
    else printf "  tdb: COULD NOT DROP %s (still there: [%s]) - the next run's sweep removes it after 6 hours\n" "$name" "$left" >&2; fi
    TDB_NAME=""
    tdb__stop_keepalive
}

tdb__stop_keepalive() {
    [ -n "$TDB__KEEPALIVE" ] && kill "$TDB__KEEPALIVE" >/dev/null 2>&1
    TDB__KEEPALIVE=""
}
