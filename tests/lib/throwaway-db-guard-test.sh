#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/lib/throwaway-db-guard-test.sh - a lost throwaway database name must
# stop a test run, never send it to the shared one.
#
# WHY. 2 Oct 2026, testing PR 380: `tdb_create sender_logins | tail -1` ran
# tdb_create in the pipe's subshell. Its EXIT trap dropped the new database
# the moment the pipe finished, TDB_NAME was never set in the caller, and the
# isolation suite, given PGDATABASE=$TDB_NAME (empty), fell back to its
# default: the SHARED tatvaos_mail. Rule 13 broken without a word. The suite
# cleaned up after itself, so nothing was left behind; luck, not design.
# Mr. Singh, 2 Oct: "Add a guard ... Then it can't happen silently again."
#
#   1. tdb_create inside a pipe refuses, and creates nothing
#   2. tdb_create inside $(...) refuses, and creates nothing
#   3. tdb_assert refuses an empty TDB_NAME and the shared tatvaos_mail
#   4. the isolation suite with PGDATABASE set but EMPTY refuses before any
#      SQL (a fake psql records every call; no database is ever reached)
#   5. ...and with PGDATABASE unset it still defaults to tatvaos_mail, as CI
#      relies on (its service database has that name)
#
# Usage: bash tests/lib/throwaway-db-guard-test.sh   (cases 1-2 reach WSL's
# Postgres only on a tree WITHOUT the guard, as the red run.)
# ---------------------------------------------------------------------------
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); printf "  ok    %s\n" "$1"; }
fail() { FAILED=$((FAILED+1)); printf "  FAIL  %s\n" "$1"; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 - [$3] missing"; fi; }
hasnt() { if printf '%s' "$2" | grep -qF -- "$3"; then fail "$1 - [$3] present"; else pass "$1"; fi; }
same()  { if [ -n "$2" ] && [ "$2" = "$3" ]; then pass "$1  [got $2]"; else fail "$1 - got [$2], wanted [$3]"; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== 1. tdb_create inside a pipe"
out=$(bash -c "source '$HERE/tests/lib/throwaway-db.sh'; tdb_create guardpipe | cat" 2>&1)
has   "it refuses, and says why"            "$out" "inside a pipe or \$(...)"
hasnt "and creates no database"             "$out" "tdb: creating"

echo "== 2. tdb_create inside \$(...)"
out=$(bash -c "source '$HERE/tests/lib/throwaway-db.sh'; x=\$(tdb_create guardsub 2>&1); printf '%s' \"\$x\"" 2>&1)
has   "it refuses, and says why"            "$out" "inside a pipe or \$(...)"
hasnt "and creates no database"             "$out" "tdb: creating"

echo "== 3. tdb_assert"
rc_of() { bash -c "source '$HERE/tests/lib/throwaway-db.sh'; TDB_NAME='$1'; tdb_assert" >/dev/null 2>&1; echo $?; }
same  "an empty TDB_NAME is refused"        "$(rc_of '')" 2
same  "the shared tatvaos_mail is refused"  "$(rc_of tatvaos_mail)" 2
same  "a throwaway name is accepted"        "$(rc_of tatvaos_test_x_1_abc)" 0

echo "== 4. the isolation suite with PGDATABASE set but empty"
mkdir -p "$T/bin"
cat > "$T/bin/psql" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_PSQL_CALLS"; exit 1
EOF
chmod +x "$T/bin/psql"
export FAKE_PSQL_CALLS="$T/psql.calls"; : > "$FAKE_PSQL_CALLS"
out=$(PATH="$T/bin:$PATH" TATVAOS_PSQL_MODE=direct PGDATABASE= timeout 120 bash "$HERE/tests/isolation/test-isolation.sh" 2>&1); rc=$?
same  "it refuses (exit 2)"                 "$rc" 2
has   "and says why"                        "$out" "PGDATABASE is set but empty"
same  "no SQL was sent anywhere"            "$(wc -l < "$FAKE_PSQL_CALLS" | tr -d ' ')" 0

echo "== 5. ...and unset still means tatvaos_mail (CI's database)"
: > "$FAKE_PSQL_CALLS"
(unset PGDATABASE; PATH="$T/bin:$PATH" TATVAOS_PSQL_MODE=direct timeout 120 bash "$HERE/tests/isolation/test-isolation.sh" >/dev/null 2>&1)
has   "the suite still reaches for tatvaos_mail" "$(head -1 "$FAKE_PSQL_CALLS")" "-d tatvaos_mail"

printf '\n  -----------------------------------------------\n'
if [ "$FAILED" -eq 0 ]; then printf "  PASS  %d checks\n\n" "$PASSED"; exit 0
else printf "  FAIL  %d of %d checks\n\n" "$FAILED" $((PASSED+FAILED)); exit 1; fi
