#!/usr/bin/env bash
# =============================================================================
#  verify-migrations.sh — can this schema be built from nothing, twice?
# =============================================================================
#
#  WHAT THIS PROVES, AND WHY IT IS TWO THINGS
#
#  Every file in local/postgres/init/ re-runs on EVERY deploy, in filename
#  order. That gives the directory two properties it must have and which
#  nothing was checking:
#
#    1. IT BUILDS FROM NOTHING. A file must not depend on an object created by
#       a file that sorts after it. Production never tests this — production
#       already has every object, so a file in the wrong place applies
#       cleanly there and fails only for a NEW customer, a rebuild, or a
#       fresh environment.
#
#    2. IT IS IDEMPOTENT. Running the whole directory a second time must
#       change nothing and fail nothing.
#
#  Each property has already cost this project real time:
#
#    · 19 August. 20260816 created space.consume_public_link returning four
#      columns; 20260819 dropped it and recreated it with six. First deploy:
#      fine. SECOND deploy: "cannot change return type of existing function".
#      Every deploy from the 19th onward was blocked, and the bug was
#      invisible until somebody tried. That is property 2.
#
#    · 23 August. Two migrations named 20260822 referenced connect.meetings,
#      created by 20260901-connect.sql — so they sorted BEFORE their own
#      dependencies. They applied cleanly to production, where those tables
#      already existed, and would have failed on any fresh database. Found by
#      reading a directory listing, not by anything breaking. That is
#      property 1.
#
#  Both were ordering assumptions that held until they didn't. Neither would
#  have survived this script.
#
#  ─────────────────────────────────────────────────────────────────────────
#  IT NEVER TOUCHES A REAL DATABASE
#
#  Everything runs against a throwaway database that is created at the start
#  and dropped at the end. The name is fixed and unmistakable, and the script
#  refuses to run if anything about that looks wrong — this is the only
#  safeguard between "verify the schema" and "rebuild production's".
#
#  USAGE — on the server, from the repo root:
#
#      bash infra/scripts/verify-migrations.sh
#
#  Takes under a minute. Worth running before any deploy that adds or renames
#  a migration, and worth running when one has been renamed by somebody else.
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

# A name nothing else could plausibly be called, checked below before any
# DROP is issued. The drop is the only destructive thing here and it must be
# impossible to point at anything real.
SCRATCH="scratch_migration_verify"

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
info() { printf '        · %s\n' "$1"; }
head2(){ printf '\n  %s\n  %s\n' "$1" "$(printf '%.0s─' $(seq 1 62))"; }

FAILED=0

# ---- 0. Guards ---------------------------------------------------------------
if [[ "$SCRATCH" != scratch_* ]]; then
    echo "REFUSING: the scratch database name must begin with scratch_." >&2
    echo "This script DROPs it. That prefix is what makes it impossible to" >&2
    echo "point at a real database, however this file is edited." >&2
    exit 2
fi

head2 "locating postgres"
PG=$(docker ps --format '{{.Names}}' | grep postgres | head -1)
[[ -n "$PG" ]] && ok "container: $PG" || { bad "no postgres container running"; exit 1; }

FILES=$(ls local/postgres/init/*.sql 2>/dev/null | sort)
COUNT=$(printf '%s\n' "$FILES" | grep -c . || true)
[[ "$COUNT" -gt 0 ]] && ok "$COUNT migration files" || { bad "no migrations found"; exit 1; }

# ---- 1. Build the scratch database ------------------------------------------
head2 "creating $SCRATCH"
docker exec "$PG" psql -U postgres -q -c "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1
if docker exec "$PG" psql -U postgres -q -c "CREATE DATABASE $SCRATCH;" >/dev/null 2>&1; then
    ok "empty database created"
else
    bad "could not create the scratch database"
    exit 1
fi

# Dropped however this exits, including on Ctrl-C. A scratch database left
# behind is a thing somebody later has to wonder about.
cleanup() {
    docker exec "$PG" psql -U postgres -q -c "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1
}
trap cleanup EXIT

run_pass() {
    local label="$1" failures=0
    head2 "$label"
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        local name
        name=$(basename "$f")
        if docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -q -U postgres \
                -d "$SCRATCH" < "$f" >/tmp/mig.err 2>&1; then
            printf '  \033[32mok\033[0m    %s\n' "$name"
        else
            printf '  \033[31mFAIL\033[0m  %s\n' "$name"
            # The first ERROR line only. psql is verbose and the useful
            # sentence is always near the top.
            grep -m1 -i '^ERROR' /tmp/mig.err | sed 's/^/          /'
            failures=$((failures + 1))
        fi
    done <<< "$FILES"
    return $failures
}

# ---- 2. From nothing --------------------------------------------------------
run_pass "PASS 1 — building from an empty database"
FIRST=$?
if [[ "$FIRST" -gt 0 ]]; then
    FAILED=1
    info "$FIRST file(s) could not apply to an empty database."
    info "Almost always ORDERING: a file depends on an object created by a file"
    info "that sorts AFTER it. Production hides this because the object already"
    info "exists there. Rename so the dependency sorts first."
fi

# ---- 3. And again -----------------------------------------------------------
run_pass "PASS 2 — re-running everything against the same database"
SECOND=$?
if [[ "$SECOND" -gt 0 ]]; then
    FAILED=1
    info "$SECOND file(s) are not idempotent."
    info "Every file here re-runs on every deploy, so this is a BLOCKED DEPLOY,"
    info "not a warning. Usually an earlier file fighting a later one's version"
    info "of the same object — see the header of 20260816-space-public-links."
fi

# ---- 4. Verdict -------------------------------------------------------------
head2 "verdict"
if [[ "$FAILED" -eq 0 ]]; then
    ok "$COUNT migrations build from nothing AND re-run cleanly"
    info "both properties the deploy depends on, checked rather than assumed"
    exit 0
fi

bad "the schema directory is not safe to deploy"
info "pass 1 failures break NEW installs; pass 2 failures break EVERY deploy"
exit 1
